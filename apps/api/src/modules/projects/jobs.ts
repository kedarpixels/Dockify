/**
 * Work this module hands to the worker, as rows on the leased jobs queue. Each enqueue runs inside
 * the caller's transaction, so a job exists exactly when the change that needs it committed.
 * The dedupe rule matches the worker's enqueue(): one open job per key, under an advisory lock.
 */
import type { Prisma } from "@dockify/db";
import { requestDeployTx } from "../deployments/enqueue.ts";
import type { Reach } from "./env-model.ts";
import type { Writer } from "./env-store.ts";

const STATEFUL = new Set(["postgres", "redis", "s3"]);

/** Payload of a remove_app job. Carries everything because the rows are gone when it runs. */
export interface RemoveAppJobPayload {
  appId: string;
  appName: string;
  environmentId: string;
  projectId: string;
  containerId: string | null;
  volumeNames: string[];
  /** Cloudflare objects Dockify created for the app's domains, for the worker to delete. */
  domains: Array<{ hostname: string; cfZoneId: string | null; cfRecordId: string | null }>;
  /** Images its deployments ran: their rows go with the app, and the worker removes those nothing else needs. */
  imageIds: string[];
}

/**
 * Redeploys the apps an env apply reached. Only server apps that run and have deployed before are
 * touched, and never a stateful service: restarting a database for an env edit is not something
 * the owner asked for. An app with a deploy already open gets pendingDeployAt instead, which the
 * deploy pipeline picks up after the open one.
 */
export async function requestRedeploys(tx: Prisma.TransactionClient, reach: Reach[], writer: Writer): Promise<string[]> {
  if (reach.length === 0) return [];
  const apps = await tx.app.findMany({
    where: { id: { in: reach.map((r) => r.appId) } },
    select: { id: true, kind: true, deployTarget: true, desiredState: true, gitBranch: true, currentDeployment: { select: { imageId: true, imageRef: true, commitSha: true } } },
  });
  const ids: string[] = [];
  for (const app of apps) {
    if (STATEFUL.has(app.kind) || app.deployTarget !== "server" || app.desiredState !== "running" || !app.currentDeployment) continue;
    const rebuild = reach.find((r) => r.appId === app.id)?.rebuild ?? true;
    // Only runtime values changed: pin the running image so the worker skips the build.
    const pinned = !rebuild && app.currentDeployment.imageId;
    const out = await requestDeployTx(tx, app.id, {
      trigger: "redeploy",
      branch: app.gitBranch,
      commitSha: app.currentDeployment.commitSha,
      message: "Env vars changed",
      imageId: pinned ? app.currentDeployment.imageId : null,
      imageRef: pinned ? app.currentDeployment.imageRef : null,
      actorType: writer.actorType,
      actorId: writer.actorId,
      actorName: writer.actorName,
    }, "coalesce");
    if (out.kind === "queued") ids.push(out.deploymentId);
  }
  return ids;
}

/** Queues container, volume and Cloudflare teardown for apps about to be deleted. */
export async function enqueueRemovals(tx: Prisma.TransactionClient, appIds: string[], projectId: string): Promise<number> {
  if (appIds.length === 0) return 0;
  const apps = await tx.app.findMany({
    where: { id: { in: appIds } },
    select: {
      id: true, name: true, environmentId: true, containerId: true, serverId: true,
      volumes: { select: { name: true } },
      domains: { select: { hostname: true, cfZoneId: true, cfRecordId: true } },
      deployments: { where: { imageId: { not: null } }, select: { imageId: true } },
    },
  });
  await tx.job.createMany({
    data: apps.map((a) => {
      const payload: RemoveAppJobPayload = {
        appId: a.id, appName: a.name, environmentId: a.environmentId, projectId,
        containerId: a.containerId, volumeNames: a.volumes.map((v) => v.name), domains: a.domains,
        imageIds: [...new Set(a.deployments.map((d) => d.imageId!))],
      };
      return { kind: "remove_app" as const, lane: "maintenance" as const, serverId: a.serverId, payload: payload as unknown as Prisma.InputJsonValue, maxAttempts: 10 };
    }),
  });
  return apps.length;
}
