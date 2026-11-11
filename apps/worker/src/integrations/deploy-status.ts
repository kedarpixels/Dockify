/** The deploy_status commit status ("Dockify") through the GitHub App; a no-op without an installation. */
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

/** GitHub caps the description at 140 characters. */
export function deployStatusFor(d: { status: string; error: string | null }): { state: "success" | "failure"; description: string } | null {
  if (d.status === "ready") return { state: "success", description: "Deployed" };
  if (d.status !== "failed") return null;
  // A build's error carries its last lines, which is where the summary finds the place it failed.
  const text = failedStatusText({ error: d.error, lines: d.error?.split(/\r?\n/).slice(1) ?? [] });
  return { state: "failure", description: text.length > 140 ? `${text.slice(0, 137)}...` : text };
}

/** Throws to retry, PermanentJobError to stop. */
export async function runDeployStatus(deps: DeployStatusDeps, raw: unknown): Promise<"sent" | "skipped"> {
  const id = (raw as { deploymentId?: unknown } | null)?.deploymentId;
  if (typeof id !== "string" || !UUID.test(id)) throw new PermanentJobError("deploy_status payload is malformed");
  const d = await deps.db.deployment.findUnique({
    where: { id },
    select: {
      status: true, error: true, commitSha: true,
      app: { select: { gitRepository: true, gitInstallation: { select: { installationId: true } }, environment: { select: { project: { select: { gitInstallation: { select: { installationId: true } } } } } } } },
    },
  });
  if (!d?.commitSha || !/^[0-9a-f]{40}$/.test(d.commitSha)) return "skipped";
  const status = deployStatusFor(d);
  const repo = GITHUB_REPO.exec(d.app.gitRepository ?? "");
  const installation = (d.app.gitInstallation ?? d.app.environment.project.gitInstallation)?.installationId ?? null;
  if (!status || !repo || installation === null) return "skipped";
  const cred = await installationCredential({ db: deps.db, vault: deps.vault, apiBase: deps.apiBase }, installation, "github.com");
  if (!cred) return "skipped";
  const target = deps.publicUrl ? new URL(`/deployments/${id}`, deps.publicUrl).toString() : null;
  const res = await deps.http({
    method: "POST",
    url: `${deps.apiBase}/repos/${encodeURIComponent(repo[1]!)}/${encodeURIComponent(repo[2]!)}/statuses/${d.commitSha}`,
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: `Bearer ${cred.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state: status.state, description: status.description, context: DEPLOY_STATUS_CONTEXT, ...(target?.startsWith("https://") ? { target_url: target } : {}) }),
    timeoutMs: 15_000,
  });
  if (res.status >= 500 || res.status === 429) throw new Error(`GitHub answered ${res.status} setting the commit status`);
  // A commit gone from the repository, or an App that lost access: nothing a retry can change.
  return res.status < 300 ? "sent" : "skipped";
}
