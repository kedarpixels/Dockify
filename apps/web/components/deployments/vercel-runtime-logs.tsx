"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CardTitle } from "@/components/card-title";
import { Callout } from "@/components/ui/callout";
import { ExternalLink } from "@/components/ui/external-link";
import { Spacer } from "@/components/ui/rule";
import { callJson } from "@/lib/client-api";
import { plural } from "@/lib/format";
import type { DeploymentLogs, LogLine } from "@/lib/pages/deployments";
import type { VercelLogPage, VercelRuntimeLine } from "@/lib/pages/vercel-logs";
import { vercelLogsHref } from "./vercel-links";
import { LogViewer } from "./log-viewer";
import { NO_RUNTIME_LINES, readFailure, STREAM_LOST, wantsBuildLog } from "./vercel-log-state";

/*
 * A Vercel deployment's runtime logs in the deployment log viewer: what a short read brought, then the
 * live stream. Vercel's API only streams new lines and has no way to page back, and that is said on
 * the card, with a link to Vercel's own Logs tab for anything older.
 *
 * One open card holds at most one read and one stream at a time, and gives both back when it goes:
 * the read is aborted, the stream closed, and a hidden browser tab closes its stream until it shows
 * again, so tabs left open in the background never use up the per-user stream limit. On an app's Logs
 * tab with no runtime lines yet (a static site served from cache prints none), the card says so and
 * shows the latest deployment's build log, so the tab is never blank.
 */

/** The most lines a page keeps; the oldest go first, like a terminal's scrollback. */
const MAX_LINES = 5_000;
/** Lines are added in small batches, so a burst is one render instead of hundreds. */
const FLUSH_MS = 250;

type Phase = "loading" | "live" | "none" | "ended" | "failed";

const ENDED: Record<string, string> = {
  token: "Vercel refused the stored token. Reconnect Vercel in Settings, Integrations.",
  gone: "Vercel no longer has this deployment.",
  unauthorized: "Your session ended. Sign in again to keep reading.",
  max_duration: "The stream stops after an hour. Reconnect to keep reading.",
  stopped: "Vercel stopped sending and did not answer again. Reconnect to try once more.",
  refused: "Vercel refused to send these logs.",
};

const toLine = (l: VercelRuntimeLine, seq: number): LogLine => ({ seq, ts: l.ts, stream: l.stream, text: l.text });

type Build = { state: "loading" } | { state: "ready"; lines: LogLine[] } | { state: "failed"; error: string };

