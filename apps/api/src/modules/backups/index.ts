/**
 * Backups: schedules, runs, restore, restore tests, orphans and download. Long work (dumps,
 * restores, tests) is queued on the worker's data lane; these handlers validate, queue and report.
 *
 * The route policies live in policy.ts; every handler here also re-checks role-independent facts (the app is a
 * service, the backup is restorable, a token's project limit).
 */
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream";
import { defaultServerId, enqueue, generateServiceCredentials, readSecretValue, sealServiceCredentials, type Db, type Prisma, type Tx } from "@dockify/db";
import { assertProjectScope, meta, tokenProjectLimit, type Actor } from "../../actor.ts";
import type { EndpointId } from "@dockify/contracts";
import type { Ctx, Handler, Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError, isUniqueViolation } from "../../errors.ts";
import { WORKER_SILENT_MS } from "../platform/server.ts";
import { DEFAULT_CRON, toRun, toSchedule, type BackupRowIn, type DestinationRow, type ScheduleAppIn } from "./map.ts";
import {
  ALGORITHM, backupKeyFingerprint, CronError, DataError, DecryptStream, dataPathFor, isRetentionDecrease,
  isServiceKind, LOCAL_FLAG, localBackupsAllowed, nextRun, parseBackupKey, parseCron, publicOnlyGuard, RequestError, requestBackup,
  requestRestore, requestRestoreTest, resolveStore, SERVICE_IMAGES, SERVICE_KINDS, SERVICE_PORTS, STORAGE_UNAVAILABLE, volumeNameFor,
  type AppSnapshot, type ServiceKind,
} from "./shared.ts";

export interface BackupsOptions {
  localRoot: string;
  guard: (hostname: string) => Promise<void>;
  /** How long a restore request waits for the job before answering. */
  restoreWaitMs: number;
  pollMs: number;
  env: NodeJS.ProcessEnv;
}

export const defaultBackupsOptions = (env: NodeJS.ProcessEnv = process.env): BackupsOptions => ({
  localRoot: env.DOCKIFY_BACKUP_DIR?.trim() || "/var/lib/dockify/backups",
  guard: publicOnlyGuard,
  restoreWaitMs: 90_000,
  pollMs: 1_000,
  env,
});

const BACKUP_INCLUDE = { destination: { include: { integration: true } } } as const;
const SCHEDULE_INCLUDE = {
  environment: { include: { project: { select: { slug: true } } } },
  backupDestination: { include: { integration: true } },
} as const;

const actorFields = (a: Actor | null) => ({ actorType: (a?.kind === "token" ? "token" : "user") as "token" | "user", actorId: a?.kind === "token" ? a.tokenId : (a?.userId ?? null), actorName: a?.name ?? null });

function fromRequestError(e: unknown): never {
  if (e instanceof RequestError) throw new HttpError(e.status, e.message, e.code);
  if (e instanceof DataError) throw new HttpError(409, e.message, "BACKUP_UNAVAILABLE");
  throw e;
}

/** A token limited to projects sees only those projects' backups. */
function projectFilter(actor: Actor | null): string[] | null {
  return tokenProjectLimit(actor);
}

async function instanceFingerprint(ctx: Ctx): Promise<{ fingerprint: string | null; createdAt: Date | null }> {
  const inst = await ctx.db.instance.findUnique({ where: { id: 1 }, select: { backupKey: { select: { id: true, createdAt: true } } } });
  if (!inst?.backupKey) return { fingerprint: null, createdAt: null };
  const raw = await readSecretValue(ctx.db, ctx.ring, inst.backupKey.id);
  return { fingerprint: raw ? backupKeyFingerprint(parseBackupKey(raw)) : null, createdAt: inst.backupKey.createdAt };
}

async function defaultDestination(db: Tx): Promise<DestinationRow | null> {
  return (await db.backupDestination.findFirst({ where: { isDefault: true }, include: { integration: true } })) as DestinationRow | null;
}

async function loadServiceApp(ctx: Ctx, actor: Actor | null, id: string) {
  const app = await ctx.db.app.findUnique({ where: { id }, include: SCHEDULE_INCLUDE });
  if (!app) throw new HttpError(404, "That app does not exist", "NOT_FOUND");
  if (actor) assertProjectScope(actor, app.environment.projectId);
  if (!isServiceKind(app.kind)) throw new HttpError(400, "Only Postgres, Redis and storage services have backups", "NOT_A_SERVICE");
  return app;
}

