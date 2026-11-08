/**
 * Changing a managed database's version. One job kind on the data lane, so it never runs beside a
 * backup or a restore of the same service, and never retries on its own (maxAttempts 1): a half done
 * change is resolved by a person, who sees exactly where it stopped.
 *
 *   in_place   a newer patch of the same line, or a newer Redis. A dump first, and it must succeed.
 *              Then the new tag under the same volume through the managed deploy, which puts the
 *              previous container back if the new one does not come up healthy.
 *   prepare    a new Postgres major. A dump of the running service, a new service at the new version
 *              (created by the api), a replay into it, and counts of tables and rows on both. Linked
 *              apps keep running on the old one, nothing about them changes.
 *   switch     the owner's confirmation. The apps of the environment stop, so nothing writes; a fresh
 *              dump replaces the copy; tables and rows must then match exactly, or nothing changes and
 *              the apps start again. Only then the source gets serviceRedirectId, one column: every
 *              link now resolves to the new service, and the api's "switch back" clears it.
 *
 * NEVER here: removing a container, a volume or a database of the source. The old service stays
 * running until its owner deletes it, and data is never destroyed automatically.
 */
import { rm } from "node:fs/promises";
import { linkedApps, type Prisma } from "@dockify/db";
import { DataError, type DataDeps } from "./context.ts";
import { parseRestoreCheck, restoreCheckCommand } from "./dump.ts";
import { deployManagedService } from "./managed.ts";
import { checkExit, fetchVerified, quiesce, replayPostgres, resume, runBackup, target as serviceTarget } from "./pipeline.ts";
import { backupKindFor, isServiceKind, scheduleDestinationId, type AppSnapshot } from "./requests.ts";
import { readAll } from "./context.ts";

