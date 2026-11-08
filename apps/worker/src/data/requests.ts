/**
 * The only way a backup or restore gets queued. A Backup row and its job are created in one
 * transaction under a per-app advisory lock, so two requests for the same app collapse into one run
 * instead of two dumps fighting over the database. Shared by the api (manual, restore buttons), the
 * scheduler (cron) and the deploy and update paths (pre-deploy, pre-update).
 */
import { defaultServerId, type BackupKind, type BackupTrigger, type Db, type Prisma, type Tx } from "@dockify/db";
import { loadTiers, primaryTier, tierDestinationId, type Tier } from "./tiers.ts";

export const SERVICE_KINDS = ["postgres", "redis", "s3"] as const;
export type ServiceAppKind = (typeof SERVICE_KINDS)[number];
export const isServiceKind = (k: string): k is ServiceAppKind => (SERVICE_KINDS as readonly string[]).includes(k);

export const backupKindFor = (k: ServiceAppKind): BackupKind => (k === "s3" ? "volume" : k);

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

export interface AppSnapshot {
  name: string;
  kind: string;
  projectSlug: string;
  environment: string;
  environmentId: string;
  /** The service's configured image tag and its pinned digest, so a restore runs the same server version. */
  image?: string | null;
  pinnedImage?: string | null;
  deletedAt?: string | null;
}

export const STALE_RUN_ERROR = "The worker stopped before this backup finished";

/**
 * Why a backup row that will never finish failed: the last error its own attempts recorded, else
 * the last error of the job that ran it, else that the worker stopped. A sweep never writes a
 * vaguer reason over a real one.
 */
export function staleReason(rowError: string | null | undefined, jobError: string | null | undefined): string {
  if (rowError?.trim()) return rowError.slice(0, 2_000);
  if (jobError?.trim()) return jobError.slice(0, 2_000);
  return STALE_RUN_ERROR;
}

