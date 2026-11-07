"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CardTitle } from "@/components/card-title";
import { Callout } from "@/components/ui/callout";
import { ExternalLink } from "@/components/ui/external-link";
import { callJson } from "@/lib/client-api";
import { clause, plural } from "@/lib/format";
import type { LogLine } from "@/lib/pages/deployments";
import type { VercelLogPage, VercelRuntimeLine } from "@/lib/pages/vercel-logs";
import { vercelLogsHref } from "./vercel-links";
import { LogViewer } from "./log-viewer";

/*
 * A Vercel deployment's runtime logs in the deployment log viewer: what a short read brought, then the
 * live stream. Vercel's API only streams new lines and has no way to page back, and that is said on
 * the card, with a link to Vercel's own Logs tab for anything older.
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
  const [page, setPage] = useState<Pick<VercelLogPage, "retention"> | null>(null);
  const [follow, setFollow] = useState(true);
  const [attempt, setAttempt] = useState(0);
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
    let timer: ReturnType<typeof setInterval> | undefined;
    let misses = 0;
    let buffer: VercelRuntimeLine[] = [];
    const flush = () => {
      if (!buffer.length) return;
      add(buffer);
      buffer = [];
    };
    const close = () => {
      es?.close();
      clearInterval(timer);
      flush();
    };
    // Reset for this run: a remount or a reconnect starts clean, in the same order every time.
    seen.current = new Set();
    seq.current = 0;
    void (async () => {
      setPhase("loading");
      setError(null);
      setLines([]);
      const r = await callJson<{ data: VercelLogPage | null; error?: string }>(`${base}${query}`, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      if (!r.ok || !r.data?.data) {
        setError(r.ok ? (r.data?.error ?? "The API did not answer") : r.error);
        setPhase("failed");
        return;
      }
      const data = r.data.data;
      setPage({ retention: data.retention });
      add(data.lines);
      if (!data.deployment) {
        setPhase("none");
        return;
      }
      setPhase("live");
      es = new EventSource(`${base}/stream${query}`);
      timer = setInterval(flush, FLUSH_MS);
      es.addEventListener("open", () => {
        misses = 0;
      });
      es.addEventListener("line", (e) => {
        try {
          buffer.push(JSON.parse((e as MessageEvent<string>).data) as VercelRuntimeLine);
        } catch {
          /* A line that does not parse is dropped; the next one is not affected. */
        }
      });
      es.addEventListener("end", (e) => {
        let reason = "stopped";
        try {
          reason = (JSON.parse((e as MessageEvent<string>).data) as { reason?: string }).reason ?? reason;
        } catch {
          /* The fixed wording below is enough. */
        }
        close();
        setError(ENDED[reason] ?? ENDED.stopped!);
        setPhase("ended");
      });
      // The browser reconnects by itself; only when that keeps failing does the card say so.
      es.onerror = () => {
        misses += 1;
        // An HTTP error on reconnect closes the stream for good, so no second error ever comes.
        if (misses < 4 && es?.readyState !== EventSource.CLOSED) return;
        close();
        setError("The live stream could not reconnect.");
        setPhase("ended");
      };
    })();
    return () => {
      ctrl.abort();
      close();
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
        <span>Could not read the logs. {clause(error ?? "The API did not answer")}.</span>
        {retry}
      </>
    ) : phase === "none" ? (
      <span>Nothing to read yet: this app has no finished Vercel deployment.</span>
    ) : lines.length === 0 ? (
      <span>{live ? "Listening. Lines appear here as Vercel prints them." : "No lines arrived."}</span>
    ) : undefined;

  return (
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
  );
}