async function loadBackup(ctx: Ctx, actor: Actor | null, id: string) {
  const b = await ctx.db.backup.findUnique({ where: { id }, include: { ...BACKUP_INCLUDE, app: { select: { environment: { select: { projectId: true } } } } } });
  if (!b) throw new HttpError(404, "That backup does not exist", "NOT_FOUND");
  if (actor && b.app) assertProjectScope(actor, b.app.environment.projectId);
  return b;
}

function assertRestorable(b: { status: string; objectKey: string | null; expiredAt: Date | null }): void {
  if (b.status !== "ready" || !b.objectKey) throw new HttpError(409, "Only a finished backup can be restored", "NOT_READY");
  if (b.expiredAt) throw new HttpError(409, "This backup has expired and its file was removed", "EXPIRED");
}

async function configPayload(ctx: Ctx, fingerprint: { fingerprint: string | null; createdAt: Date | null }) {
  const dests = await ctx.db.backupDestination.findMany({ where: { type: "s3" }, include: { integration: true }, orderBy: { createdAt: "asc" } });
  const inst = await ctx.db.instance.findUnique({ where: { id: 1 }, select: { restoreTestCron: true } });
  let nextRunAt: string | null = null;
  try {
    if (inst?.restoreTestCron) nextRunAt = nextRun(inst.restoreTestCron, "UTC").toISOString();
  } catch {
    nextRunAt = null;
  }
  return {
    destinations: dests.map((d) => {
      const cfg = (d.integration?.config ?? {}) as { provider?: string; bucket?: string };
      const provider = (["r2", "s3", "minio", "custom"].includes(cfg.provider ?? "") ? cfg.provider : "custom") as "r2" | "s3" | "minio" | "custom";
      return {
        id: d.id,
        name: d.name,
        provider,
        bucket: cfg.bucket ?? "",
        isDefault: d.isDefault,
        lastTestedAt: d.integration?.lastCheckedAt?.toISOString() ?? null,
        error: d.integration?.error ?? null,
      };
    }),
    encryption: { enabled: true, algorithm: ALGORITHM, fingerprint: fingerprint.fingerprint, createdAt: fingerprint.createdAt?.toISOString() ?? null },
    restoreTests: { cron: inst?.restoreTestCron ?? "0 4 * * 0", nextRunAt },
  };
}

/**
 * Creates a managed service app for a restore into a new database: fresh credentials sealed in the
 * shared JSON shape (@dockify/db), its named volume row, and the image tag the backup's server ran,
 * so the dump replays into the same Postgres or Redis version. The restore job then starts it
 * through the managed deploy (worker data/managed.ts), like every service.
 */
export async function createServiceApp(tx: Tx, ring: Ctx["ring"], input: { environmentId: string; name: string; kind: ServiceKind; image?: string | null }): Promise<string> {
  if (input.kind === "s3") throw new HttpError(409, STORAGE_UNAVAILABLE, "KIND_UNAVAILABLE");
  const id = randomUUID();
  await tx.app.create({
    data: { id, environmentId: input.environmentId, serverId: await defaultServerId(tx), name: input.name, kind: input.kind, image: input.image || SERVICE_IMAGES[input.kind], port: SERVICE_PORTS[input.kind], desiredState: "running" },
  });
  const secretId = await sealServiceCredentials(tx, ring, id, generateServiceCredentials(input.kind, input.name));
  await tx.app.update({ where: { id }, data: { passwordSecretId: secretId } });
  await tx.volume.create({ data: { appId: id, name: volumeNameFor(id), mountPath: dataPathFor(input.kind) } });
  return id;
}

/** Call before deleting an app: its backups stay, marked with when their app went away. */
export async function markBackupsOrphaned(tx: Tx, appId: string, at: Date = new Date()): Promise<void> {
  await tx.$executeRaw`UPDATE backups SET "appSnapshot" = "appSnapshot" || jsonb_build_object('deletedAt', ${at.toISOString()}::text) WHERE "appId" = ${appId}::uuid`;
}

const KIND_FOR: Record<string, ServiceKind> = { postgres: "postgres", redis: "redis", volume: "s3" };

