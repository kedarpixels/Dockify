/**
 * The preview_notify job: "Preview ready" or "Preview failed", Dockify's own email next to GitHub's
 * notification of the PR comment. settlePreview decides when one is owed (never per push); this job
 * decides who reads it. That is the member whose verified GitHub login opened the pull request, the
 * same rule as deployStarter, or else the admins. A pull request's author who is not a member never
 * gets mail, so a stranger's pull request cannot send email to anyone they name. Sent only while
 * email is set up and Preview deployments is on in Settings, Notifications, Events.
 */
import { projects as P } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import { previewNotice } from "@dockify/email";
import { PermanentJobError } from "../errors.ts";
import { failureLines } from "../deploy/preview.ts";
import { loadSender, mailEach, type EmailDeps } from "./email.ts";
import { eventOn } from "./events.ts";
import { inertLine, inertText, LOG_LINES } from "./preview-feedback.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PreviewNotify {
  previewId: string;
  state: "ready" | "failed";
  commit: string | null;
}

export function parsePreviewNotify(raw: unknown): PreviewNotify {
  const p = raw as Partial<PreviewNotify> | null;
  if (typeof p?.previewId !== "string" || !UUID.test(p.previewId) || (p.state !== "ready" && p.state !== "failed") || (p.commit !== null && typeof p.commit !== "string")) {
    throw new PermanentJobError("preview_notify payload is malformed");
  }
  return { previewId: p.previewId, state: p.state, commit: p.commit ?? null };
}

/** Who reads it: the current member with this verified GitHub login, or else every current admin. */
export async function previewRecipients(db: Db, author: string | null): Promise<{ users: Array<{ id: string; email: string }>; recipient: "author" | "admin" }> {
  const user = author
    ? await db.user.findFirst({ where: { githubLogin: author, githubVerifiedAt: { not: null }, disabledAt: null, member: { isNot: null } }, select: { id: true, email: true } })
    : null;
  if (user) return { users: [user], recipient: "author" };
  const admins = await db.member.findMany({ where: { role: "admin", user: { disabledAt: null } }, select: { user: { select: { id: true, email: true } } } });
  return { users: admins.map((a) => a.user), recipient: "admin" };
}

export interface PreviewNotifyDeps extends EmailDeps {
  publicUrl: string | null;
}

/** Throws to retry, PermanentJobError to stop. A retry skips what the mail server already accepted. */
export async function deliverPreviewNotice(deps: PreviewNotifyDeps, raw: unknown): Promise<"sent" | "skipped"> {
  const n = parsePreviewNotify(raw);
  if (!deps.publicUrl) return "skipped";
  const env = await deps.db.previewEnv.findUnique({
    where: { id: n.previewId },
    select: {
      prNumber: true, title: true, author: true, branch: true, commitSha: true, repo: true, status: true, error: true, fromFork: true, isolatedDb: true, notifiedKey: true,
      baseEnvironment: { select: { name: true } },
      project: { select: { slug: true, previewProductionAccess: true, environments: { select: { id: true } } } },
      apps: {
        orderBy: { createdAt: "asc" },
        select: { hostname: true, currentDeploymentId: true, app: { select: { port: true } }, deployments: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, error: true } } },
      },
    },
  });
  if (!env) return "skipped";
  // A push or a close beat this job: the email would describe a state that is gone. A first "ready"
  // that never went out is owed again when the preview is next ready.
  if (env.status !== n.state || (env.commitSha ?? null) !== n.commit) {
    if (n.state === "ready" && env.notifiedKey === "ready") await deps.db.previewEnv.updateMany({ where: { id: n.previewId, notifiedKey: "ready" }, data: { notifiedKey: null } });
    return "skipped";
  }
  if (!(await eventOn(deps.db, "previewDeployments"))) return "skipped";
  const inst = await deps.db.instance.findUnique({ where: { id: 1 }, select: { name: true } });
  const { users, recipient } = await previewRecipients(deps.db, env.author);
  if (!users.length) return "skipped";
  const sender = await loadSender(deps.db, deps.vault);
  if (!sender) return "skipped";

  const failed = env.apps.map((a) => a.deployments[0]).find((d) => d?.status === "failed");
  const serving = env.apps.find((a) => a.app.port !== null && a.currentDeploymentId);
  const lines = failureLines(failed?.error ?? null).slice(-LOG_LINES).map(inertLine).filter(Boolean);
  const origin = new URL(deps.publicUrl).origin;
  const base = {
    instanceName: inst?.name ?? "Dockify",
    origin,
    state: n.state,
    repo: env.repo,
    prNumber: env.prNumber,
    title: inertText(env.title),
    branch: inertText(env.branch),
    commit: env.commitSha,
    author: env.author ? inertText(env.author) : null,
    fromFork: env.fromFork,
    isolatedDb: env.isolatedDb,
    isolation: P.previewIsolation(env),
    baseEnvironment: env.baseEnvironment.name,
    previewUrl: serving ? `https://${serving.hostname}` : null,
    dashboardUrl: new URL(`/projects/${encodeURIComponent(env.project.slug)}?tab=previews`, deps.publicUrl).toString(),
    // Written by the pipeline through its redactor, like the lines; stripped of links here.
    reason: env.error ? inertLine(env.error) : null,
    lines,
    recipient,
  };
  const message = previewNotice(base);
  await mailEach(deps, sender, users, message, (id) => `preview:${n.previewId}:${n.state}:${n.commit ?? "none"}:${id}`);
  return "sent";
}
