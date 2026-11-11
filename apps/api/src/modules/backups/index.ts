// Long work (dumps, restores, tests) runs on the worker's data lane; these handlers validate, queue and report.
// Route policies live in policy.ts. Handlers here re-check role-independent facts: the app is a service, the backup is restorable, a token's project limit.
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream";
import { defaultServerId, enqueue, generateServiceCredentials, readSecretValue, sealServiceCredentials, type Db, type Prisma, type Tx } from "@dockify/db";
import { assertProjectScope, meta, roleAtLeast, tokenProjectLimit, type Actor } from "../../actor.ts";
import type { EndpointId } from "@dockify/contracts";
import type { Ctx, Handler, Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError, isUniqueViolation } from "../../errors.ts";
import { nameShownElsewhere } from "../apps/display-name.ts";
import { WORKER_SILENT_MS } from "../platform/server.ts";
import { limitRun, limitSchedule, toRun, toSchedule, type BackupRowIn, type DestinationRow, type ScheduleAppIn, type ScheduleContext } from "./map.ts";
import {
  ALGORITHM, backupKeyFingerprint, bothTiers, CronError, DataError, DecryptStream, DEFAULT_CRON, dataPathFor, enabledTiers, isRetentionDecrease,
  isServiceKind, loadTiers, LOCAL_FLAG, localBackupsAllowed, nextRun, parseBackupKey, parseCron, primaryTier, publicOnlyGuard, RequestError, requestBackup,
  requestRestore, requestRestoreTest, resolveStore, SERVICE_IMAGES, SERVICE_KINDS, SERVICE_PORTS, STORAGE_UNAVAILABLE, volumeNameFor,
  type AppSnapshot, type ServiceKind, type Tier, type TierRow,
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

const BACKUP_INCLUDE = { destination: { include: { integration: true } }, app: { select: { displayName: true } } } as const;
const SCHEDULE_INCLUDE = {
  environment: { include: { project: { select: { slug: true } } } },
  backupSchedules: true,
} as const;

const actorFields = (a: Actor | null) => ({ actorType: (a?.kind === "token" ? "token" : "user") as "token" | "user", actorId: a?.kind === "token" ? a.tokenId : (a?.userId ?? null), actorName: a?.name ?? null });

function fromRequestError(e: unknown): never {
  if (e instanceof RequestError) throw new HttpError(e.status, e.message, e.code);
  if (e instanceof DataError) throw new HttpError(409, e.message, "BACKUP_UNAVAILABLE");
  throw e;
}

const HISTORY_MS = 30 * 86_400_000;
const HISTORY_CAP = 1000;

/** Destination names, buckets, provider errors and the key fingerprint are an admin's (a read token acts as a Viewer). */
const readsStorage = (a: Actor | null): boolean => !!a && roleAtLeast(a.role, "admin");

function projectFilter(actor: Actor | null): string[] | null {
  return tokenProjectLimit(actor);
}

async function instanceFingerprint(ctx: Ctx): Promise<{ fingerprint: string | null; createdAt: Date | null }> {
  const inst = await ctx.db.instance.findUnique({ where: { id: 1 }, select: { backupKey: { select: { id: true, createdAt: true } } } });
  if (!inst?.backupKey) return { fingerprint: null, createdAt: null };
  const raw = await readSecretValue(ctx.db, ctx.ring, inst.backupKey.id);
  return { fingerprint: raw ? backupKeyFingerprint(parseBackupKey(raw)) : null, createdAt: inst.backupKey.createdAt };
}

async function scheduleContext(ctx: Ctx, env: NodeJS.ProcessEnv, fingerprint?: string | null): Promise<ScheduleContext> {
  const s3 = (await ctx.db.backupDestination.findMany({ where: { type: "s3" }, include: { integration: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] })) as DestinationRow[];
  const def = await ctx.db.backupDestination.findFirst({ where: { isDefault: true }, select: { type: true } });
  return { fingerprint: fingerprint !== undefined ? fingerprint : (await instanceFingerprint(ctx)).fingerprint, s3, defaultType: def?.type ?? null, localAllowed: localBackupsAllowed(env) };
}

/** The tiers one Back up now writes: the one asked for, both, else every tier that is on, else where the schedule points. */
async function tiersToRun(db: Tx, appId: string, asked: "local" | "offsite" | "both" | undefined): Promise<Tier[]> {
  if (asked === "both") return ["local", "offsite"];
  if (asked) return [asked];
  const tiers = await loadTiers(db, appId);
  const on = enabledTiers(tiers);
  if (on.length) return on;
  const def = await db.backupDestination.findFirst({ where: { isDefault: true }, select: { type: true } });
  return [primaryTier(tiers, def?.type ?? null)];
}

const policyOf = (r: TierRow) => ({ keep: r.keep, keepDays: r.keepDays, enabled: r.enabled });

async function loadServiceApp(ctx: Ctx, actor: Actor | null, id: string) {
  const app = await ctx.db.app.findUnique({ where: { id }, include: SCHEDULE_INCLUDE });
  if (!app) throw new HttpError(404, "That app does not exist", "NOT_FOUND");
  if (actor) assertProjectScope(actor, app.environment.projectId);
  if (!isServiceKind(app.kind)) throw new HttpError(400, "Only Postgres, Redis and storage services have backups", "NOT_A_SERVICE");
  return app;
}

async function loadBackup(ctx: Ctx, actor: Actor | null, id: string) {
  const b = await ctx.db.backup.findUnique({ where: { id }, include: { ...BACKUP_INCLUDE, app: { select: { environment: { select: { projectId: true } } } } } });
  // Dockify's own dump is the updater's: never restored, tested or downloaded as an app's backup.
  if (!b || b.kind === "control_plane") throw new HttpError(404, "That backup does not exist", "NOT_FOUND");
  if (actor && b.app) assertProjectScope(actor, b.app.environment.projectId);
  return b;
}

function assertRestorable(b: { status: string; objectKey: string | null; expiredAt: Date | null }): void {
  if (b.status !== "ready" || !b.objectKey) throw new HttpError(409, "Only a finished backup can be restored", "NOT_READY");
  if (b.expiredAt) throw new HttpError(409, "This backup has expired and its file was removed", "EXPIRED");
}

async function configPayload(ctx: Ctx, fingerprint: { fingerprint: string | null; createdAt: Date | null }, full: boolean) {
  const dests = full ? await ctx.db.backupDestination.findMany({ where: { type: "s3" }, include: { integration: true }, orderBy: { createdAt: "asc" } }) : [];
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
    encryption: { enabled: true, algorithm: ALGORITHM, fingerprint: full ? fingerprint.fingerprint : null, createdAt: fingerprint.createdAt?.toISOString() ?? null },
    restoreTests: { cron: inst?.restoreTestCron ?? "0 4 * * 0", nextRunAt },
  };
}

