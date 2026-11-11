"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { AppIcon, ProjectIcon } from "@/components/icons/app-icon";
import { StatusIcon } from "@/components/overview/status-icon";
import { Topbar } from "@/components/shell/topbar";
import { Crumbs } from "@/components/ui/crumbs";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/dialog";
import { NoSource } from "@/components/ui/no-source";
import { NotFound } from "@/components/ui/not-found";
import { PendingButton } from "@/components/ui/pending";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { toast } from "@/components/ui/toast";
import { callJson } from "@/lib/client-api";
import { deployMessage } from "@/lib/deploy-source";
import { appLabel, DEPLOY_LABEL, DEPLOY_TONE, deriveNotices, IN_FLIGHT } from "@/lib/derive";
import { describe, errText } from "@/lib/feedback";
import { clause, duration, plural, timeAgo } from "@/lib/format";
import { commitHref, githubRepo } from "@/lib/git-links";
import { projectsShowingEnvironments } from "@/lib/environments";
import { useNow, useOverview } from "@/lib/hooks";
import type { ActionResult, DeploymentAction, DeploymentDetail, DeploymentLogs, DeploymentResult, LogLine } from "@/lib/pages/deployments";
import { STEP_LABEL } from "@/lib/pages/deployments-labels";
import type { OverviewResult } from "@/lib/types";
import { useCan } from "@/lib/viewer";
import { ACTION_TOAST, actionQuestion, deployWhere, sendDeploymentAction } from "./actions";
import { DeploymentMeta } from "./deployment-meta";
import { DeploymentSteps, secondsBetween } from "./deployment-steps";
import { lineLevel } from "./log-chunk";
import { LogViewer } from "./log-viewer";
import { hostOfUrl } from "./vercel-links";
import { VercelRuntimeLogs } from "./vercel-runtime-logs";

/** Appends the lines after the last one shown, so an overlapping answer never adds a line twice. */
function appendLines(shown: LogLine[], fresh: LogLine[]) {
  const last = shown.at(-1)?.seq ?? 0;
  const add = fresh.filter((l) => l.seq > last);
  return add.length ? [...shown, ...add] : shown;
}

function outcome(d: DeploymentDetail): string | null {
  if (d.status === "ready") return "Deployment ready";
  if (d.status === "cancelled") return "Deployment cancelled";
  if (d.status !== "failed") return null;
  const at = d.steps.find((s) => s.status === "failed");
  return at ? `Deployment failed at ${STEP_LABEL[at.id]}` : "Deployment failed";
}

function Missing({ id, initial, notices, now }: { id: string; initial: DeploymentResult; notices: ReturnType<typeof deriveNotices> | null; now: number }) {
  return (
    <>
      <Topbar trail={["Deployments", initial.notFound ? "Not found" : "Deployment"]} notices={notices} now={now} />
      <main className="page" id="main" tabIndex={-1}>
        {initial.notFound ? (
          <NotFound
            title="Deployment not found"
            body={`No deployment has the id ${id}. It may have been pruned by log retention.`}
            actions={
              <Link href="/deployments" className="btn btn-primary">
                <Icon name="arrowLeft" />
                Back to deployments
              </Link>
            }
          />
        ) : (
          <>
            <Crumbs back current={false} items={[{ label: "Deployments", href: "/deployments" }]} />
            <SectionHead level={1} title="Deployment" lead={id} />
            <Rule />
            <NoSource icon="deploy" error={initial.source === "none" ? undefined : (initial.error ?? "The API did not answer")} />
          </>
        )}
        <Spacer end />
      </main>
    </>
  );
}

