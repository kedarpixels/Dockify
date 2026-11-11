// The one path from "a deploy should happen" to a queued job. Every caller must come through here:
// the Deployment row and its job are written together under a per-app advisory lock, so two clicks
// never queue two builds and no deployment is left without a job.
import { gzipSync } from "node:zlib";
import type { Db, Prisma, Tx } from "@dockify/db";
import { HttpError } from "../../errors.ts";
import { IN_FLIGHT } from "./mapping.ts";

export type NewDeployment = Omit<Prisma.DeploymentUncheckedCreateInput, "appId" | "serverId" | "status" | "steps" | "logSeq">;

export type DeployRequestOutcome = { kind: "queued"; deploymentId: string; jobId: string } | { kind: "coalesced" };

/**
 * When a deploy is already in flight, `busy` decides: "reject" answers 409 (a click), "coalesce"
 * stamps pendingDeployAt so the pipeline runs one more deploy after the open one (a push, an env change).
 */
export async function requestDeployTx(
  tx: Prisma.TransactionClient,
  appId: string,
  data: NewDeployment,
  busy: "reject" | "coalesce",
): Promise<DeployRequestOutcome> {
  const previewId = data.previewId ?? null;
  const key = previewId ? `deploy:preview:${previewId}` : `deploy:${appId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  const open = await tx.deployment.findFirst({ where: { appId, previewId, status: { in: IN_FLIGHT } }, select: { id: true } });
  const openJob = open ? null : await tx.job.findFirst({ where: { dedupeKey: key, completedAt: null, failedAt: null }, select: { id: true } });
  if (open || openJob) {
    if (busy === "reject") {
      throw new HttpError(409, "A deployment of this app is already in progress", "DEPLOY_IN_FLIGHT", open ? { deploymentId: open.id } : {});
    }
    if (!previewId) await tx.app.updateMany({ where: { id: appId }, data: { pendingDeployAt: new Date() } });
    return { kind: "coalesced" };
  }
  const app = await tx.app.findUnique({ where: { id: appId }, select: { serverId: true } });
  if (!app) throw new HttpError(404, "App not found", "NOT_FOUND");
  const now = new Date().toISOString();
  const dep = await tx.deployment.create({
    data: { ...data, previewId, appId, serverId: app.serverId, status: "queued", steps: [{ id: "queued", status: "done", startedAt: now, finishedAt: now }] },
    select: { id: true },
  });
  const job = await tx.job.create({
    data: { kind: "deploy", lane: "deploy", serverId: app.serverId, payload: { deploymentId: dep.id, appId, previewId }, dedupeKey: key, maxAttempts: 3 },
    select: { id: true },
  });
  // The commit is known already (a push, a redeploy, a rollback): GitHub shows this app pending while it
  // waits its turn. Without one the worker queues this after the clone; either way once per deployment.
  if (!previewId && typeof data.commitSha === "string" && /^[0-9a-f]{40}$/.test(data.commitSha)) {
    await tx.job.create({ data: { kind: "deploy_status", lane: "maintenance", payload: { deploymentId: dep.id }, dedupeKey: `deploy_status:${dep.id}:pending`, maxAttempts: 5 } });
  }
  if (!previewId) await tx.app.update({ where: { id: appId }, data: { status: "deploying", pendingDeployAt: null, desiredState: "running" } });
  return { kind: "queued", deploymentId: dep.id, jobId: job.id };
}

/**
 * Guards a delete: a running deployment's container could come up after the teardown looked. Locks
 * are taken in id order so two deletes cannot deadlock; a later deploy waits and finds the app gone.
 */
export async function assertNoDeployInFlight(tx: Prisma.TransactionClient, appIds: string[]): Promise<void> {
  for (const id of [...appIds].sort()) {
    const key = `deploy:${id}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const open = await tx.deployment.findFirst({ where: { appId: id, previewId: null, status: { in: IN_FLIGHT } }, select: { id: true, app: { select: { name: true, displayName: true } } } });
    if (open) throw new HttpError(409, `A deployment of ${open.app.displayName || open.app.name} is in progress. Cancel it first.`, "DEPLOY_IN_FLIGHT", { deploymentId: open.id });
  }
}

export async function enqueueDeployment(db: Db, appId: string, data: NewDeployment): Promise<string> {
  return db.$transaction(async (tx) => {
    const out = await requestDeployTx(tx, appId, data, "reject");
    if (out.kind !== "queued") throw new HttpError(409, "A deployment of this app is already in progress", "DEPLOY_IN_FLIGHT");
    return out.deploymentId;
  });
}

/** The seq is allocated by the database, as the worker does, so these lines never collide with the running deploy's. */
export async function appendLog(db: Tx, deploymentId: string, texts: string[], stream: "stdout" | "stderr" = "stdout"): Promise<void> {
  if (!texts.length) return;
  const n = texts.length;
  const rows = await db.$queryRaw<Array<{ logSeq: number }>>`
    UPDATE deployments SET "logSeq" = "logSeq" + ${n} WHERE id = ${deploymentId}::uuid RETURNING "logSeq"`;
  const end = rows[0]?.logSeq;
  if (end === undefined) return;
  const ts = new Date().toISOString();
  const gz = gzipSync(Buffer.from(texts.map((text) => JSON.stringify({ ts, stream, text })).join("\n"), "utf8"));
  await db.deploymentLogChunk.create({ data: { deploymentId, firstSeq: end - n, lineCount: n, gzip: new Uint8Array(gz) } });
}
