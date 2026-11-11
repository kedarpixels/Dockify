/**
 * The seam to the deploy pipeline: integrations decide WHEN to deploy, the deployments module owns HOW
 * (one open deploy per app or preview; a push during a build stamps pendingDeployAt and is not dropped).
 */
import { defaultServerId, type ActorType, type Db, type DeploymentTrigger, type Tx } from "@dockify/db";
import { requestDeployTx } from "../deployments/enqueue.ts";

export interface DeployRequest {
  appId: string;
  trigger: DeploymentTrigger;
  actorType: ActorType;
  actorId?: string | null;
  actorName?: string | null;
  /** Lowercased GitHub login of a push's author. */
  gitAuthor?: string | null;
  gitAuthorAvatarUrl?: string | null;
  /** The commit's git name, set when its author has no GitHub account. */
  gitAuthorName?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  message?: string | null;
  previewId?: string | null;
}

export type DeployOutcome = { kind: "queued"; deploymentId: string; jobId: string } | { kind: "coalesced" };

export interface DeployRequester {
  request(db: Db, req: DeployRequest): Promise<DeployOutcome>;
  /** Idempotent per preview. */
  teardownPreview(db: Tx, previewId: string): Promise<void>;
}

async function openJob(tx: Tx, key: string): Promise<boolean> {
  return !!(await tx.job.findFirst({ where: { dedupeKey: key, completedAt: null, failedAt: null }, select: { id: true } }));
}

export const queueDeployRequester: DeployRequester = {
  async request(db, r) {
    return db.$transaction((tx) =>
      requestDeployTx(tx, r.appId, {
        trigger: r.trigger,
        actorType: r.actorType,
        actorId: r.actorId ?? null,
        actorName: r.actorName ?? null,
        gitAuthor: r.gitAuthor ?? null,
        gitAuthorAvatarUrl: r.gitAuthorAvatarUrl ?? null,
        gitAuthorName: r.gitAuthorName ?? null,
        branch: r.branch ?? null,
        commitSha: r.commitSha ?? null,
        message: r.message ?? null,
        previewId: r.previewId ?? null,
      }, "coalesce"),
    );
  },

  async teardownPreview(tx, previewId) {
    const key = `preview_cleanup:${previewId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    if (await openJob(tx, key)) return;
    await tx.job.create({ data: { kind: "preview_cleanup", lane: "maintenance", serverId: await defaultServerId(tx), dedupeKey: key, payload: { previewId }, maxAttempts: 10 } });
  },
};