export function DeploymentView({ id, initial, overview }: { id: string; initial: DeploymentResult; overview: OverviewResult }) {
  const router = useRouter();
  const can = useCan();
  const { result: ov } = useOverview(overview);
  const now = useNow(1000, initial.fetchedAt);
  const notices = useMemo(() => (ov.data ? deriveNotices(ov.data, now) : null), [ov.data, now]);

  const [d, setD] = useState<DeploymentDetail | null>(initial.data);
  const [lines, setLines] = useState<LogLine[]>(initial.logs?.lines ?? []);
  const [done, setDone] = useState(initial.logs?.done ?? true);
  const [logError, setLogError] = useState(initial.data && !initial.logs ? (initial.error ?? "The API did not answer") : undefined);
  const [follow, setFollow] = useState(!!initial.data && IN_FLIGHT.includes(initial.data.status));
  const [pending, setPending] = useState<DeploymentAction | null>(null);
  const busy = pending !== null;
  const [ask, setAsk] = useState<DeploymentAction | null>(null);
  const tail = useRef<LogLine[]>(initial.previewTail ?? []);
  const preview = initial.source === "preview";
  const live = !!d && IN_FLIGHT.includes(d.status) && !done;
  // Error lines, counted once per append, not on every clock tick. Stderr alone is not an error:
  // BuildKit prints its normal progress there.
  const errors = useMemo(() => lines.filter((l) => lineLevel(l) === "error").length, [lines]);

  useEffect(() => {
    if (!preview || !live) return;
    const t = setInterval(() => {
      if (!tail.current.length) return;
      const n = 2 + Math.floor(Math.random() * 4);
      const next = tail.current.splice(0, n).map((l) => ({ ...l, ts: new Date().toISOString() }));
      setLines((ls) => [...ls, ...next]);
    }, 2000);
    return () => clearInterval(t);
  }, [preview, live]);

  // Keyed on the log, not the status: a build can finish before its last lines are read. A hidden tab
  // stops asking. While Vercel's own stream holds, it replaces this tail (below).
  const [streamLost, setStreamLost] = useState(false);
  const streaming = !preview && !!d?.external?.id && !done && !streamLost;
  const tailing = !preview && !!d && !done && !streaming;
  const lastSeq = useEffectEvent(() => lines.at(-1)?.seq ?? 0);
  useEffect(() => {
    if (!tailing) return;
    let alive = true;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tick = 0;
    const base = `/api/deployments/${encodeURIComponent(id)}`;
    const refresh = async () => {
      const r = await callJson<DeploymentResult>(base);
      if (!r.ok || !r.data?.data) return false;
      if (alive) setD(r.data.data);
      return true;
    };
    const poll = async () => {
      timer = undefined;
      if (!alive || running || document.hidden) return;
      running = true;
      try {
        // A missed tick (offline, a timeout) is simply retried by the next one.
        const r = await callJson<{ data: DeploymentLogs | null }>(`${base}/logs?after=${lastSeq()}`);
        if (alive && r.ok && r.data?.data) {
          const fresh = r.data.data.lines;
          if (fresh.length) setLines((ls) => appendLines(ls, fresh));
          tick += 1;
          if (r.data.data.done) {
            // A failed refresh keeps the tail running, so the next tick tries it again.
            if ((await refresh()) && alive) {
              setDone(true);
              setFollow(false);
            }
          } else if (tick % 3 === 0) await refresh();
        }
      } finally {
        running = false;
      }
      if (alive && !document.hidden) timer = setTimeout(() => void poll(), 2000);
    };
    const wake = () => {
      if (!document.hidden && timer === undefined) void poll();
    };
    timer = setTimeout(() => void poll(), 2000);
    document.addEventListener("visibilitychange", wake);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [id, tailing]);

  // The status comes from the mirror, not this stream, so it is read every few seconds. If the stream
  // ends early or cannot reconnect, the tail above takes over from the last line.
  useEffect(() => {
    if (!streaming) return;
    const base = `/api/deployments/${encodeURIComponent(id)}`;
    const es = new EventSource(`${base}/logs/stream?after=${lastSeq()}`);
    let buffer: LogLine[] = [];
    let misses = 0;
    let finished = false;
    const flush = () => {
      if (!buffer.length) return;
      const fresh = buffer;
      buffer = [];
      setLines((ls) => appendLines(ls, fresh));
    };
    const refresh = async () => {
      const r = await callJson<DeploymentResult>(base);
      if (r.ok && r.data?.data && !finished) setD(r.data.data);
    };
    const batch = setInterval(flush, 250);
    const status = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 6_000);
    const stop = () => {
      finished = true;
      es.close();
      clearInterval(batch);
      clearInterval(status);
      flush();
    };
    es.addEventListener("open", () => {
      misses = 0;
    });
    es.addEventListener("line", (e) => {
      try {
        buffer.push(JSON.parse((e as MessageEvent<string>).data) as LogLine);
      } catch {
        /* A line that does not parse is dropped; the next one is not affected. */
      }
    });
    es.addEventListener("done", (e) => {
      stop();
      const settled = !/"syncing"/.test((e as MessageEvent<string>).data);
      void callJson<DeploymentResult>(base).then((r) => {
        if (r.ok && r.data?.data) setD(r.data.data);
        // Vercel has finished and the mirror has not read it yet, or that read failed and the page
        // still says Building: the tail waits for the status.
        if (settled && r.ok) {
          setDone(true);
          setFollow(false);
        } else setStreamLost(true);
      });
    });
    es.addEventListener("end", () => {
      stop();
      setStreamLost(true);
    });
    es.onerror = () => {
      misses += 1;
      // An HTTP error on reconnect closes the stream for good, so no second error ever comes.
      if (misses < 4 && es.readyState !== EventSource.CLOSED) return;
      stop();
      setStreamLost(true);
    };
    return stop;
  }, [id, streaming]);

  const retryLogs = async () => {
    setLogError(undefined);
    const r = await callJson<{ data: DeploymentLogs | null; error?: string }>(`/api/deployments/${encodeURIComponent(id)}/logs?after=0`);
    if (r.ok && r.data?.data) {
      setLines(r.data.data.lines);
      setDone(r.data.data.done);
    } else setLogError(r.ok ? (r.data?.error ?? "The API did not answer") : r.error);
  };

  if (!d) return <Missing id={id} initial={initial} notices={notices} now={now} />;

  const label = appLabel(d);
  const inFlight = IN_FLIGHT.includes(d.status);
  const vercel = d.external ?? null;
  const canRollback = d.status === "ready" && !d.current && !vercel;
  const short = d.commit?.slice(0, 7);
  // Project and app are named in the crumbs, so the heading is the commit, or the start of the id.
  const name = short ?? d.id.slice(0, 8);
  const where = deployWhere(d);

  /** The preview never sends anything: it waits a beat, then shows what the page would do. */
  const previewAct = async (action: DeploymentAction): Promise<ActionResult> => {
    await new Promise((r) => setTimeout(r, 700));
    if (action === "rollback") setD((cur) => (cur ? { ...cur, current: true } : cur));
    if (action === "cancel") {
      const at = new Date().toISOString();
      const wall = secondsBetween(d.createdAt, at);
      setD((cur) =>
        cur
          ? {
              ...cur,
              status: "cancelled",
              finishedAt: at,
              steps: cur.steps.map((s) =>
                s.status === "running" ? { ...s, status: "cancelled", finishedAt: at } : s.status === "pending" ? { ...s, status: "skipped" } : s,
              ),
            }
          : cur,
      );
      tail.current = [];
      setLines((ls) => {
        const seq = ls.at(-1)?.seq ?? 0;
        return [
          ...ls,
          { seq: seq + 1, ts: at, stream: "stderr", text: `Cancel requested by ${d.actor?.name ?? "an operator"}` },
          { seq: seq + 2, ts: at, stream: "stdout", text: "Stopping the build, sending SIGTERM to BuildKit" },
          { seq: seq + 3, ts: at, stream: "stderr", text: `Build cancelled after ${duration(wall)}` },
        ];
      });
      setDone(true);
      setFollow(false);
    }
    return { ok: true };
  };

  const send = async (action: DeploymentAction): Promise<ActionResult> => {
    const body = await sendDeploymentAction(d.id, action);
    if (action === "cancel" && body.deployment) setD((cur) => (cur ? { ...cur, ...body.deployment } : cur));
    return body;
  };

  /** Resolves false when it failed. */
  const act = async (action: DeploymentAction) => {
    const m = ACTION_TOAST[action];
    setPending(action);
    try {
      await toast.promise(preview ? previewAct(action) : send(action), {
        loading: m.loading,
        description: describe(where, { preview }),
        success: (body) => {
          const next = action !== "cancel" ? body.deployment?.id : undefined;
          return {
            title: m.success,
            action: next ? { label: "View", onClick: () => router.push(`/deployments/${encodeURIComponent(next)}`) } : undefined,
          };
        },
        error: (e) => ({ title: m.error, description: describe([where, errText(e)]) }),
      });
      return true;
    } catch {
      return false;
    } finally {
      setPending(null);
    }
  };

  /** The confirm dialog's answer: it closes on success and stays open for another try on failure. */
  const confirm = async () => {
    if (ask && !(await act(ask))) throw new Error("Action failed");
  };

  const question = actionQuestion(ask ?? "redeploy", { label, short, ago: timeAgo(d.createdAt, now), queued: d.status === "queued", vercel: !!vercel });

  /** A Viewer cannot act, and a labelled key has no tip to say why, so a Viewer does not get the key at all. */
  const key = (action: DeploymentAction, text: string) =>
    can.manage ? (
      <PendingButton type="button" className="btn" pending={pending === action} disabled={busy && pending !== action} onClick={() => setAsk(action)}>
        {text}
      </PendingButton>
    ) : null;

  const tone = DEPLOY_TONE[d.status];
  const repo = githubRepo(d.repo);
  const commit = commitHref(repo, d.commit);
  const logNote = logError ? (
    <>
      <span>Could not load the log. {clause(logError)}.</span>
      <button type="button" className="btn btn-sm" onClick={() => void retryLogs()}>
        Try again
      </button>
    </>
  ) : lines.length === 0 ? (
    <span>{inFlight ? "Waiting for the first line" : "This deployment printed no log lines."}</span>
  ) : undefined;

  return (
    <>
      <Topbar trail={["Deployments", `${label}, ${name}`]} notices={notices} now={now} />
      <main className="page" id="main" tabIndex={-1}>
        <Crumbs
          back
          current={false}
          items={[
            { label: "Deployments", href: "/deployments" },
            { label: d.projectSlug, href: `/projects/${encodeURIComponent(d.projectSlug)}`, icon: <ProjectIcon slug={d.projectSlug} /> },
            { label: d.app.name, href: `/apps/${encodeURIComponent(d.appId)}`, icon: <AppIcon id={d.appId} kind={d.app.kind} /> },
          ]}
        />
        <SectionHead
          level={1}
          title={name}
          className="dpd-head"
          lead={
            // Who, which branch and when live in the Details grid right under it, so the head does not repeat them.
            <span className="dpd-lead">
              <StatusIcon status={d.status} />
              <span className="dpd-status" data-tone={tone}>
                {DEPLOY_LABEL[d.status]}
                {d.current ? ", serving traffic" : ""}
              </span>
              <span className="dpd-msg">{deployMessage(d)}</span>
            </span>
          }
          actions={
            <>
              {commit ? (
                <a href={commit} target="_blank" rel="noopener noreferrer" className="btn">
                  View on GitHub
                </a>
              ) : null}
              {vercel?.url && d.status === "ready" ? (
                <a href={vercel.url} target="_blank" rel="noopener noreferrer" className="btn" title={hostOfUrl(vercel.url)}>
                  Visit
                </a>
              ) : null}
              {vercel?.inspectorUrl ? (
                <a href={vercel.inspectorUrl} target="_blank" rel="noopener noreferrer" className="btn">
                  Open on Vercel
                </a>
              ) : null}
              {inFlight ? (
                // Until Vercel accepts the deploy there is nothing on its side to stop.
                vercel && (!vercel.id || d.followOnly) ? null : key("cancel", "Cancel deployment")
              ) : vercel ? null : (
                <>
                  {canRollback ? key("rollback", "Roll back") : null}
                  {key("redeploy", "Redeploy")}
                </>
              )}
            </>
          }
        />
        <ConfirmDialog
          open={ask !== null}
          onClose={() => setAsk(null)}
          onConfirm={confirm}
          title={question.title}
          body={question.body}
          confirmLabel={question.confirm}
          cancelLabel={question.keep}
        />
        {/* Where it came from and how long it took lead, then the steps, then the log. */}
        <Rule />
        <section className="card reveal dpd-meta-card" aria-labelledby="dpd-meta-title">
          <div className="card-hd">
            <CardTitle id="dpd-meta-title" icon="info" title="Details" sub="Where it came from and how long it took" />
          </div>
          {vercel ? (
            <div className="dpd-note">
              <Callout icon="vercel">
                {d.followOnly
                  ? "Vercel built this deployment and hosts it. This app only follows its Vercel project, so Dockify reads this record and changes nothing on Vercel. Cancel, redeploy and roll back on Vercel."
                  : "Vercel built this deployment and hosts it, and Dockify mirrors its record. Cancel works from here while it builds. Redeploy and roll back on Vercel: its Instant Rollback also stops new deploys from reaching your production domains until you undo it, and Dockify will not do that for you. To deploy again from here, press Deploy on the app."}
              </Callout>
            </div>
          ) : null}
          <DeploymentMeta d={d} now={now} multiEnv={projectsShowingEnvironments(ov.data?.resources ?? [])(d.projectSlug)} />
        </section>
        <Spacer />
        <DeploymentSteps d={d} now={now} />
        <Spacer />

        <section className="card reveal" aria-labelledby="dpd-log-title">
          <div className="card-hd">
            <CardTitle
              id="dpd-log-title"
              icon="logs"
              title="Build log"
              sub={live ? `${vercel ? "Streaming from Vercel" : "Streaming"}, ${plural(lines.length, "line")}` : `${plural(lines.length, "line")}${errors ? `, ${plural(errors, "error")}` : ""}`}
            />
          </div>
          <LogViewer
            lines={lines}
            live={live}
            follow={follow}
            onFollow={setFollow}
            fileName={`${d.projectSlug}-${d.app.name}-${short ?? d.id}.txt`}
            status={logNote}
            openAtError={d.status === "failed"}
            announce={outcome(d)}
          />
        </section>
        {/* A build that failed or was cancelled never ran, so it has nothing to say at runtime. */}
        {vercel?.id && (d.status === "ready" || inFlight) ? (
          <>
            <Spacer />
            <VercelRuntimeLogs appId={d.appId} deployment={d.id} inspectorUrl={vercel.inspectorUrl} name={`${d.projectSlug}-${d.app.name}-${short ?? d.id}`} sub="Read live from Vercel" />
          </>
        ) : null}
        <Spacer end />
      </main>
    </>
  );
}