async function createRestoreTarget(ctx: Ctx, backup: { kind: string; appId: string | null; appSnapshot: unknown }, name: string): Promise<string> {
  const kind = KIND_FOR[backup.kind];
  if (!kind) throw new HttpError(400, "This kind of backup cannot be restored into a new service", "NOT_RESTORABLE");
  if (kind === "s3") throw new HttpError(409, STORAGE_UNAVAILABLE, "KIND_UNAVAILABLE");
  const snap = (backup.appSnapshot ?? {}) as Partial<AppSnapshot>;
  let environmentId: string | null = null;
  let image: string | null = snap.image ?? null;
  if (backup.appId) {
    const source = await ctx.db.app.findUnique({ where: { id: backup.appId }, select: { environmentId: true, image: true } });
    environmentId = source?.environmentId ?? null;
    image = source?.image ?? image;
  }
  if (!environmentId && snap.environmentId) environmentId = (await ctx.db.environment.findUnique({ where: { id: snap.environmentId }, select: { id: true } }))?.id ?? null;
  if (!environmentId && snap.projectSlug && snap.environment) {
    environmentId = (await ctx.db.environment.findFirst({ where: { name: snap.environment, project: { slug: snap.projectSlug } }, select: { id: true } }))?.id ?? null;
  }
  if (!environmentId) throw new HttpError(409, "The environment this backup came from no longer exists. Recreate it, then restore.", "NO_ENVIRONMENT");
  try {
    return await ctx.db.$transaction((tx) => createServiceApp(tx, ctx.ring, { environmentId: environmentId!, name, kind, image }));
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, `An app named ${name} already exists in that environment`, "NAME_TAKEN", { field: "name" });
    throw e;
  }
}

/** What the worker's backup_delete job left on its own row. */
function deleteResult(payload: unknown): { deleted: number; freedBytes: number; failed: number } {
  const r = (payload as { result?: { deleted?: unknown; freedBytes?: unknown; failed?: unknown } } | null)?.result;
  const n = (v: unknown) => (typeof v === "number" && v >= 0 ? v : 0);
  return { deleted: n(r?.deleted), freedBytes: n(r?.freedBytes), failed: n(r?.failed) };
}