/** For a restore into a new database. It takes the image tag the backup's server ran, so the dump replays into the same Postgres or Redis version. */
export async function createServiceApp(tx: Tx, ring: Ctx["ring"], input: { environmentId: string; name: string; kind: ServiceKind; image?: string | null }): Promise<string> {
  if (input.kind === "s3") throw new HttpError(409, STORAGE_UNAVAILABLE, "KIND_UNAVAILABLE");
  // No two apps of an environment look alike: another one may already show this name.
  const shown = await tx.app.findFirst({ where: { environmentId: input.environmentId, displayName: { equals: input.name, mode: "insensitive" } }, select: { name: true, displayName: true } });
  if (shown) throw nameShownElsewhere(input.name, shown, "name");
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

  // The control plane's own pre-update dumps belong to the Server page, not to a database's runs.
  const NOT_OWN: Prisma.BackupWhereInput = { kind: { not: "control_plane" } };
  const listRuns = async (ctx: Ctx, where: Prisma.BackupWhereInput, take: number | null = 200) =>
    (await ctx.db.backup.findMany({ where: { AND: [where, NOT_OWN] }, include: BACKUP_INCLUDE, orderBy: { createdAt: "desc" }, take: take ?? undefined })).map((b) => toRun(b as unknown as BackupRowIn));

  const handlers: { [K in EndpointId]?: Handler<K> } = {
    "backups.list": async ({ ctx, actor }) => {
      const projects = projectFilter(actor);
      const scope: Prisma.BackupWhereInput = projects ? { app: { environment: { projectId: { in: projects } } } } : {};
      const since = new Date(Date.now() - HISTORY_MS);
      // The newest finished run of each database on each destination, however old: a weekly one must not read "No backup yet".
      const newest = await ctx.db.backup.groupBy({
        by: ["appId", "destinationId"],
        where: { AND: [scope, NOT_OWN, { appId: { not: null }, status: { not: "running" }, createdAt: { lt: since } }] },
        _max: { createdAt: true },
      });
      const [recent, rest] = await Promise.all([
        listRuns(ctx, { AND: [scope, { createdAt: { gte: since } }] }, HISTORY_CAP),
        // Outside the window, or past its cap: every file still kept (the size total), every orphan, and those newest runs.
        listRuns(
          ctx,
          {
            AND: [
              scope,
              {
                OR: [
                  { status: "ready", expiredAt: null },
                  { appId: null },
                  ...newest.flatMap((n) => (n._max.createdAt ? [{ appId: n.appId, destinationId: n.destinationId, createdAt: n._max.createdAt }] : [])),
                ],
              },
            ],
          },
          null,
        ),
      ]);
      const seen = new Set(recent.map((r) => r.id));
      const runs = [...recent, ...rest.filter((r) => !seen.has(r.id))].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return readsStorage(actor) ? runs : runs.map(limitRun);
    },

    "backups.schedules": async ({ ctx, actor }) => {
      const projects = projectFilter(actor);
      const apps = await ctx.db.app.findMany({
        where: { kind: { in: [...SERVICE_KINDS] }, ...(projects ? { environment: { projectId: { in: projects } } } : {}) },
        include: SCHEDULE_INCLUDE,
        orderBy: { name: "asc" },
      });
      const c = await scheduleContext(ctx, opts.env);
      const schedules = apps.map((a) => toSchedule(a as unknown as ScheduleAppIn, c));
      return readsStorage(actor) ? schedules : schedules.map(limitSchedule);
    },

    "backups.config": async ({ ctx, actor }) => configPayload(ctx, await instanceFingerprint(ctx), readsStorage(actor)),

    "backups.schedules.patch": async ({ ctx, actor, params, body, req }) => {
      const app = await loadServiceApp(ctx, actor, params.id);
      const c = await scheduleContext(ctx, opts.env);
      const tiers = bothTiers(app.backupSchedules);
      const primary = primaryTier(tiers, c.defaultType);

      // A destination id names its tier by its type; "local" and "s3" name theirs.
      let destId: string | null | undefined;
      let destTier: Tier | undefined;
      if (body.destination === "local") destTier = "local";
      else if (body.destination === "s3") {
        if (!c.s3.length) throw new HttpError(409, "Add an S3 compatible storage destination first", "NO_DESTINATION", { field: "destination" });
        destTier = "offsite";
        destId = null;
      } else if (body.destination !== undefined) {
        const d = await ctx.db.backupDestination.findUnique({ where: { id: body.destination } });
        if (!d) throw new HttpError(404, "That backup destination does not exist", "NOT_FOUND", { field: "destination" });
        destTier = d.type === "s3" ? "offsite" : "local";
        destId = d.type === "s3" ? d.id : undefined;
      }
      if (body.tier && destTier && body.tier !== destTier) {
        throw new HttpError(400, body.tier === "local" ? "The local tier keeps its backups on this server" : "The offsite tier needs an S3 destination", "WRONG_DESTINATION", { field: "destination" });
      }
      const tier: Tier = body.tier ?? destTier ?? primary;
      // An older client that points its one schedule somewhere else moves it there.
      const moveFrom = !body.tier && destTier && destTier !== primary ? primary : null;

      const before = tiers[tier];
      const next: TierRow = moveFrom
        ? { ...before, enabled: tiers[moveFrom].enabled, cron: tiers[moveFrom].cron, keep: tiers[moveFrom].keep, keepDays: tiers[moveFrom].keepDays }
        : { ...before };
      if (body.cron !== undefined) {
        try {
          parseCron(body.cron);
        } catch (e) {
          throw new HttpError(400, e instanceof CronError ? e.message : "Not a valid cron expression", "INVALID_CRON", { field: "cron" });
        }
        next.cron = body.cron;
      }
      if (body.retentionDays !== undefined) {
        next.keep = 3;
        next.keepDays = body.retentionDays;
      }
      if (body.keep !== undefined) next.keep = body.keep;
      if (body.keepDays !== undefined) next.keepDays = body.keepDays;
      if (destId !== undefined) next.destinationId = destId;
      if (body.enabled !== undefined) next.enabled = body.enabled;
      if (next.enabled && !next.cron) next.cron = DEFAULT_CRON;
      if (tier === "local" && (body.destination === "local" || (next.enabled && !before.enabled)) && !c.localAllowed) {
        throw new HttpError(409, `Local backups are turned off on this server (${LOCAL_FLAG}=0). Remove that setting to allow them.`, "LOCAL_DISABLED", { field: "destination" });
      }
      if (tier === "offsite" && next.enabled && !c.s3.length) throw new HttpError(409, "Add an S3 compatible storage destination first", "NO_DESTINATION", { field: "destination" });

      const data = { enabled: next.enabled, cron: next.cron, keep: next.keep, keepDays: next.keepDays, destinationId: tier === "offsite" ? next.destinationId : null };
      await ctx.db.$transaction(async (tx) => {
        await tx.backupSchedule.upsert({ where: { appId_tier: { appId: app.id, tier } }, update: data, create: { appId: app.id, tier, ...data } });
        if (moveFrom) await tx.backupSchedule.upsert({ where: { appId_tier: { appId: app.id, tier: moveFrom } }, update: { enabled: false, cron: null }, create: { appId: app.id, tier: moveFrom } });
      });
      const decrease = isRetentionDecrease(policyOf(before), policyOf(next));
      const changes: Array<[string, unknown, unknown]> = [
        ["enabled", before.enabled, next.enabled],
        ["cron", before.cron, next.cron],
        ["keep", before.keep, next.keep],
        ["keepDays", before.keepDays, next.keepDays],
        ["destination", before.destinationId, data.destinationId],
      ];
      await audit(ctx.db, {
        category: "config",
        action: "backup.schedule.update",
        verb: decrease ? "reduced backup retention for" : "changed the backup schedule of",
        ...actorFields(actor),
        targetType: "app",
        targetId: app.id,
        targetLabel: app.name,
        suffix: moveFrom ? `moved from the ${moveFrom} tier to the ${tier} tier` : `${tier} tier`,
        ...meta(req),
        changes: changes.filter(([, a, b]) => a !== b).map(([key, before, after]) => ({ key, before, after })) as Prisma.InputJsonValue,
      });
      const updated = await ctx.db.app.findUniqueOrThrow({ where: { id: app.id }, include: SCHEDULE_INCLUDE });
      return toSchedule(updated as unknown as ScheduleAppIn, c);
    },

    "backups.run": async ({ ctx, actor, body, req }) => {
      let ids: string[];
      const skipped: string[] = [];
      const label = new Map<string, string>();
      if (body.resourceId) {
        ids = [(await loadServiceApp(ctx, actor, body.resourceId)).id];
      } else {
        const projects = projectFilter(actor);
        const apps = await ctx.db.app.findMany({
          where: { kind: { in: [...SERVICE_KINDS] }, backupSchedules: { some: { enabled: true } }, ...(projects ? { environment: { projectId: { in: projects } } } : {}) },
          select: { id: true, name: true, displayName: true, desiredState: true, environment: { select: { project: { select: { slug: true } } } } },
          orderBy: { name: "asc" },
        });
        if (!apps.length) throw new HttpError(409, "No database has a backup schedule turned on", "NOTHING_TO_BACK_UP");
        for (const a of apps) label.set(a.id, `${a.environment.project.slug} / ${a.displayName || a.name}`);
        ids = apps.filter((a) => a.desiredState === "running").map((a) => a.id);
        skipped.push(...apps.filter((a) => a.desiredState !== "running").map((a) => `${label.get(a.id)} (it is stopped)`));
      }
      const backupIds: string[] = [];
      let started = 0;
      for (const id of ids) {
        try {
          // One dump per database, a copy to each tier it runs for.
          backupIds.push(...(await requestBackup(ctx.db, id, "manual", { tiers: await tiersToRun(ctx.db, id, body.tier) })).backupIds);
          started++;
        } catch (e) {
          if (body.resourceId) fromRequestError(e);
          skipped.push(`${label.get(id)} (${e instanceof RequestError || e instanceof DataError ? e.message : "it could not be started"})`);
        }
      }
      // A bulk run that started nothing is a failure, not "0 backups started".
      if (!started) throw new HttpError(409, `No backup was started. ${skipped.join("; ")}`, "NOTHING_STARTED");
      await audit(ctx.db, { category: "system", action: "backup.run", verb: "started a backup of", ...actorFields(actor), targetType: "backup", targetLabel: body.resourceId ? `1 database` : `${started} databases`, ...(skipped.length ? { suffix: `${skipped.length} not started` } : {}), ...meta(req) });
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
      const rows = await ctx.db.backup.count({ where: { sourceAppId: params.resourceId, appId: null, ...NOT_OWN } });
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
      const full = readsStorage(actor);
      const schedule = toSchedule(app as unknown as ScheduleAppIn, await scheduleContext(ctx, opts.env, fp.fingerprint));
      const runs = await listRuns(ctx, { sourceAppId: app.id }, 100);
      return { schedule: full ? schedule : limitSchedule(schedule), runs: full ? runs : runs.map(limitRun), config: await configPayload(ctx, fp, full) };
    },
  };
  return handlers as Handlers;
}

export const backupsHandlers: Handlers = createBackupsHandlers();