export type UpgradePayload =
  | { action: "in_place"; sourceId: string; toImage: string; toVersion: string }
  | { action: "prepare"; sourceId: string; targetId: string; toVersion: string }
  | { action: "switch"; sourceId: string; targetId: string; quiesced?: string[]; resumedAt?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUpgradePayload(raw: unknown): UpgradePayload {
  const p = raw as Record<string, unknown> | null;
  const id = (k: string): string => {
    const v = p?.[k];
    if (typeof v !== "string" || !UUID.test(v)) throw new DataError(`job payload has no valid ${k}`, true);
    return v;
  };
  const text = (k: string): string => {
    const v = p?.[k];
    if (typeof v !== "string" || !v || v.length > 200) throw new DataError(`job payload has no valid ${k}`, true);
    return v;
  };
  switch (p?.action) {
    case "in_place": return { action: "in_place", sourceId: id("sourceId"), toImage: text("toImage"), toVersion: text("toVersion") };
    case "prepare": return { action: "prepare", sourceId: id("sourceId"), targetId: id("targetId"), toVersion: text("toVersion") };
    case "switch":
      return {
        action: "switch", sourceId: id("sourceId"), targetId: id("targetId"),
        ...(Array.isArray(p.quiesced) ? { quiesced: p.quiesced.filter((x): x is string => typeof x === "string" && UUID.test(x)) } : {}),
        ...(typeof p.resumedAt === "string" ? { resumedAt: p.resumedAt } : {}),
      };
    default: throw new DataError("job payload has no valid action", true);
  }
}

interface Counts { tables: number; rows: number }

/** Merges into the state the dashboard reads. Never holds a credential. */
async function setState(deps: Pick<DataDeps, "db" | "now">, sourceId: string, patch: Record<string, unknown>): Promise<void> {
  const row = await deps.db.app.findUnique({ where: { id: sourceId }, select: { serviceUpgrade: true } });
  const at = (deps.now?.() ?? new Date()).toISOString();
  const next = { ...((row?.serviceUpgrade as Record<string, unknown> | null) ?? {}), ...patch, at };
  await deps.db.app.update({ where: { id: sourceId }, data: { serviceUpgrade: next as Prisma.InputJsonValue } });
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1_000);

/** A dump of the source, its row settled by the same code every backup runs. Throws if it did not finish. */
async function freshBackup(deps: DataDeps, sourceId: string): Promise<string> {
  const app = await deps.db.app.findUnique({ where: { id: sourceId }, include: { environment: { include: { project: { select: { slug: true } } } } } });
  if (!app || !isServiceKind(app.kind)) throw new DataError("That service no longer exists", true);
  const snapshot: AppSnapshot = {
    name: app.name, kind: app.kind, projectSlug: app.environment.project.slug, environment: app.environment.name,
    environmentId: app.environmentId, image: app.image, pinnedImage: app.pinnedImage,
  };
  const row = await deps.db.backup.create({
    data: {
      appId: app.id, sourceAppId: app.id, appSnapshot: snapshot as unknown as Prisma.InputJsonValue, kind: backupKindFor(app.kind), trigger: "pre_update", status: "running",
      destinationId: await scheduleDestinationId(deps.db, app.id), encrypted: true,
    },
    select: { id: true },
  });
  await runBackup(deps, row.id, true);
  return row.id;
}

async function countsOf(deps: DataDeps, appId: string): Promise<Counts> {
  const t = await serviceTarget(deps, appId);
  const c = restoreCheckCommand(t.creds);
  const h = await deps.docker.exec(t.containerId, { cmd: c.cmd, env: c.env, stdin: false });
  const [out, res] = await Promise.all([readAll(h.stdout), h.done]);
  checkExit("the row count", res);
  return parseRestoreCheck(out);
}

/**
 * A dump of the target first if it already holds tables: it may have served apps before a switch
 * back, and what is about to replace them must stay recoverable. Never destroy data automatically.
 */
async function protectTarget(deps: DataDeps, targetId: string): Promise<void> {
  if ((await countsOf(deps, targetId)).tables > 0) await freshBackup(deps, targetId);
}

/** Replays one finished backup of the source over the target. The dump drops what it replaces, inside its transaction. */
async function replayInto(deps: DataDeps, backupId: string, targetId: string, cutOthers: boolean): Promise<void> {
  const backup = await deps.db.backup.findUnique({ where: { id: backupId } });
  if (!backup?.objectKey || backup.status !== "ready") throw new DataError("The backup did not finish", true);
  const tmp = await fetchVerified(deps, backup as typeof backup & { objectKey: string });
  try {
    const t = await serviceTarget(deps, targetId);
    await replayPostgres(deps, tmp, backup.id, t.containerId, t.creds, cutOthers);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Queues a redeploy on the running image, as an env change does: nothing is rebuilt, only the links resolve anew. */
async function redeployAll(tx: Prisma.TransactionClient, ids: string[]): Promise<void> {
  const now = new Date().toISOString();
  for (const id of ids) {
    const key = `deploy:${id}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const app = await tx.app.findUnique({ where: { id }, select: { desiredState: true, gitBranch: true, serverId: true, currentDeployment: { select: { imageId: true, imageRef: true, commitSha: true } } } });
    if (!app?.currentDeployment || app.desiredState !== "running") continue;
    const open = await tx.job.findFirst({ where: { dedupeKey: key, completedAt: null, failedAt: null }, select: { id: true } });
    if (open) {
      await tx.app.update({ where: { id }, data: { pendingDeployAt: new Date() } });
      continue;
    }
    const dep = await tx.deployment.create({
      data: {
        appId: id, serverId: app.serverId, trigger: "redeploy", branch: app.gitBranch, commitSha: app.currentDeployment.commitSha, message: "Database version changed",
        imageId: app.currentDeployment.imageId, imageRef: app.currentDeployment.imageRef, actorType: "system", actorName: "Dockify",
        steps: [{ id: "queued", status: "done", startedAt: now, finishedAt: now }],
      },
      select: { id: true },
    });
    await tx.job.create({ data: { kind: "deploy", lane: "deploy", serverId: app.serverId, payload: { deploymentId: dep.id, appId: id }, dedupeKey: key, maxAttempts: 3 } });
    await tx.app.update({ where: { id }, data: { status: "deploying", pendingDeployAt: null } });
  }
}

async function activity(deps: Pick<DataDeps, "db">, verb: string, app: { id: string; name: string }, suffix: string | null, failed = false): Promise<void> {
  await deps.db.activityLog
    .create({ data: { category: "system", action: "service.version", verb, actorType: "system", actorName: "Dockify", targetType: "app", targetId: app.id, targetLabel: app.name, failed, suffix: suffix?.slice(0, 300) ?? null } })
    .catch(() => {});
}

async function runInPlace(deps: DataDeps, p: Extract<UpgradePayload, { action: "in_place" }>): Promise<void> {
  const { db } = deps;
  const before = await db.app.findUnique({ where: { id: p.sourceId }, select: { id: true, name: true, image: true, pinnedImage: true } });
  if (!before) throw new DataError("That service no longer exists", true);
  await setState(deps, p.sourceId, { phase: "backing_up" });
  const backupId = await freshBackup(deps, p.sourceId);
  await setState(deps, p.sourceId, { phase: "upgrading", backupId });
  // Clearing the pin is what makes the managed deploy pull the tag again; a failure below puts both back.
  await db.app.update({ where: { id: p.sourceId }, data: { image: p.toImage, pinnedImage: null } });
  try {
    const out = await deployManagedService({ db, vault: deps.vault, docker: deps.docker, log: () => {} }, p.sourceId, { fromRestore: true });
    await db.app.update({ where: { id: p.sourceId }, data: { status: "running", desiredState: "running", containerId: out.containerId } });
    await setState(deps, p.sourceId, { phase: "done", pin: out.pin });
    await activity(deps, "changed the version of", before, `to ${p.toImage}. A backup was taken first.`);
  } catch (e) {
    await db.app.update({ where: { id: p.sourceId }, data: { image: before.image, pinnedImage: before.pinnedImage } });
    throw e;
  }
}

async function runPrepare(deps: DataDeps, p: Extract<UpgradePayload, { action: "prepare" }>): Promise<void> {
  const { db } = deps;
  const source = await db.app.findUnique({ where: { id: p.sourceId }, select: { id: true, name: true, kind: true } });
  const target = await db.app.findUnique({ where: { id: p.targetId }, select: { id: true, name: true, kind: true } });
  if (!source || !target) throw new DataError("One of the two services no longer exists", true);
  if (source.kind !== "postgres" || target.kind !== "postgres") throw new DataError("Only Postgres moves through a new service", true);
  await setState(deps, p.sourceId, { phase: "backing_up" });
  const backupId = await freshBackup(deps, p.sourceId);
  await setState(deps, p.sourceId, { phase: "copying", backupId });
  const out = await deployManagedService({ db, vault: deps.vault, docker: deps.docker, log: () => {} }, target.id, { fromRestore: true });
  await db.app.update({ where: { id: target.id }, data: { status: "running", desiredState: "running", containerId: out.containerId } });
  await protectTarget(deps, target.id);
  await replayInto(deps, backupId, target.id, false);
  const [from, to] = [await countsOf(deps, source.id), await countsOf(deps, target.id)];
  // Apps keep writing while this runs, so rows may differ until the switch. A table that did not arrive is a failed copy.
  if (to.tables < from.tables) throw new DataError(`The copy has ${to.tables} tables and the running database has ${from.tables}`, true);
  await setState(deps, p.sourceId, { phase: "ready", source: from, target: to, copiedAt: (deps.now?.() ?? new Date()).toISOString() });
  await activity(deps, "copied the data of", source, `to ${target.name}, ready to switch`);
}

async function runSwitch(deps: DataDeps, jobId: string, p: Extract<UpgradePayload, { action: "switch" }>): Promise<void> {
  const { db } = deps;
  const source = await db.app.findUnique({ where: { id: p.sourceId }, select: { id: true, name: true, kind: true, environmentId: true } });
  const target = await db.app.findUnique({ where: { id: p.targetId }, select: { id: true, name: true, environmentId: true } });
  if (!source || !target || source.environmentId !== target.environmentId) throw new DataError("One of the two services no longer exists", true);
  await setState(deps, p.sourceId, { phase: "switching" });
  // Written to the job before anything stops, so recovery can start them if this worker dies.
  const stopped = await quiesce(deps, jobId, p, source.environmentId);
  let switched = false;
  let linked: Array<{ id: string; name: string }> = [];
  try {
    const backupId = await freshBackup(deps, p.sourceId);
    await protectTarget(deps, target.id);
    await replayInto(deps, backupId, target.id, true);
    const [from, to] = [await countsOf(deps, source.id), await countsOf(deps, target.id)];
    if (from.tables !== to.tables || from.rows !== to.rows) {
      throw new DataError(`The copy does not match: ${from.tables} tables and ${from.rows} rows in ${source.name}, ${to.tables} and ${to.rows} in ${target.name}. Nothing was switched.`, true);
    }
    linked = await linkedApps(db, deps.vault, source);
    const at = (deps.now?.() ?? new Date()).toISOString();
    await db.$transaction(async (tx) => {
      const row = await tx.app.findUnique({ where: { id: source.id }, select: { serviceUpgrade: true } });
      await tx.app.update({
        where: { id: source.id },
        data: { serviceRedirectId: target.id, serviceUpgrade: { ...((row?.serviceUpgrade as Record<string, unknown> | null) ?? {}), phase: "switched", source: from, target: to, backupId, copiedAt: at, at } as unknown as Prisma.InputJsonValue },
      });
      await redeployAll(tx, linked.map((a) => a.id));
    });
    switched = true;
    await activity(deps, "switched the linked apps of", source, `to ${target.name}. ${source.name} keeps running with its data until you delete it.`);
  } finally {
    // A linked app starts through its redeploy, on the new database. Everything else, or everything after a failure, starts as it was.
    const skip = new Set(switched ? linked.map((a) => a.id) : []);
    await resume(deps, jobId, { ...p, quiesced: stopped }, stopped.filter((id) => !skip.has(id)));
  }
}

const STILL_WORKING = ["backing_up", "upgrading", "copying", "switching"];

/**
 * A worker that died mid-way never reached the handler's catch below, so the state keeps saying a
 * step is running with no job left to run it, and a switch could not be tried again. The job row knows
 * what it was doing. The api writes the phase and the job together, so a working phase with no open
 * job can only be this.
 */
export async function settleAbandonedUpgrades(deps: Pick<DataDeps, "db" | "now">): Promise<number> {
  const stuck = await deps.db.app.findMany({
    where: { OR: STILL_WORKING.map((phase) => ({ serviceUpgrade: { path: ["phase"], equals: phase } })) },
    select: { id: true, name: true },
  });
  let n = 0;
  for (const app of stuck) {
    const jobs = await deps.db.job.findMany({ where: { kind: "service_upgrade", dedupeKey: `service-upgrade:${app.id}` }, orderBy: { createdAt: "desc" }, take: 1, select: { payload: true, lastError: true, completedAt: true, failedAt: true } });
    const job = jobs[0];
    if (job && !job.completedAt && !job.failedAt) continue;
    const action = (job?.payload as { action?: unknown } | null)?.action;
    const error = job?.lastError ?? "The worker stopped before this finished.";
    await setState(deps, app.id, { phase: "failed", failedAt: typeof action === "string" ? action : "unknown", error });
    await activity(deps, "could not change the version of", app, error, true).catch(() => {});
    n++;
  }
  return n;
}

/** The job's handler. Whatever fails, the state says where and why, and no data was removed. */
export async function runServiceUpgrade(deps: DataDeps, jobId: string, payload: UpgradePayload): Promise<void> {
  try {
    if (payload.action === "in_place") await runInPlace(deps, payload);
    else if (payload.action === "prepare") await runPrepare(deps, payload);
    else await runSwitch(deps, jobId, payload);
  } catch (e) {
    await setState(deps, payload.sourceId, { phase: "failed", failedAt: payload.action, error: reason(e) }).catch(() => {});
    const src = await deps.db.app.findUnique({ where: { id: payload.sourceId }, select: { id: true, name: true } }).catch(() => null);
    if (src) await activity(deps, "could not change the version of", src, reason(e), true);
    throw e;
  }
}
