/**
 * The deploy_notify job, while Deploy failed is on in Settings, Notifications. Every enabled webhook
 * hears it. So does the member who started it, by email: the user who clicked, or for a push the
 * member whose verified GitHub login is the commit author, while email is set up and they kept
 * "Deploys I started that fail" on in Settings, Profile. A deployment on Vercel is told the same way.
 * The branch, the commit and the error are text a repository or its build wrote, on this server as
 * much as on Vercel, so they lose links and mentions first.
 */
import { appLabel } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import { deployFailed } from "@dockify/email";
import { Redactor } from "@dockify/redact";
import { PermanentJobError } from "../errors.ts";
import { mailIconLinks, mailIconSigner, SHOWN_APP_ICON, SHOWN_PROJECT_ICON } from "../icons/mail.ts";
import { loadSender, mailEach, type EmailDeps } from "./email.ts";
import { eventOn, webhooksOnce } from "./events.ts";
import { inertLine } from "./preview-feedback.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseDeployNotify(raw: unknown): { deploymentId: string } {
  const id = (raw as { deploymentId?: unknown } | null)?.deploymentId;
  if (typeof id !== "string" || !UUID.test(id)) throw new PermanentJobError("deploy_notify payload is malformed");
  return { deploymentId: id };
}

/** The current member who started a deployment and wants to hear when it fails, or null. */
export async function deployStarter(db: Db, d: { actorType: string; actorId: string | null; gitAuthor: string | null }) {
  const where = d.actorType === "user" && d.actorId ? { id: d.actorId } : d.actorType === "webhook" && d.gitAuthor ? { githubLogin: d.gitAuthor, githubVerifiedAt: { not: null } } : null;
  if (!where) return null;
  const user = await db.user.findFirst({ where: { ...where, disabledAt: null, member: { isNot: null } }, select: { id: true, email: true, emailDeployFailed: true } });
  return user?.emailDeployFailed ? user : null;
}

export interface DeployNotifyDeps extends EmailDeps {
  publicUrl: string | null;
  /** DOCKIFY_INTERNAL_TOKEN, to sign the icon links in the email; without it the chip shows the tiles. */
  internalToken?: string;
}

/** Throws to retry, PermanentJobError to stop. */
export async function deliverDeployFailed(deps: DeployNotifyDeps, raw: unknown): Promise<"sent" | "skipped"> {
  const { deploymentId } = parseDeployNotify(raw);
  if (!(await eventOn(deps.db, "deployFailed"))) return "skipped";
  const d = await deps.db.deployment.findUnique({
    where: { id: deploymentId },
    select: {
      status: true, error: true, branch: true, commitSha: true, finishedAt: true, actorType: true, actorId: true, gitAuthor: true, provider: true, externalTarget: true,
      app: {
        select: {
          ...SHOWN_APP_ICON,
          name: true, displayName: true, kind: true, gitRepository: true, gitInstallationId: true,
          environment: { select: { name: true, project: { select: { ...SHOWN_PROJECT_ICON, slug: true, name: true, _count: { select: { environments: true } } } } } },
        },
      },
    },
  });
  if (!d || d.status !== "failed") return "skipped";
  const inst = await deps.db.instance.findUnique({ where: { id: 1 }, select: { name: true } });
  const vercel = d.provider === "vercel";
  const preview = vercel && d.externalTarget === "preview";
  const outside = (s: string | null) => (s ? inertLine(s) : s);
  const branch = outside(d.branch);
  const commit = outside(d.commitSha);
  const source = [vercel ? (preview ? "Vercel preview" : "Vercel") : null, branch, commit?.slice(0, 7)].filter(Boolean).join(", ") || null;
  const project = d.app.environment.project;
  // A project with one environment names none, as the dashboard does; the data payload always has it.
  const env = (project._count?.environments ?? 2) > 1 ? d.app.environment.name : null;
  // What people read as the app's name; the payload's data keeps the name, which is its identity.
  const shown = appLabel(d.app);
  // Line by line: the error quotes the build's last output under its first line.
  const inert = (d.error ?? "").split(/\r?\n/).map(inertLine).filter(Boolean).join("\n");
  // The pipeline writes its own through its redactor. Vercel's text has been through nothing yet.
  const error = (vercel ? new Redactor().line(inert) : inert) || "The deploy did not finish";
  await webhooksOnce(deps.db, `deploy-failed:${deploymentId}`, {
    id: `deploy-failed-${deploymentId}`,
    event: "deploy.failed",
    severity: "warning",
    title: `${preview ? "Preview failed on Vercel" : vercel ? "Deploy failed on Vercel" : "Deploy failed"}: ${shown}`,
    text: error.slice(0, 2000),
    url: deps.publicUrl ? new URL(`/deployments/${deploymentId}`, deps.publicUrl).toString() : null,
    fields: [{ name: "Where", value: [project.slug, ...(env ? [env] : []), shown].join(" / ") }, ...(source ? [{ name: "Source", value: source }] : [])],
    at: (d.finishedAt ?? new Date()).toISOString(),
    instance: { name: inst?.name ?? "Dockify", url: deps.publicUrl ? new URL(deps.publicUrl).origin : null },
    data: { deployment: { id: deploymentId, project: project.slug, environment: d.app.environment.name, app: d.app.name, branch, commit } },
  });
  if (!deps.publicUrl) return "skipped";
  const user = await deployStarter(deps.db, d);
  if (!user) return "skipped";
  const sender = await loadSender(deps.db, deps.vault);
  if (!sender) return "skipped";
  const origin = new URL(deps.publicUrl).origin;
  const message = deployFailed({
    instanceName: inst?.name ?? "Dockify",
    origin,
    // The place as the dashboard shows it: project icon or folder, EnvTag, app icon or kind tile.
    where: {
      projectName: project.name, projectSlug: project.slug, env, appName: shown, appKind: d.app.kind,
      ...mailIconLinks(origin, mailIconSigner(deps.internalToken), d.app, project),
    },
    error,
    source,
    // A GitHub App install, or a repository URL on github.com, gets the GitHub mark on its Source row.
    github: !vercel && (Boolean(d.app.gitInstallationId) || /^https:\/\/github\.com\//i.test(d.app.gitRepository ?? "")),
    at: d.finishedAt ?? new Date(),
    url: new URL(`/deployments/${deploymentId}`, deps.publicUrl).toString(),
  });
  await mailEach(deps, sender, [user], message, (id) => `deploy-failed:${deploymentId}:${id}`);
  return "sent";
}
