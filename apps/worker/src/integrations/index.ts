/**
 * Worker side of integrations. wiring.ts merges these into its handler tables:
 *
 *   preview_cleanup   tear a preview down (containers, routes, images)
 *   preview_wake      start a sleeping preview and route it again
 *   preview_feedback  the sticky PR comment and the commit status
 *   preview_dns       the wildcard record of a preview domain, and the check that it resolves here
 *   vercel_sync       the Vercel deploy target
 *   vercel_mirror     copy a linked Vercel project's deployments into the deployments list
 *
 * and a timer runs reconcilePreviews every few minutes (the cleanup guarantee).
 */
import type { Db, SecretVault } from "@dockify/db";
import type { HttpClient } from "@dockify/net-guard";
import { FeedbackError, runPreviewFeedback } from "./preview-feedback.ts";
import { PreviewCleanupError, runPreviewCleanup, runPreviewWake, type PreviewRuntimeDeps } from "./previews.ts";
import { runVercelMirror, VercelMirrorError } from "./vercel-mirror.ts";
import { runVercelSync, VercelJobError } from "./vercel-target.ts";

export interface IntegrationJobDeps {
  db: Db;
  vault: SecretVault;
  http: HttpClient;
  resolveEnv(appId: string): Promise<Record<string, string>>;
  githubApiBase: string;
  publicUrl: string | null;
  internalToken?: string | undefined;
  deploymentRetentionDays: number;
}

export interface IntegrationJob {
  payload: unknown;
}

/** Errors a retry cannot fix; wiring maps these to PermanentJobError. */
export const isPermanent = (e: unknown): boolean =>
  e instanceof PreviewCleanupError || (e instanceof FeedbackError && e.permanent) || (e instanceof VercelJobError && e.permanent) || (e instanceof VercelMirrorError && e.permanent);

/** The two that act on a server: its containers and its routes. */
export function previewJobHandlers(previews: PreviewRuntimeDeps) {
  return {
    preview_cleanup: (job: IntegrationJob) => runPreviewCleanup(previews, job.payload),
    preview_wake: (job: IntegrationJob) => runPreviewWake(previews, job.payload),
  };
}

/** The ones that reach no server: GitHub, Vercel. */
export function integrationJobHandlers(deps: IntegrationJobDeps) {
  return {
    preview_feedback: (job: IntegrationJob) =>
      runPreviewFeedback({ db: deps.db, vault: deps.vault, http: deps.http, apiBase: deps.githubApiBase, publicUrl: deps.publicUrl, internalToken: deps.internalToken }, job.payload),
    vercel_sync: (job: IntegrationJob, signal: AbortSignal) => runVercelSync(deps, job.payload, signal),
    vercel_mirror: (job: IntegrationJob) => runVercelMirror({ db: deps.db, vault: deps.vault, http: deps.http, retentionDays: deps.deploymentRetentionDays }, job.payload),
  };
}

export { queueVercelMirrorIfDue } from "./vercel-mirror.ts";
export { reconcilePreviews, planReconcile, planDockerSweep, previewRouteIds, statsOf, traefikCounters } from "./previews.ts";
export { runPreviewDns, staleDnsDomains } from "./preview-dns.ts";
export { openWebhook, recordDelivery, runWebhookSend, sendToWebhook } from "./webhooks.ts";
export { registryAuthFor, xRegistryAuth } from "./registry-auth.ts";
export { createHttpClient } from "@dockify/net-guard";
