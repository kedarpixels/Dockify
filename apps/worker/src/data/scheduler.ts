/**
 * The data lane's clock, run once a minute by the worker: fire due backup schedules, apply
 * retention, run the weekly restore tests, settle stale rows, and, once per server, undo quiesces a
 * crashed restore left behind. Every step is idempotent, so two workers or a missed minute do no harm.
 */
import type { Db } from "@dockify/db";
import { appsHere } from "../server/apps-here.ts";
import type { DataDeps, DataStores } from "./context.ts";
import { nextRun } from "./cron.ts";
import { resume } from "./pipeline.ts";
import { containerNameFor, LABEL_APP, LABEL_ROLE } from "./services.ts";
import { requestBackup, requestRestoreTest, SERVICE_KINDS, staleReason, type RestorePayload } from "./requests.ts";
import { failedRowsToDelete, selectExpired } from "./retention.ts";
import { settleAbandonedUpgrades } from "./upgrade.ts";

export interface TickReport {
  scheduled: number;
  expired: number;
  failedRowsDeleted: number;
  restoreTests: number;
  staleFailed: number;
  staleTests: number;
}

export interface ServerTickReport {
  resumed: number;
  /** Older installs' services queued once for the managed path. */
  upgraded: number;
}

export const STALE_TEST_ERROR = "The worker stopped before this restore test finished";

/** The message of the one deploy that moves an older install's service onto the managed path. */
export const LEGACY_UPGRADE_MESSAGE = "Moved onto the managed service path: its own password and volume, its data copied over (one-time upgrade)";
const IN_FLIGHT = ["queued", "building", "deploying", "cancelling"] as const;

/**
 * Services an older install ran through the generic app pipeline (no password, the project's
 * variables, data on an anonymous volume) get one deploy through the managed path, which copies
 * their data over (data/managed.ts). Queued by Dockify itself, once per service: a service that
 * already has the marker deployment is never queued again, so a conversion that fails leaves the
 * old container running as it was and waits for the owner to deploy.
 */
