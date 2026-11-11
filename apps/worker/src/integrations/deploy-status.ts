/** The deploy_status commit status, one per app ("Dockify / web"), through the GitHub App; a no-op without an installation. */
import type { Db, SecretVault } from "@dockify/db";
import type { HttpClient } from "@dockify/net-guard";
import { installationCredential } from "../deploy/github.ts";
import { PermanentJobError } from "../errors.ts";
import { failedStatusText } from "./preview-feedback.ts";

export const DEPLOY_STATUS_CONTEXT = "Dockify";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GITHUB_REPO = /^https:\/\/github\.com\/([\w.-]{1,100})\/([\w.-]{1,100}?)(?:\.git)?\/?$/i;

export interface DeployStatusDeps {
  db: Db;
  vault: SecretVault;
  http: HttpClient;
  apiBase: string;
  publicUrl: string | null;
}

export type DeployStatus = { state: "pending" | "success" | "failure" | "error"; description: string };

/**
 * One context per app, so apps built from one commit never share or overwrite a status. The
 * environment shows only in a project with several, as placeLabel spells places in the dashboard.
 */
export function deployStatusContext(app: string, environment: string, environmentCount: number | undefined): string {
  return [DEPLOY_STATUS_CONTEXT, ...(environmentCount === undefined || environmentCount > 1 ? [environment] : []), app].join(" / ");
}

/** GitHub caps the description at 140 characters. */
export function deployStatusFor(d: { status: string; error: string | null }): DeployStatus | null {
  switch (d.status) {
    case "queued": return { state: "pending", description: "Queued" };
    case "building": return { state: "pending", description: "Building" };
    case "deploying": return { state: "pending", description: "Deploying" };
    case "cancelling": return { state: "pending", description: "Cancelling" };
    case "ready": return { state: "success", description: "Deployed" };
    case "cancelled": return { state: "error", description: "Cancelled" };
    case "failed": {
      // A build's error carries its last lines, which is where the summary finds the place it failed.
      const text = failedStatusText({ error: d.error, lines: d.error?.split(/\r?\n/).slice(1) ?? [] });
      return { state: "failure", description: text.length > 140 ? `${text.slice(0, 137)}...` : text };
    }
    default: return null;
  }
}

const load = (db: Db, id: string) =>
  db.deployment.findUnique({
    where: { id },
    select: {
      status: true, error: true, commitSha: true,
      app: {
        select: {
          name: true, gitRepository: true, gitInstallation: { select: { installationId: true } },
          environment: { select: { name: true, project: { select: { gitInstallation: { select: { installationId: true } }, _count: { select: { environments: true } } } } } },
        },
      },
    },
  });

/** Posts what the row says now, whichever transition queued the job. Throws to retry, PermanentJobError to stop. */
export async function runDeployStatus(deps: DeployStatusDeps, raw: unknown): Promise<"sent" | "skipped"> {
  const id = (raw as { deploymentId?: unknown } | null)?.deploymentId;
  if (typeof id !== "string" || !UUID.test(id)) throw new PermanentJobError("deploy_status payload is malformed");
  const d = await load(deps.db, id);
  if (!d?.commitSha || !/^[0-9a-f]{40}$/.test(d.commitSha)) return "skipped";
  let status = deployStatusFor(d);
  const repo = GITHUB_REPO.exec(d.app.gitRepository ?? "");
  const installation = (d.app.gitInstallation ?? d.app.environment.project.gitInstallation)?.installationId ?? null;
  if (!status || !repo || installation === null) return "skipped";
  const cred = await installationCredential({ db: deps.db, vault: deps.vault, apiBase: deps.apiBase }, installation, "github.com");
  if (!cred) return "skipped";
  const target = deps.publicUrl ? new URL(`/deployments/${id}`, deps.publicUrl).toString() : null;
  const context = deployStatusContext(d.app.name, d.app.environment.name, d.app.environment.project._count?.environments);
  // A pending post can land after the final one when the deployment settled meanwhile, and would
  // leave the commit pending for good: read the row again and post what it became.
  for (let round = 0; ; round++) {
    const res = await deps.http({
      method: "POST",
      url: `${deps.apiBase}/repos/${encodeURIComponent(repo[1]!)}/${encodeURIComponent(repo[2]!)}/statuses/${d.commitSha}`,
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${cred.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state: status.state, description: status.description, context, ...(target?.startsWith("https://") ? { target_url: target } : {}) }),
      timeoutMs: 15_000,
    });
    if (res.status >= 500 || res.status === 429) throw new Error(`GitHub answered ${res.status} setting the commit status`);
    // A commit gone from the repository, or an App that lost access: nothing a retry can change.
    if (res.status >= 300) return "skipped";
    if (status.state !== "pending" || round > 0) return "sent";
    const now = await deps.db.deployment.findUnique({ where: { id }, select: { status: true, error: true } });
    const next = now ? deployStatusFor(now) : null;
    if (!next || next.state === "pending") return "sent";
    status = next;
  }
}
