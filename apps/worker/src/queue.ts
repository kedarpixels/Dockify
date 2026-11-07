import type { Db, JobKind, JobLane } from "@dockify/db";

/**
 * The jobs table is the queue. FOR UPDATE SKIP LOCKED lets workers step over each other's rows,
 * and the lease (lockedUntil) covers a worker killed mid-job, whose row lock dies with it.
 * Every time comparison happens in SQL against now(), so the app clock never matters.
 */
export interface ClaimedJob {
  id: string;
  kind: JobKind;
  lane: JobLane;
  payload: unknown;
  /** Already counted by the claim: the number of the attempt now running. */
  attempts: number;
  maxAttempts: number;
  /** When the job was queued. Absent from fakes that do not need it. */
  createdAt?: Date;
  /** The server whose loop claimed it, null for the global loops. Absent from fakes that do not need it. */
  serverId?: string | null;
}

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 15 * 60_000;

/** Exponential with jitter, so jobs that failed together do not retry together forever. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const raw = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
  return Math.round(raw * (0.8 + random() * 0.4));
}

/** The shared enqueue lives in @dockify/db so the api and the worker use one dedupe rule. */
export { defaultServerId, enqueue } from "@dockify/db";

interface Row {
  id: string;
  kind: JobKind;
  lane: JobLane;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  serverId: string | null;
}

export const EXHAUSTED_ERROR = "The worker stopped before this job finished, on every attempt";

/**
 * Settles jobs whose every attempt died with its worker (OOM kill, host reset, a SIGKILL during
 * cleanup): attempts reached maxAttempts through expired leases, so fail() never ran. Without this
 * such a job is neither claimable nor failed, and whatever waits on it (an in-flight deployment,
 * a dedupe key) waits forever. Runs at every claim, so no lane can keep such a row. Not limited to
 * the claiming server: such a job is finished whoever notices, and its own server's loops may be gone.
 */
export async function failExhausted(db: Db, lane: JobLane): Promise<number> {
  return db.$executeRaw`
    UPDATE jobs SET "failedAt" = now(), "lockedUntil" = NULL,
      "lastError" = CASE WHEN "lastError" IS NULL THEN ${EXHAUSTED_ERROR} ELSE left(${EXHAUSTED_ERROR} || ': ' || "lastError", 2000) END
    WHERE lane = ${lane}::"JobLane"
      AND "completedAt" IS NULL
      AND "failedAt" IS NULL
      AND attempts >= "maxAttempts"
      AND ("lockedUntil" IS NULL OR "lockedUntil" <= now())`;
}

/** Takes the next runnable job in a lane for one server (null: the global loops), or null. Attempts are counted here, at claim. */
export async function claim(db: Db, lane: JobLane, leaseMs: number, workerId: string, serverId: string | null): Promise<ClaimedJob | null> {
  await failExhausted(db, lane);
  const leaseSeconds = leaseMs / 1000;
  const rows = await db.$queryRaw<Row[]>`
    UPDATE jobs SET
      attempts = attempts + 1,
      "lockedUntil" = now() + ${leaseSeconds}::double precision * interval '1 second',
      "lockedBy" = ${workerId}
    WHERE id = (
      SELECT id FROM jobs
      WHERE lane = ${lane}::"JobLane"
        AND "serverId" IS NOT DISTINCT FROM ${serverId}::uuid
        AND "completedAt" IS NULL
        AND "failedAt" IS NULL
        AND attempts < "maxAttempts"
        AND "runAfter" <= now()
        AND ("lockedUntil" IS NULL OR "lockedUntil" <= now())
      ORDER BY "runAfter" ASC, "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, lane, payload, attempts, "maxAttempts", "createdAt", "serverId"`;
  return rows[0] ?? null;
}

/**
 * Extends this worker's lease. One that lapsed during a database outage still counts while the row
 * names this worker: a claim would have rewritten lockedBy, and this update is atomic with that.
 */
export async function extendLease(db: Db, id: string, workerId: string, leaseMs: number): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE jobs SET "lockedUntil" = now() + ${leaseMs / 1000}::double precision * interval '1 second'
    WHERE id = ${id}::uuid AND "lockedBy" = ${workerId}
      AND "completedAt" IS NULL AND "failedAt" IS NULL
      AND "lockedUntil" IS NOT NULL`;
  return n === 1;
}

/**
 * Renews a lease for as long as a job runs. A renewal that throws is the database blinking, so it
 * is retried on the next beat and costs the job nothing. Only an answer that the row is no longer
 * this worker's ends it: `signal` aborts, and the job stops without writing to a row it lost.
 */
export function holdLease(db: Db, id: string, workerId: string, leaseMs: number, log: (msg: string, extra?: object) => void): { signal: AbortSignal; stop(): void } {
  const lost = new AbortController();
  const timer = setInterval(() => {
    extendLease(db, id, workerId, leaseMs).then(
      (held) => {
        if (held) return;
        clearInterval(timer);
        log("lost the lease on a running job; stopping that job", { jobId: id });
        lost.abort();
      },
      (e: unknown) => log("could not renew a job's lease; trying again", { jobId: id, error: e instanceof Error ? e.message : String(e) }),
    );
  }, leaseMs / 3);
  return { signal: lost.signal, stop: () => clearInterval(timer) };
}

export async function complete(db: Db, id: string): Promise<void> {
  await db.job.update({ where: { id }, data: { completedAt: new Date(), lockedUntil: null, lastError: null } });
}

export type Disposition = "retry" | "failed";

/** Records a failed attempt. Deterministic failures pass permanent and are never retried. */
export async function fail(db: Db, job: ClaimedJob, message: string, permanent = false): Promise<Disposition> {
  const text = message.slice(0, 2_000);
  if (permanent || job.attempts >= job.maxAttempts) {
    await db.job.update({ where: { id: job.id }, data: { failedAt: new Date(), lockedUntil: null, lastError: text } });
    return "failed";
  }
  await db.$executeRaw`
    UPDATE jobs SET "lastError" = ${text}, "lockedUntil" = NULL,
      "runAfter" = now() + ${backoffMs(job.attempts) / 1000}::double precision * interval '1 second'
    WHERE id = ${job.id}::uuid`;
  return "retry";
}

/** Puts a job that cannot run yet back for later, without spending the attempt (DeferJobError). */
export async function defer(db: Db, id: string, message: string, delayMs: number): Promise<void> {
  await db.$executeRaw`
    UPDATE jobs SET attempts = GREATEST(attempts - 1, 0), "lastError" = ${message.slice(0, 2_000)}, "lockedUntil" = NULL, "lockedBy" = NULL,
      "runAfter" = now() + ${delayMs / 1000}::double precision * interval '1 second'
    WHERE id = ${id}::uuid`;
}

/** Gives a claim back on shutdown without spending the attempt. */
export async function release(db: Db, id: string): Promise<void> {
  await db.$executeRaw`
    UPDATE jobs SET attempts = GREATEST(attempts - 1, 0), "lockedUntil" = NULL, "lockedBy" = NULL
    WHERE id = ${id}::uuid`;
}