async function waitForJob(db: Db, jobId: string, opts: BackupsOptions): Promise<{ completedAt: Date | null; failedAt: Date | null; lastError: string | null; payload: unknown }> {
  const deadline = Date.now() + opts.restoreWaitMs;
  for (;;) {
    const j = await db.job.findUnique({ where: { id: jobId }, select: { completedAt: true, failedAt: true, lastError: true, payload: true } });
    if (!j || j.completedAt || j.failedAt) return j ?? { completedAt: null, failedAt: new Date(), lastError: "The job disappeared", payload: null };
    if (Date.now() > deadline) return j;
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}

/** What a finished restore answers, by the database that now holds the data. */
async function restoreOutcome(ctx: Ctx, snap: Partial<AppSnapshot>, targetAppId: string, finishedAt: Date) {
  const target = await ctx.db.app.findUnique({ where: { id: targetAppId }, include: { environment: { include: { project: { select: { slug: true } } } } } });
  return {
    ok: true as const,
    finishedAt: finishedAt.toISOString(),
    database: {
      name: target?.name ?? snap.name ?? "",
      projectSlug: target?.environment.project.slug ?? snap.projectSlug ?? "",
      environment: target?.environment.name ?? snap.environment ?? "",
      deletedAt: null,
      resourceId: targetAppId,
    },
  };
}

export function createBackupsHandlers(opts: BackupsOptions = defaultBackupsOptions()): Handlers {
  const storeOpts = { localRoot: opts.localRoot, guard: opts.guard, env: opts.env };

  const listRuns = async (ctx: Ctx, where: Prisma.BackupWhereInput, take = 200) =>
    // The control plane's own pre-update dumps belong to the Server page, not to a database's runs.
    (await ctx.db.backup.findMany({ where: { AND: [where, { kind: { not: "control_plane" } }] }, include: BACKUP_INCLUDE, orderBy: { createdAt: "desc" }, take })).map((b) => toRun(b as unknown as BackupRowIn));

  const handlers: { [K in EndpointId]?: Handler<K> } = {
    "backups.list": async ({ ctx, actor }) => {
      const projects = projectFilter(actor);
      return listRuns(ctx, projects ? { app: { environment: { projectId: { in: projects } } } } : {}, 500);
    },

    "backups.schedules": async ({ ctx, actor }) => {
      const projects = projectFilter(actor);
      const apps = await ctx.db.app.findMany({
        where: { kind: { in: [...SERVICE_KINDS] }, ...(projects ? { environment: { projectId: { in: projects } } } : {}) },
        include: SCHEDULE_INCLUDE,
        orderBy: { name: "asc" },
      });
      const fp = await instanceFingerprint(ctx);
      const fallback = await defaultDestination(ctx.db);
      return apps.map((a) => toSchedule(a as unknown as ScheduleAppIn, fp.fingerprint, fallback));
    },

    "backups.config": async ({ ctx }) => configPayload(ctx, await instanceFingerprint(ctx)),

    "backups.schedules.patch": async ({ ctx, actor, params, body, req }) => {
      const app = await loadServiceApp(ctx, actor, params.id);
      const data: Prisma.AppUpdateInput = {};
      if (body.cron !== undefined) {
        try {
          parseCron(body.cron);
        } catch (e) {
          throw new HttpError(400, e instanceof CronError ? e.message : "Not a valid cron expression", "INVALID_CRON", { field: "cron" });
        }
        data.backupCron = body.cron;
      }
      if (body.retentionDays !== undefined) data.backupRetentionDays = body.retentionDays;
      if (body.enabled !== undefined) {
        data.backupEnabled = body.enabled;
        if (body.enabled && !app.backupCron && body.cron === undefined) data.backupCron = DEFAULT_CRON;
      }
      if (body.destination !== undefined) {
        if (body.destination === "local") {
          // The same rule a manual run follows: this server's disk unless the owner turned it off.
          if (!localBackupsAllowed(opts.env)) throw new HttpError(409, `Local backups are turned off on this server (${LOCAL_FLAG}=0). Remove that setting to allow them.`, "LOCAL_DISABLED", { field: "destination" });
          const local = await ctx.db.backupDestination.upsert({ where: { name: "This server" }, update: {}, create: { name: "This server", type: "local" } });
          data.backupDestination = { connect: { id: local.id } };
        } else if (body.destination === "s3") {
          const d = await ctx.db.backupDestination.findFirst({ where: { type: "s3" }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
          if (!d) throw new HttpError(409, "Add an S3 compatible storage destination first", "NO_DESTINATION", { field: "destination" });
          data.backupDestination = { connect: { id: d.id } };
        } else {
          const d = await ctx.db.backupDestination.findUnique({ where: { id: body.destination } });
          if (!d) throw new HttpError(404, "That backup destination does not exist", "NOT_FOUND", { field: "destination" });
          data.backupDestination = { connect: { id: d.id } };
        }
      }
      const updated = await ctx.db.app.update({ where: { id: app.id }, data, include: SCHEDULE_INCLUDE });
      const decrease = isRetentionDecrease(
        { retentionDays: app.backupRetentionDays, enabled: app.backupEnabled },
        { retentionDays: updated.backupRetentionDays, enabled: updated.backupEnabled },
      );
      await audit(ctx.db, {
        category: "config",
        action: "backup.schedule.update",
        verb: decrease ? "reduced backup retention for" : "changed the backup schedule of",
        ...actorFields(actor),
        targetType: "app",
        targetId: app.id,
        targetLabel: app.name,
        ...meta(req),
        changes: [
          ["enabled", app.backupEnabled, updated.backupEnabled],
          ["cron", app.backupCron, updated.backupCron],
          ["retentionDays", app.backupRetentionDays, updated.backupRetentionDays],
          ["destination", app.backupDestinationId, updated.backupDestinationId],
        ]
          .filter(([, a, b]) => a !== b)
          .map(([key, before, after]) => ({ key, before, after })) as Prisma.InputJsonValue,
      });
      const fp = await instanceFingerprint(ctx);
      return toSchedule(updated as unknown as ScheduleAppIn, fp.fingerprint, await defaultDestination(ctx.db));
    },

    "backups.run": async ({ ctx, actor, body, req }) => {
      let ids: string[];
      if (body.resourceId) {
        ids = [(await loadServiceApp(ctx, actor, body.resourceId)).id];
      } else {
        const projects = projectFilter(actor);
        ids = (
          await ctx.db.app.findMany({
            where: { kind: { in: [...SERVICE_KINDS] }, desiredState: "running", ...(projects ? { environment: { projectId: { in: projects } } } : {}) },
            select: { id: true },
          })
        ).map((a) => a.id);
      }
      const backupIds: string[] = [];
      for (const id of ids) {
        try {
          backupIds.push((await requestBackup(ctx.db, id, "manual")).backupId);
        } catch (e) {
          if (ids.length === 1) fromRequestError(e);
        }
      }
      await audit(ctx.db, { category: "system", action: "backup.run", verb: "started a backup of", ...actorFields(actor), targetType: "backup", targetLabel: body.resourceId ? `1 database` : `${backupIds.length} databases`, ...meta(req) });
      return { runs: await listRuns(ctx, { id: { in: backupIds } }) };
    },

    "backups.restore": async ({ ctx, actor, params, body, req, reply }) => {
      const b = await loadBackup(ctx, actor, params.id);
      assertRestorable(b);
      const snap = (b.appSnapshot ?? {}) as Partial<AppSnapshot>;
      let targetAppId: string;
      if (body.mode === "replace") {
        if (!b.appId) throw new HttpError(409, "The app this backup came from was deleted. Restore it into a new database instead.", "ORPHANED");
        const app = await loadServiceApp(ctx, actor, b.appId);
        // The same text the dialog asks for (web components/server-backups/util.ts dbRef).
        const ref = `${app.environment.project.slug}/${app.name}`;
        if (body.confirm !== ref) throw new HttpError(400, `Type ${ref} to confirm replacing its data`, "CONFIRM_MISMATCH", { field: "confirm" });
        targetAppId = app.id;
      } else {
        targetAppId = await createRestoreTarget(ctx, b, body.name);
      }
      const jobId = await requestRestore(ctx.db, { backupId: b.id, mode: body.mode, targetAppId }).catch(fromRequestError);
      await audit(ctx.db, {
        category: "system",
        action: "backup.restore",
        verb: body.mode === "replace" ? "started restoring a backup over" : "started restoring a backup into",
        ...actorFields(actor),
        targetType: "app",
        targetId: targetAppId,
        targetLabel: body.mode === "replace" ? (snap.name ?? null) : body.name,
        ...meta(req),
      });
      const j = await waitForJob(ctx.db, jobId, opts);
      if (j.failedAt) throw new HttpError(422, j.lastError ?? "The restore failed", "RESTORE_FAILED");
      if (!j.completedAt) {
        // Outlasted the request: answer 202 and let the web poll the backup or the resource.
        void reply.code(202);
        return { jobId, resourceId: targetAppId, status: "queued" as const };
      }
      return restoreOutcome(ctx, snap, targetAppId, j.completedAt);
    },

    "backups.restoreStatus": async ({ ctx, actor, params }) => {
      const b = await loadBackup(ctx, actor, params.id);
      const j = await ctx.db.job.findFirst({ where: { id: params.jobId, kind: "restore", payload: { path: ["backupId"], equals: b.id } }, select: { completedAt: true, failedAt: true, lastError: true, payload: true } });
      if (!j) throw new HttpError(404, "That restore does not exist", "NOT_FOUND");
      if (j.failedAt) return { status: "failed" as const, error: j.lastError };
      if (!j.completedAt) return { status: "running" as const, error: null };
      const targetAppId = (j.payload as { targetAppId?: string }).targetAppId ?? b.appId ?? "";
      return restoreOutcome(ctx, (b.appSnapshot ?? {}) as Partial<AppSnapshot>, targetAppId, j.completedAt);
    },

    "backups.test": async ({ ctx, actor, params, req }) => {
      const b = await loadBackup(ctx, actor, params.id);
      assertRestorable(b);
      await requestRestoreTest(ctx.db, b.id);
      await audit(ctx.db, { category: "system", action: "backup.test", verb: "started a restore test of", ...actorFields(actor), targetType: "backup", targetId: b.id, targetLabel: (b.appSnapshot as Partial<AppSnapshot>)?.name ?? null, ...meta(req) });
      const [run] = await listRuns(ctx, { id: b.id }, 1);
      return run!;
    },

    "backups.orphans.delete": async ({ ctx, actor, params, req }) => {
      const live = await ctx.db.app.findUnique({ where: { id: params.resourceId }, select: { id: true } });
      if (live) throw new HttpError(409, "That app still exists; its backups are not orphaned", "NOT_ORPHANED");
      const rows = await ctx.db.backup.count({ where: { sourceAppId: params.resourceId, appId: null } });
      if (!rows) throw new HttpError(404, "There are no orphaned backups for that app", "NOT_FOUND");
      // The worker deletes: this process mounts the backups volume read-only (worker data/orphans.ts).
      const seen = await ctx.db.instance.findUnique({ where: { id: 1 }, select: { workerSeenAt: true } });
      if (!seen?.workerSeenAt || Date.now() - seen.workerSeenAt.getTime() > WORKER_SILENT_MS) {
        throw new HttpError(503, "The worker is not running, so nothing can be deleted right now", "WORKER_DOWN");
      }
      const key = `backup-delete:${params.resourceId}`;
      const jobId = await enqueue(ctx.db, { kind: "backup_delete", lane: "maintenance", payload: { sourceAppId: params.resourceId }, dedupeKey: key, maxAttempts: 1 });
      const j = await waitForJob(ctx.db, jobId, opts);
      if (j.failedAt) throw new HttpError(502, `The backups could not be deleted: ${j.lastError ?? "the worker gave no reason"}`, "DELETE_FAILED");
      if (!j.completedAt) throw new HttpError(504, "The worker is still deleting these backups. The list updates when it finishes.", "DELETE_PENDING");
      const result = deleteResult(j.payload);
      await audit(ctx.db, { category: "system", action: "backup.orphans.delete", verb: "deleted orphaned backups of", ...actorFields(actor), targetType: "app", targetId: params.resourceId, suffix: `${result.deleted} files, ${result.freedBytes} bytes${result.failed ? `, ${result.failed} could not be deleted` : ""}`, ...meta(req) });
      if (!result.deleted && result.failed) throw new HttpError(502, "The backup files could not be deleted; they stay listed so they can be tried again", "DELETE_FAILED");
      return { deleted: result.deleted, freedBytes: result.freedBytes };
    },

    "backups.download": async ({ ctx, actor, params, req, reply }) => {
      const b = await loadBackup(ctx, actor, params.id);
      assertRestorable(b);
      const dest = await resolveStore(ctx.db, ctx.ring, b.destinationId, storeOpts).catch(fromRequestError);
      const inst = await ctx.db.instance.findUnique({ where: { id: 1 }, select: { backupKeySecretId: true } });
      const raw = inst?.backupKeySecretId ? await readSecretValue(ctx.db, ctx.ring, inst.backupKeySecretId) : null;
      if (!raw) throw new HttpError(409, "The backup key is missing on this server", "NO_BACKUP_KEY");
      const key = parseBackupKey(raw);
      const source = await dest.store.get(b.objectKey!).catch((e: unknown) => {
        throw new HttpError(502, `The backup file could not be fetched: ${e instanceof Error ? e.message : String(e)}`, "STORAGE_ERROR");
      });
      const snap = (b.appSnapshot ?? {}) as Partial<AppSnapshot>;
      const ext = b.kind === "postgres" ? "sql.gz" : b.kind === "redis" ? "rdb.gz" : "tar.gz";
      const fileName = `${(snap.name ?? "backup").replace(/[^a-z0-9-]/gi, "")}-${b.createdAt.toISOString().replace(/[-:]/g, "").slice(0, 15)}.${ext}`;
      await audit(ctx.db, { category: "access", action: "backup.download", verb: "downloaded a backup of", ...actorFields(actor), targetType: "backup", targetId: b.id, targetLabel: snap.name ?? null, ...meta(req) });
      reply.header("Content-Type", "application/gzip");
      reply.header("Content-Disposition", `attachment; filename="${fileName}"`);
      // Decrypted on the way out: the owner gets a plain gzip, the stored copy stays ciphertext.
      // A tampered or cut file fails mid-stream and the download aborts rather than ending short.
      const out = new DecryptStream(key, b.id);
      pipeline(source, out, () => {});
      return out as never;
    },

    "apps.backups": async ({ ctx, actor, params }) => {
      const app = await ctx.db.app.findUnique({ where: { id: params.id }, include: SCHEDULE_INCLUDE });
      if (!app) throw new HttpError(404, "That app does not exist", "NOT_FOUND");
      if (actor) assertProjectScope(actor, app.environment.projectId);
      if (!isServiceKind(app.kind)) return { schedule: null, runs: [], config: null };
      const fp = await instanceFingerprint(ctx);
      return {
        schedule: toSchedule(app as unknown as ScheduleAppIn, fp.fingerprint, await defaultDestination(ctx.db)),
        runs: await listRuns(ctx, { sourceAppId: app.id }, 100),
        config: await configPayload(ctx, fp),
      };
    },
  };
  return handlers as Handlers;
}

export const backupsHandlers: Handlers = createBackupsHandlers();
