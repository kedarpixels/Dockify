/**
 * The data lane's job handlers, for the worker's handler table:
 *
 *   const data = createDataDeps({ db, vault, docker, tmpDir, localRoot, guard });
 *   Object.assign(handlers, dataJobHandlers(data));
 *   setInterval(() => void dataTick(data), 60_000);
 *
 * Errors carry `permanent: true` when a retry cannot help; the claim loop should fail those at once.
 */
import type { Db, JobKind } from "@dockify/db";
import { isPermanentError } from "../errors.ts";
import type { ClaimedJob } from "../queue.ts";
import { DataError, type DataDeps } from "./context.ts";
import { runBackup, runRestore, runRestoreTest } from "./pipeline.ts";
import type { RestorePayload } from "./requests.ts";
import { parseUpgradePayload, runServiceUpgrade } from "./upgrade.ts";

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 2_000) || "The backup failed";

/**
 * The job is over (its last attempt, or an error a retry cannot fix): a row it leaves running is
 * failed now, with this error. Only a row still running is touched, so a reason the pipeline
 * already wrote stays.
 */
export async function settleBackupRow(db: Db, backupId: string, e: unknown, now = new Date()): Promise<void> {
  await db.backup.updateMany({ where: { id: backupId, status: "running" }, data: { status: "failed", error: reasonOf(e), finishedAt: now } });
}

export async function settleRestoreTest(db: Db, backupId: string, e: unknown, now = new Date()): Promise<void> {
  await db.backup.updateMany({ where: { id: backupId, restoreTestStatus: "running" }, data: { restoreTestStatus: "failed", restoreTestError: reasonOf(e), restoreTestedAt: now } });
}

export type DataJobHandler = (job: ClaimedJob, signal: AbortSignal) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(payload: unknown, key: string): string {
  const v = (payload as Record<string, unknown> | null)?.[key];
  if (typeof v !== "string" || !UUID.test(v)) throw new DataError(`job payload has no valid ${key}`, true);
  return v;
}

/** The other copies one backup job writes from the same dump (requests.ts BackupJobPayload). */
export function copiesOf(payload: unknown): string[] {
  const v = (payload as { copies?: unknown } | null)?.copies;
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 4 || v.some((x) => typeof x !== "string" || !UUID.test(x))) throw new DataError("job payload has no valid copies", true);
  return v as string[];
}

export function parseRestorePayload(payload: unknown): RestorePayload {
  const p = payload as Partial<RestorePayload> | null;
  const backupId = field(p, "backupId");
  const targetAppId = field(p, "targetAppId");
  if (p?.mode !== "replace" && p?.mode !== "new") throw new DataError("job payload has no valid mode", true);
  return {
    backupId,
    targetAppId,
    mode: p.mode,
    ...(Array.isArray(p.quiesced) ? { quiesced: p.quiesced.filter((x): x is string => typeof x === "string" && UUID.test(x)) } : {}),
    ...(typeof p.resumedAt === "string" ? { resumedAt: p.resumedAt } : {}),
  };
}

/**
 * Each handler settles its own row on the way out when the job is over, whatever failed: the
 * pipeline marks the row itself, and this catches an error that came before it could, so
 * a row never waits for the next sweep to stop reading "running".
 */
export function dataJobHandlers(deps: DataDeps): Partial<Record<JobKind, DataJobHandler>> {
  return {
    backup: async (job) => {
      const backupId = field(job.payload, "backupId");
      const copies = copiesOf(job.payload);
      const final = job.attempts >= job.maxAttempts;
      try {
        await runBackup(deps, backupId, final, copies);
      } catch (e) {
        if (final || isPermanentError(e)) for (const id of [backupId, ...copies]) await settleBackupRow(deps.db, id, e).catch(() => {});
        throw e;
      }
    },
    restore: async (job) => runRestore(deps, job.id, parseRestorePayload(job.payload)),
    service_upgrade: async (job) => runServiceUpgrade(deps, job.id, parseUpgradePayload(job.payload)),
    restore_test: async (job) => {
      const backupId = field(job.payload, "backupId");
      try {
        await runRestoreTest(deps, backupId);
      } catch (e) {
        // Restore tests never retry (maxAttempts 1): every failure is the last word.
        await settleRestoreTest(deps.db, backupId, e).catch(() => {});
        throw e;
      }
    },
  };
}