const lock = (tx: Tx, key: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;

export interface BackupRequest {
  /** The first copy; `backupIds` lists every copy this one run writes. */
  backupId: string;
  backupIds: string[];
  jobId: string;
  existing: boolean;
}

/** What a backup job runs: one dump, written to the first row's destination and to each copy's. */
export interface BackupJobPayload {
  backupId: string;
  copies?: string[];
}

/**
 * Queues a backup of one service app. If one is already running for it, that one is returned
 * (existing: true): a pre-deploy dump that finds a scheduled dump in flight reuses it. While a
 * restore of the app is open the answer is 409 BUSY: the restore takes its own pre-restore dump
 * (a running row under the restore job), which must never be mistaken for a crash leftover.
 *
 * With `tiers`, the one dump goes to each tier, one row per tier, so both tiers due at once cost a
 * single dump. A scheduled run that finds another run in flight is BUSY rather than reused: that run
 * may not write to its tier, so the scheduler gives the slot back and fires once it is done.
 * Without `tiers`, one copy goes to `destinationId`, else where the database's schedule points.
 */
export async function requestBackup(db: Db, appId: string, trigger: BackupTrigger, opts: { destinationId?: string | null; tiers?: readonly Tier[] } = {}): Promise<BackupRequest> {
  return db.$transaction(async (tx) => {
    await lock(tx, `dockify.backup:${appId}`);
    const app = await tx.app.findUnique({
      where: { id: appId },
      include: { environment: { include: { project: { select: { slug: true } } } } },
    });
    if (!app) throw new RequestError(404, "That app does not exist", "NOT_FOUND");
    if (!isServiceKind(app.kind)) throw new RequestError(400, "Only Postgres, Redis and storage services are backed up", "NOT_A_SERVICE");

    const restoring = await tx.job.findFirst({ where: { kind: "restore", dedupeKey: `restore:${appId}`, completedAt: null, failedAt: null }, select: { id: true } });
    if (restoring) throw new RequestError(409, "A restore of this database is running; try again when it finishes", "BUSY");

    const running = await tx.backup.findFirst({ where: { appId, status: "running" }, orderBy: { createdAt: "desc" } });
    if (running) {
      const job = await tx.job.findFirst({ where: { kind: "backup", dedupeKey: `backup:${appId}`, completedAt: null, failedAt: null }, select: { id: true } });
      if (job && trigger === "schedule" && opts.tiers) throw new RequestError(409, "A backup of this database is running; the schedule fires when it finishes", "BUSY");
      if (job) return { backupId: running.id, backupIds: [running.id], jobId: job.id, existing: true };
      // A running row with no open job will never finish: settle it with the best reason there is.
      const last = await tx.job.findFirst({ where: { kind: "backup", payload: { path: ["backupId"], equals: running.id } }, orderBy: { createdAt: "desc" }, select: { lastError: true } });
      await tx.backup.update({ where: { id: running.id }, data: { status: "failed", error: staleReason(running.error, last?.lastError), finishedAt: new Date() } });
    }

    const tiers = opts.tiers?.length ? await loadTiers(tx, appId) : null;
    const destinations: Array<string | null> = [];
    if (tiers) {
      // A schedule still runs the tiers that can run: an offsite tier whose storage was removed
      // must not stop the local copy. Asked for by hand, the refusal is the answer.
      let refused: unknown = null;
      for (const t of new Set(opts.tiers)) {
        try {
          destinations.push(await tierDestinationId(tx, tiers[t]));
        } catch (e) {
          if (trigger !== "schedule") throw e;
          refused ??= e;
        }
      }
      if (!destinations.length) throw refused;
    } else destinations.push(opts.destinationId !== undefined ? opts.destinationId : await scheduleDestinationId(tx, appId));
    const snapshot: AppSnapshot = {
      name: app.name,
      kind: app.kind,
      projectSlug: app.environment.project.slug,
      environment: app.environment.name,
      environmentId: app.environmentId,
      image: app.image,
      pinnedImage: app.pinnedImage,
    };
    const ids: string[] = [];
    for (const destinationId of destinations) {
      const backup = await tx.backup.create({
        data: {
          appId,
          sourceAppId: appId,
          appSnapshot: snapshot as unknown as Prisma.InputJsonValue,
          kind: backupKindFor(app.kind),
          trigger,
          status: "running",
          destinationId,
          encrypted: true,
        },
        select: { id: true },
      });
      ids.push(backup.id);
    }
    const payload: BackupJobPayload = ids.length > 1 ? { backupId: ids[0]!, copies: ids.slice(1) } : { backupId: ids[0]! };
    const job = await tx.job.create({
      data: { kind: "backup", lane: "data", serverId: app.serverId, payload: payload as unknown as Prisma.InputJsonValue, dedupeKey: `backup:${appId}`, maxAttempts: 2 },
      select: { id: true },
    });
    return { backupId: ids[0]!, backupIds: ids, jobId: job.id, existing: false };
  });
}

export async function defaultDestinationId(tx: Tx): Promise<string | null> {
  const d = await tx.backupDestination.findFirst({ where: { isDefault: true }, select: { id: true } });
  return d?.id ?? null;
}

/**
 * Where a backup outside the tiers goes (a pre-update or pre-deploy dump, a manual run an older
 * client asked for): the destination of the tier the schedule's flat fields describe, else the
 * default destination, as before tiers.
 */
export async function scheduleDestinationId(tx: Tx, appId: string): Promise<string | null> {
  const tiers = await loadTiers(tx, appId);
  const def = await tx.backupDestination.findFirst({ where: { isDefault: true }, select: { id: true, type: true } });
  const tier = primaryTier(tiers, def?.type ?? null);
  try {
    return await tierDestinationId(tx, tiers[tier]);
  } catch {
    return def?.id ?? null;
  }
}

export type RestoreMode = "replace" | "new";

export interface RestorePayload {
  backupId: string;
  mode: RestoreMode;
  /** The app restored into: the source app for replace, the freshly created app for new. */
  targetAppId: string;
  /** Written by the worker before it stops anything, read by recovery after a crash. */
  quiesced?: string[];
  resumedAt?: string;
}

/**
 * Queues a restore. One restore per target app at a time, and never while a backup of it runs.
 * Restores never retry on their own (maxAttempts 1): a half done restore is resolved by recovery
 * and a person, not replayed blind.
 */
export async function requestRestore(db: Db, payload: RestorePayload): Promise<string> {
  return db.$transaction(async (tx) => {
    await lock(tx, `dockify.backup:${payload.targetAppId}`);
    const open = await tx.job.findFirst({
      where: { kind: { in: ["restore", "backup"] }, dedupeKey: { in: [`restore:${payload.targetAppId}`, `backup:${payload.targetAppId}`] }, completedAt: null, failedAt: null },
      select: { kind: true },
    });
    if (open) throw new RequestError(409, open.kind === "restore" ? "A restore of this database is already running" : "A backup of this database is running; try again when it finishes", "BUSY");
    const target = await tx.app.findUnique({ where: { id: payload.targetAppId }, select: { serverId: true } });
    if (!target) throw new RequestError(404, "The service to restore into no longer exists", "NOT_FOUND");
    const job = await tx.job.create({
      data: { kind: "restore", lane: "data", serverId: target.serverId, payload: payload as unknown as Prisma.InputJsonValue, dedupeKey: `restore:${payload.targetAppId}`, maxAttempts: 1 },
      select: { id: true },
    });
    return job.id;
  });
}

export async function requestRestoreTest(db: Db, backupId: string, scheduled = false): Promise<string> {
  return db.$transaction(async (tx) => {
    await lock(tx, `dockify.restore-test:${backupId}`);
    const open = await tx.job.findFirst({ where: { kind: "restore_test", dedupeKey: `restore-test:${backupId}`, completedAt: null, failedAt: null }, select: { id: true } });
    if (open) return open.id;
    await tx.backup.update({ where: { id: backupId }, data: { restoreTestStatus: "running", restoreTestError: null } });
    // Always the primary server: the scratch copy stays off other servers, and the source app may be gone.
    const job = await tx.job.create({
      data: { kind: "restore_test", lane: "data", serverId: await defaultServerId(tx), payload: { backupId, scheduled }, dedupeKey: `restore-test:${backupId}`, maxAttempts: 1 },
      select: { id: true },
    });
    return job.id;
  });
}