export async function upgradeLegacyServices(deps: DataDeps, serverId: string): Promise<number> {
  const { db } = deps;
  const apps = await db.app.findMany({
    where: { ...appsHere(serverId), kind: { in: ["postgres", "redis"] }, desiredState: "running", deployments: { none: { message: LEGACY_UPGRADE_MESSAGE } } },
    select: { id: true, serverId: true },
  });
  let n = 0;
  for (const a of apps) {
    const st = await deps.docker.inspect(containerNameFor(a.id)).catch(() => null);
    if (!st || st.labels[LABEL_APP] !== a.id || st.labels[LABEL_ROLE] !== "app") continue;
    const queued = await db.$transaction(async (tx) => {
      // The same lock and in-flight rule as every deploy request (api deployments/enqueue.ts).
      const key = `deploy:${a.id}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      if (await tx.deployment.findFirst({ where: { appId: a.id, status: { in: [...IN_FLIGHT] } }, select: { id: true } })) return false;
      if (await tx.job.findFirst({ where: { dedupeKey: key, completedAt: null, failedAt: null }, select: { id: true } })) return false;
      const now = new Date().toISOString();
      const dep = await tx.deployment.create({
        data: { appId: a.id, serverId: a.serverId, trigger: "redeploy", actorType: "system", actorName: "Dockify", message: LEGACY_UPGRADE_MESSAGE, steps: [{ id: "queued", status: "done", startedAt: now, finishedAt: now }] },
        select: { id: true },
      });
      await tx.job.create({ data: { kind: "deploy", lane: "deploy", serverId: a.serverId, payload: { deploymentId: dep.id, appId: a.id }, dedupeKey: key, maxAttempts: 3 } });
      await tx.app.update({ where: { id: a.id }, data: { status: "deploying" } });
      return true;
    });
    if (queued) n++;
  }
  return n;
}

/** When a schedule next fires, from its last run (or from when the app was set up). */
export function scheduleNextRun(app: { backupCron: string | null; backupTimezone: string; backupLastRunAt: Date | null; createdAt: Date }, now: Date): Date | null {
  if (!app.backupCron) return null;
  try {
    return nextRun(app.backupCron, app.backupTimezone || "UTC", app.backupLastRunAt ?? new Date(Math.max(app.createdAt.getTime(), now.getTime() - 60_000)));
  } catch {
    return null;
  }
}

export async function fireDueSchedules(db: Db, now: Date, log: (msg: string, extra?: object) => void = () => {}): Promise<number> {
  const apps = await db.app.findMany({
    where: { backupEnabled: true, backupCron: { not: null }, kind: { in: [...SERVICE_KINDS] } },
    select: { id: true, backupCron: true, backupTimezone: true, backupLastRunAt: true, createdAt: true },
  });
  let n = 0;
  for (const app of apps) {
    const due = scheduleNextRun(app, now);
    if (!due || due > now) continue;
    // Claim this slot first, so a second worker or the next tick does not fire it again.
    const claimed = await db.app.updateMany({ where: { id: app.id, backupLastRunAt: app.backupLastRunAt }, data: { backupLastRunAt: now } });
    if (claimed.count !== 1) continue;
    try {
      await requestBackup(db, app.id, "schedule");
      n++;
    } catch (e) {
      log("a scheduled backup was not taken", { appId: app.id, error: e instanceof Error ? e.message : String(e) });
      // A restore of this database is running: give the slot back, and the next tick after it tries again.
      if ((e as { code?: unknown }).code === "BUSY") await db.app.updateMany({ where: { id: app.id, backupLastRunAt: now }, data: { backupLastRunAt: app.backupLastRunAt } });
    }
  }
  return n;
}

const CONTROL_PLANE_RETENTION_DAYS = 30;

/** Deletes expired objects first and marks the row only after, so a failed delete is retried next tick. */
export async function applyRetention(deps: DataStores, now: Date): Promise<{ expired: number; deleted: number }> {
  const { db } = deps;
  const apps = await db.app.findMany({ where: { kind: { in: [...SERVICE_KINDS] } }, select: { id: true, backupRetentionDays: true } });
  let expired = 0;
  let deleted = 0;
  const pass = async (where: { appId: string } | { kind: "control_plane" }, days: number) => {
    const rows = await db.backup.findMany({
      where,
      select: { id: true, status: true, trigger: true, createdAt: true, objectKey: true, expiredAt: true, destinationId: true },
    });
    for (const b of selectExpired(rows, days, now)) {
      try {
        const dest = await deps.storeFor(b.destinationId);
        await dest.store.delete(b.objectKey!);
        await db.backup.update({ where: { id: b.id }, data: { expiredAt: now } });
        expired++;
      } catch {
        // The destination is unreachable or gone; try again next tick.
      }
    }
    const old = failedRowsToDelete(rows, now).map((b) => b.id);
    if (old.length) deleted += (await db.backup.deleteMany({ where: { id: { in: old }, status: "failed" } })).count;
  };
  for (const app of apps) await pass({ appId: app.id }, app.backupRetentionDays);
  // The offsite copies of pre-update dumps belong to no app, and one more comes with each update.
  await pass({ kind: "control_plane" }, CONTROL_PLANE_RETENTION_DAYS);
  return { expired, deleted };
}

/** A row with no job at all is settled only after this, the one case the reason cannot come from a job. */
const ORPHAN_ROW_AGE_MS = 10 * 60_000;

/**
 * Running rows whose job is over (failed, done, or out of attempts because its worker died) will
 * never finish. Each is settled as soon as that is known, with the reason its own attempts or its
 * job recorded (staleReason), never a vaguer one.
 */
export async function failStaleRuns(db: Db, now: Date): Promise<number> {
  const running = await db.backup.findMany({ where: { status: "running" }, select: { id: true, appId: true, trigger: true, error: true, createdAt: true } });
  let n = 0;
  for (const b of running) {
    // A restore and a version change each take their own dump first, a running row no job names.
    const ownerKeys = b.appId ? [{ dedupeKey: `restore:${b.appId}` }, { dedupeKey: `service-upgrade:${b.appId}` }] : [];
    const open = await db.job.findFirst({
      where: { kind: { in: ["backup", "restore", "service_upgrade"] }, completedAt: null, failedAt: null, OR: [{ payload: { path: ["backupId"], equals: b.id } }, ...ownerKeys] },
      select: { id: true },
    });
    if (open) continue;
    // Its own job, or for a pre-restore dump the restore that took it.
    const owner = await db.job.findFirst({
      where: b.trigger === "pre_restore" && b.appId ? { kind: "restore", dedupeKey: `restore:${b.appId}` } : { kind: "backup", payload: { path: ["backupId"], equals: b.id } },
      orderBy: { createdAt: "desc" },
      select: { lastError: true },
    });
    if (!owner && b.createdAt.getTime() > now.getTime() - ORPHAN_ROW_AGE_MS) continue;
    await db.backup.update({ where: { id: b.id }, data: { status: "failed", error: staleReason(b.error, owner?.lastError), finishedAt: now } });
    n++;
  }
  return n;
}

/** A restore test left running by a job that is over is settled failed with that job's last error. */
export async function failStaleRestoreTests(db: Db, now: Date): Promise<number> {
  const rows = await db.backup.findMany({ where: { restoreTestStatus: "running" }, select: { id: true } });
  let n = 0;
  for (const b of rows) {
    const jobs = { kind: "restore_test" as const, dedupeKey: `restore-test:${b.id}` };
    if (await db.job.findFirst({ where: { ...jobs, completedAt: null, failedAt: null }, select: { id: true } })) continue;
    const last = await db.job.findFirst({ where: jobs, orderBy: { createdAt: "desc" }, select: { lastError: true } });
    await db.backup.update({
      where: { id: b.id },
      data: { restoreTestStatus: "failed", restoreTestError: (last?.lastError ?? "").trim() || STALE_TEST_ERROR, restoreTestedAt: now },
    });
    n++;
  }
  return n;
}

/** The newest ready backup of every service, tested on the instance's restore test cron. */
export async function scheduleRestoreTests(db: Db, now: Date): Promise<number> {
  const inst = await db.instance.findUnique({ where: { id: 1 }, select: { restoreTestCron: true } });
  if (!inst?.restoreTestCron) return 0;
  const last = await db.job.findFirst({ where: { kind: "restore_test", payload: { path: ["scheduled"], equals: true } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  const from = last?.createdAt ?? new Date(now.getTime() - 7 * 86_400_000);
  let due: Date;
  try {
    due = nextRun(inst.restoreTestCron, "UTC", from);
  } catch {
    return 0;
  }
  if (due > now) return 0;
  const apps = await db.app.findMany({ where: { kind: { in: [...SERVICE_KINDS] } }, select: { id: true } });
  let n = 0;
  for (const app of apps) {
    const b = await db.backup.findFirst({ where: { appId: app.id, status: "ready", expiredAt: null }, orderBy: { createdAt: "desc" }, select: { id: true } });
    if (!b) continue;
    await requestRestoreTest(db, b.id, true);
    n++;
  }
  return n;
}

/**
 * A restore that died after quiescing leaves the environment's apps stopped. Its job row says which
 * (written before the first stop) and whether they were resumed; anything settled or abandoned and
 * not resumed gets its apps started again.
 */
export async function recoverQuiesced(deps: DataDeps, now: Date, serverId: string): Promise<number> {
  const jobs = await deps.db.job.findMany({
    where: {
      ...appsHere(serverId),
      kind: { in: ["restore", "service_upgrade"] },
      createdAt: { gt: new Date(now.getTime() - 7 * 86_400_000) },
      OR: [{ failedAt: { not: null } }, { completedAt: { not: null } }, { lockedUntil: { lt: now } }],
    },
    select: { id: true, payload: true, attempts: true, maxAttempts: true, failedAt: true, completedAt: true },
  });
  let n = 0;
  for (const j of jobs) {
    const p = j.payload as unknown as RestorePayload;
    if (!p?.quiesced?.length || p.resumedAt) continue;
    const abandoned = !j.failedAt && !j.completedAt;
    if (abandoned && j.attempts < j.maxAttempts) continue; // it will be claimed again
    const down = await resume(deps, j.id, p, p.quiesced);
    if (abandoned) {
      await deps.db.job.update({ where: { id: j.id }, data: { failedAt: now, lastError: `The worker stopped during the restore or version change. A Postgres replay rolls back on its own; ${down.length ? `${down.length} of the stopped apps could not be started, and this is retried each minute` : "the stopped apps were started again"}.` } });
    }
    n++;
  }
  return n;
}

export async function dataTick(deps: DataStores): Promise<TickReport> {
  const now = deps.now?.() ?? new Date();
  const scheduled = await fireDueSchedules(deps.db, now, deps.log);
  const { expired, deleted } = await applyRetention(deps, now);
  const restoreTests = await scheduleRestoreTests(deps.db, now);
  const staleFailed = await failStaleRuns(deps.db, now);
  const staleTests = await failStaleRestoreTests(deps.db, now);
  await settleAbandonedUpgrades(deps);
  return { scheduled, expired, failedRowsDeleted: deleted, restoreTests, staleFailed, staleTests };
}

/** The steps that act on one server's containers. */
export async function dataServerTick(deps: DataDeps, serverId: string): Promise<ServerTickReport> {
  const resumed = await recoverQuiesced(deps, deps.now?.() ?? new Date(), serverId);
  const upgraded = await upgradeLegacyServices(deps, serverId);
  return { resumed, upgraded };
}

