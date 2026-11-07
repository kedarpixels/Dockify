"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ACTION_TOAST, actionQuestion, deployWhere, sendDeploymentAction, triggerLabel } from "@/components/deployments/actions";
import { Icon } from "@/components/icon";
import { AppIcon } from "@/components/icons/app-icon";
import { ActorAvatar } from "@/components/ui/actor-avatar";
import { ConfirmDialog } from "@/components/ui/dialog";
import { BranchRef } from "@/components/ui/git-ref";
import { HashChip } from "@/components/ui/hash-chip";
import { usePreview } from "@/components/ui/preview";
import { toast } from "@/components/ui/toast";
import { When } from "@/components/ui/when";
import { deployFace, deployMessage, deploySource, deployTip } from "@/lib/deploy-source";
import { appLabel, DEPLOY_LABEL, DEPLOY_TONE } from "@/lib/derive";
import { describe, errText } from "@/lib/feedback";
import { clock, duration } from "@/lib/format";
import { githubRepo } from "@/lib/git-links";
import type { ActionResult } from "@/lib/pages/deployments";
import { useTimeFormat } from "@/lib/time-prefs";
import type { RecentDeployment } from "@/lib/types";
import { useCan } from "@/lib/viewer";
import { StatusIcon } from "./status-icon";

/** Seconds a deployment has run, or ran when it is finished. */
export function elapsed(d: RecentDeployment, now: number) {
  const end = d.finishedAt ? Date.parse(d.finishedAt) : now;
  return (end - Date.parse(d.createdAt)) / 1000;
}

/**
 * The row's Redeploy key. It asks first, with the same question as the deployment page, then one
 * toast runs from "Starting redeploy" to the answer, with a View action to the new deployment. The
 * preview sends nothing: a short beat, then the answer saying so.
 */
function RedeployKey({ d }: { d: RecentDeployment }) {
  const preview = usePreview();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const label = appLabel(d);
  const short = d.commit?.slice(0, 7);
  const q = actionQuestion("redeploy", { label, short });
  const where = deployWhere(d);

  const run = async () => {
    const m = ACTION_TOAST.redeploy;
    const sent = preview ? new Promise<ActionResult>((resolve) => setTimeout(() => resolve({ ok: true }), 600)) : sendDeploymentAction(d.id, "redeploy");
    // A failure rejects, so the confirm stays open for another try; its toast already says why.
    await toast.promise(sent, {
      loading: m.loading,
      description: describe(where, { preview }),
      success: ({ deployment }) => ({
        title: m.success,
        description: describe(where, { preview }),
        action: deployment ? { label: "View", onClick: () => router.push(`/deployments/${encodeURIComponent(deployment.id)}`) } : undefined,
      }),
      error: (e) => ({ title: m.error, description: describe([where, errText(e)]) }),
    });
  };

  return (
    <>
      <button type="button" className="btn btn-xs btn-icon" aria-label={`Redeploy ${label}${short ? ` ${short}` : ""}`} data-tip="Redeploy" data-tip-align="end" onClick={() => setOpen(true)}>
        <Icon name="refresh" size={14} />
      </button>
      <ConfirmDialog open={open} onClose={() => setOpen(false)} onConfirm={run} title={q.title} body={q.body} confirmLabel={q.confirm} cancelLabel={q.keep} />
    </>
  );
}

/**
 * One deployment as a 44px soft row: status, project / app,
 * the commit's author and its message, or for a deployment with no commit who started it and what
 * ran, branch, and hash (it copies), left empty with no commit, duration, the time, then the Redeploy
 * key, always in view. The row itself, message included, opens the deployment and its log, so it
 * carries no Logs key of its own. Shared by every
 * deployment list so they all read the same. A Viewer gets no Redeploy key.
 *
 * `scope` says what the page around the row already names: "all" (the default) prints project and
 * app; "project" (a project page) prints the app only; "app" (an app page) prints what started the
 * deployment instead, since the app is the page itself. `time="clock"` (a past day in the heatmap
 * panel) prints the UTC clock time instead of the relative one.
 */
export function DeployRow({ d, now, time = "ago", scope = "all" }: { d: RecentDeployment; now: number; time?: "ago" | "clock"; scope?: "all" | "project" | "app" }) {
  const can = useCan();
  const fmt = useTimeFormat();
  const tone = DEPLOY_TONE[d.status];
  const live = tone === "live";
  const queued = d.status === "queued";
  const secs = elapsed(d, now);
  const repo = githubRepo(d.repo);
  const source = deploySource(d);
  const message = deployMessage(d);
  const face = deployFace(d);
  const href = `/deployments/${d.id}`;
  // In flight reads "Now" (the start in the tip); a past day in the day panel lists its UTC clock,
  // so its times never spill into a neighbouring day; everything else is relative.
  const at = live ? (
    <When iso={d.createdAt} now={now} live tipAlign="end" />
  ) : time === "clock" ? (
    fmt.clock(d.createdAt, { utc: true })
  ) : (
    <When iso={d.createdAt} now={now} tipAlign="end" />
  );
  // Only live and queued rows colour the time; a failed row already says so with its red tile.
  const whenTone = live ? " tone-live" : queued ? " tone-pending" : "";
  return (
    <div className="soft-row dep-row" data-hover="true" data-tone={tone}>
      <Link href={href} className="dep-link" aria-label={`${appLabel(d)}, ${DEPLOY_LABEL[d.status]}`} />
      <StatusIcon status={d.status} />
      <span className="dep-app">
        <AppIcon id={d.app.id} kind={d.app.kind} />
        <span className="dep-name" title={scope === "app" ? undefined : appLabel(d)}>
          {scope === "all" ? <span className="dep-slug">{d.projectSlug}</span> : null}
          {scope === "all" ? <span className="dep-sep">/</span> : null}
          <span>{scope === "app" ? triggerLabel(d.trigger) : d.app.name}</span>
        </span>
        {d.external ? (
          <span className="dep-host" role="img" aria-label="On Vercel" data-tip="On Vercel">
            <Icon name="vercel" size={14} />
          </span>
        ) : null}
      </span>
      <span className="dep-msg">
        {face !== undefined ? <ActorAvatar kind={face?.kind ?? "system"} url={face?.avatarUrl} name={face?.name} tip={deployTip(d)} /> : null}
        {/* Over the row link for its tip, with the row link's own target. The row link is the keyboard's. */}
        <Link href={href} className="dep-msg-link ellipsis" tabIndex={-1} aria-hidden="true" title={d.image ?? message}>
          {message}
        </Link>
      </span>
      {/* A deployment with no commit has nothing to show here; the empty cells keep the columns. */}
      <span className="dep-branch">{source ? null : <BranchRef repo={repo} branch={d.branch} iconSize={14} />}</span>
      <span className="dep-hash">{source ? null : <HashChip hash={d.commit} repo={repo} action="copy" />}</span>
      <span className={`dep-dur num${live ? " tone-live" : ""}`}>{queued ? "" : live ? clock(secs) : duration(secs)}</span>
      <span className={`dep-when num${whenTone}`}>{at}</span>
      <span className="dep-actions">{!live && !queued && can.manage && !d.external ? <RedeployKey d={d} /> : null}</span>
    </div>
  );
}
