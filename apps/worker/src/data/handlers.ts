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
import { DataError, DeadlineError, type DataDeps } from "./context.ts";
import type { DockerPort, ExecHandle } from "./docker-port.ts";
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

const HOUR_MS = 60 * 60_000;
/**
 * The wall clock limit of each data job. A server has one data lane, so a job that never ends (a
 * dump waiting on a lock its tenant holds) would hold up every other project's backups. A dump
 * through gzip moves 10 MB/s at the slow end, so six hours is over 200 GB of SQL. A replay rebuilds
 * indexes and is slower than its dump, and a restore or a version change takes a dump first:
 * twelve hours.
 */
export const DATA_JOB_LIMITS_MS = { backup: 6 * HOUR_MS, restore: 12 * HOUR_MS, restore_test: 12 * HOUR_MS, service_upgrade: 12 * HOUR_MS };
export type DataJobKind = keyof typeof DATA_JOB_LIMITS_MS;

const JOB_NAMES: Record<DataJobKind, string> = { backup: "backup", restore: "restore", restore_test: "restore test", service_upgrade: "version change" };

/**
 * The same Docker, with every exec and attach stopped once `signal` fires: the process is killed
 * and its `done` rejects with `late()`, so the job fails with the limit as its reason.
 */
export function limitedDocker(docker: DockerPort, signal: AbortSignal, late: () => Error): DockerPort {
  const limited = async (open: () => Promise<ExecHandle>): Promise<ExecHandle> => {
    if (signal.aborted) throw late();
    const h = await open();
    const expired = new Promise<never>((_, reject) => {
      const stop = () => {
        void h.kill().catch(() => {});
        reject(late());
      };
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    });
    const done = Promise.race([h.done, expired]);
    // A caller that already failed on the cut stream never awaits this.
    done.catch(() => {});
    return { stdout: h.stdout, stdin: h.stdin, done, kill: () => h.kill() };
  };
  return new Proxy(docker, {
    get(target, key) {
      if (key === "exec") return (id: string, opts: Parameters<DockerPort["exec"]>[1]) => limited(() => target.exec(id, opts));
      if (key === "attach") return (id: string, opts: Parameters<DockerPort["attach"]>[1]) => limited(() => target.attach(id, opts));
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Each handler settles its own row on the way out when the job is over, whatever failed: the
 * pipeline marks the row itself, and this catches an error that came before it could, so
 * a row never waits for the next sweep to stop reading "running".
 */
export function dataJobHandlers(base: DataDeps, limits: Record<DataJobKind, number> = DATA_JOB_LIMITS_MS): Partial<Record<JobKind, DataJobHandler>> {
  /** Runs one job with its own clock: its deps reach Docker through limitedDocker. */
  const timed = (kind: DataJobKind, run: (deps: DataDeps, job: ClaimedJob) => Promise<void>): DataJobHandler => async (job) => {
    const clock = new AbortController();
    const ms = limits[kind];
    const hours = Math.round((ms / HOUR_MS) * 10) / 10;
    const late = () => new DeadlineError(`The ${JOB_NAMES[kind]} ran past its limit of ${hours} hours and was stopped, so the other data jobs of this server are not held up.`);
    const timer = setTimeout(() => clock.abort(), ms);
    try {
      await run({ ...base, docker: limitedDocker(base.docker, clock.signal, late) }, job);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    backup: timed("backup", async (deps, job) => {
      const backupId = field(job.payload, "backupId");
      const copies = copiesOf(job.payload);
      const final = job.attempts >= job.maxAttempts;
      try {
        await runBackup(deps, backupId, final, copies);
      } catch (e) {
        if (final || isPermanentError(e)) for (const id of [backupId, ...copies]) await settleBackupRow(deps.db, id, e).catch(() => {});
        throw e;
      }
    }),
    restore: timed("restore", (deps, job) => runRestore(deps, job.id, parseRestorePayload(job.payload))),
    service_upgrade: timed("service_upgrade", (deps, job) => runServiceUpgrade(deps, job.id, parseUpgradePayload(job.payload))),
    restore_test: timed("restore_test", async (deps, job) => {
      const backupId = field(job.payload, "backupId");
      try {
        await runRestoreTest(deps, backupId);
      } catch (e) {
        // Restore tests never retry (maxAttempts 1): every failure is the last word.
        await settleRestoreTest(deps.db, backupId, e).catch(() => {});
        throw e;
      }
    }),
  };
}