export function VercelRuntimeLogs({
  appId,
  deployment,
  inspectorUrl,
  name,
  sub,
}: {
  appId: string;
  /** A deployment of this app; absent reads what the app is serving now. */
  deployment?: string;
  inspectorUrl?: string | null;
  name: string;
  sub: string;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [page, setPage] = useState<Pick<VercelLogPage, "retention" | "deployment"> | null>(null);
  const [follow, setFollow] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [build, setBuild] = useState<Build | null>(null);
  const [buildFollow, setBuildFollow] = useState(false);
  const seen = useRef(new Set<string>());
  const seq = useRef(0);

  const add = useCallback((fresh: VercelRuntimeLine[]) => {
    const take: LogLine[] = [];
    for (const l of fresh) {
      if (seen.current.has(l.id)) continue;
      seen.current.add(l.id);
      take.push(toLine(l, ++seq.current));
    }
    if (take.length) setLines((ls) => [...ls, ...take].slice(-MAX_LINES));
  }, []);

  useEffect(() => {
    const query = deployment ? `?deployment=${encodeURIComponent(deployment)}` : "";
    const base = `/api/apps/${encodeURIComponent(appId)}/vercel/logs`;
    const ctrl = new AbortController();
    let es: EventSource | null = null;
    /** True while the card wants its stream: false once it ended for good or the card went. */
    let wanted = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let misses = 0;
    let buffer: VercelRuntimeLine[] = [];
    const flush = () => {
      if (!buffer.length) return;
      add(buffer);
      buffer = [];
    };
    /** Closes the stream now, which frees its slot on the server at once. */
    const shut = () => {
      es?.close();
      es = null;
      clearInterval(timer);
      timer = undefined;
      flush();
    };
    const giveUp = (message: string) => {
      wanted = false;
      shut();
      setError(message);
      setPhase("ended");
    };
    const open = () => {
      if (!wanted || es || ctrl.signal.aborted || document.hidden) return;
      misses = 0;
      const source = new EventSource(`${base}/stream${query}`);
      es = source;
      timer = setInterval(flush, FLUSH_MS);
      source.addEventListener("open", () => {
        misses = 0;
      });
      source.addEventListener("line", (e) => {
        try {
          buffer.push(JSON.parse((e as MessageEvent<string>).data) as VercelRuntimeLine);
        } catch {
          /* A line that does not parse is dropped; the next one is not affected. */
        }
      });
      source.addEventListener("end", (e) => {
        let reason = "stopped";
        try {
          reason = (JSON.parse((e as MessageEvent<string>).data) as { reason?: string }).reason ?? reason;
        } catch {
          /* The fixed wording below is enough. */
        }
        giveUp(ENDED[reason] ?? ENDED.stopped!);
      });
      // The browser reconnects by itself; only when that keeps failing does the card say so. An HTTP
      // refusal (a 429 among them) closes the stream for good, so no second error ever comes.
      source.onerror = () => {
        if (es !== source) return;
        misses += 1;
        if (misses < 4 && es?.readyState !== EventSource.CLOSED) return;
        giveUp(STREAM_LOST);
      };
    };
    // A hidden tab gives its stream back and takes a new one when it shows; lines already read stay.
    const onVisibility = () => {
      if (document.hidden) shut();
      else open();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Reset for this run: a remount or a reconnect starts clean, in the same order every time.
    seen.current = new Set();
    seq.current = 0;
    void (async () => {
      setPhase("loading");
      setError(null);
      setLines([]);
      setBuild(null);
      const r = await callJson<{ data: VercelLogPage | null; error?: string }>(`${base}${query}`, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      if (!r.ok || !r.data?.data) {
        setError(r.ok ? readFailure(502, r.data?.error) : readFailure(r.status, r.error));
        setPhase("failed");
        return;
      }
      const data = r.data.data;
      setPage({ retention: data.retention, deployment: data.deployment });
      add(data.lines);
      if (!data.deployment) {
        setPhase("none");
        return;
      }
      setPhase("live");
      wanted = true;
      open();
      // Nothing printed at runtime: the build log of the same deployment says what Vercel did.
      if (!wantsBuildLog({ named: !!deployment, runtimeLines: data.lines.length, deploymentId: data.deployment.id })) return;
      setBuild({ state: "loading" });
      const b = await callJson<{ data: DeploymentLogs | null; error?: string }>(`/api/deployments/${encodeURIComponent(data.deployment.id)}/logs?after=0`, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      if (b.ok && b.data?.data) setBuild({ state: "ready", lines: b.data.data.lines });
      else setBuild({ state: "failed", error: b.ok ? readFailure(502, b.data?.error) : readFailure(b.status, b.error) });
    })();
    return () => {
      wanted = false;
      ctrl.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      shut();
    };
  }, [appId, deployment, attempt, add]);

  const logs = vercelLogsHref(inspectorUrl ?? null);
  const live = phase === "live";
  const retry = (
    <button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
      {phase === "failed" ? "Try again" : "Reconnect"}
    </button>
  );
  const status =
    phase === "loading" ? (
      <span>Reading from Vercel</span>
    ) : phase === "failed" ? (
      <>
        <span>{error ?? readFailure(502, null)}</span>
        {retry}
      </>
    ) : phase === "none" ? (
      <span>Nothing to read yet: this app has no finished Vercel deployment.</span>
    ) : lines.length === 0 ? (
      <span>{NO_RUNTIME_LINES}</span>
    ) : undefined;

  const depId = page?.deployment?.id ?? null;
  const buildStatus =
    build?.state === "loading" ? (
      <span>Reading the build log</span>
    ) : build?.state === "failed" ? (
      <>
        <span>{build.error}</span>
        <button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </>
    ) : build?.state === "ready" && build.lines.length === 0 ? (
      <span>This deployment printed no build log lines.</span>
    ) : undefined;

  return (
    <>
      <section className="card reveal" aria-labelledby="dpd-runtime-title">
        <div className="card-hd">
          <CardTitle id="dpd-runtime-title" icon="logs" title="Runtime logs" sub={live ? `Streaming from Vercel, ${plural(lines.length, "line")}` : lines.length ? plural(lines.length, "line") : sub} />
        </div>
        {phase === "ended" && error ? (
          <div className="dpd-note">
            <Callout tone="warn" icon="alert" action={retry}>
              {error}
            </Callout>
          </div>
        ) : null}
        {page ? (
          <div className="dpd-note">
            <Callout icon="vercel">
              New lines only: Vercel’s API has no way to read older ones.
              {logs ? (
                <>
                  {" "}
                  <ExternalLink href={logs}>Open Vercel’s Logs tab</ExternalLink>.
                </>
              ) : null}{" "}
              {page.retention.note}
              {phase === "ended" && error?.includes("Settings") ? (
                <>
                  {" "}
                  <Link href="/settings?section=integrations">Open Settings</Link>.
                </>
              ) : null}
            </Callout>
          </div>
        ) : null}
        <LogViewer lines={lines} live={live} follow={follow} onFollow={setFollow} fileName={`${name}-runtime.txt`} status={status} />
      </section>
      {build && depId ? (
        <>
          <Spacer />
          <section className="card reveal" aria-labelledby="vrl-build-title">
            <div className="card-hd">
              <CardTitle
                id="vrl-build-title"
                icon="deploy"
                title="Build log"
                sub={
                  <>
                    Latest deployment on Vercel, <Link href={`/deployments/${encodeURIComponent(depId)}`}>open it</Link>
                  </>
                }
              />
            </div>
            <LogViewer lines={build.state === "ready" ? build.lines : []} live={false} follow={buildFollow} onFollow={setBuildFollow} fileName={`${name}-build.txt`} status={buildStatus} />
          </section>
        </>
      ) : null}
    </>
  );
}
