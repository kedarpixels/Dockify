/**
 * Each pass rolls only closed buckets and rewrites its window in one transaction under an advisory lock,
 * so a rerun or a second worker is harmless. Retention deletes in batches so it never locks the table.
 */
import type { Db } from "@dockify/db";
import type { ObserveConfig } from "./config.ts";

export type Resolution = "raw" | "five_min" | "hour";
export const BUCKET_MS: Record<Exclude<Resolution, "raw">, number> = { five_min: 5 * 60_000, hour: 3_600_000 };

/** Samples that arrive up to this late still land before their bucket is rolled. */
const SETTLE_MS = 60_000;
/** Never roll further back than this in one pass (a long outage catches up over several). */
const MAX_BACK_MS: Record<Exclude<Resolution, "raw">, number> = { five_min: 24 * 3_600_000, hour: 30 * 86_400_000 };
const RETENTION_BATCH = 10_000;
const LOCK_KEY = 74_210_001;

export const floorTo = (ms: number, bucket: number): number => Math.floor(ms / bucket) * bucket;

/** The half-open window [from, to) of closed buckets to roll next, or null when nothing is due. */
export function planWindow(
  newestRolled: Date | null,
  oldestSource: Date | null,
  now: number,
  target: Exclude<Resolution, "raw">,
): { from: Date; to: Date } | null {
  const b = BUCKET_MS[target];
  if (!oldestSource && !newestRolled) return null;
  let from = newestRolled ? newestRolled.getTime() + b : floorTo((oldestSource as Date).getTime(), b);
  from = Math.max(from, floorTo(now - MAX_BACK_MS[target], b));
  const to = floorTo(now - SETTLE_MS, b);
  return to > from ? { from: new Date(from), to: new Date(to) } : null;
}

const SOURCE: Record<Exclude<Resolution, "raw">, Resolution> = { five_min: "raw", hour: "five_min" };

async function rollOne(db: Db, target: Exclude<Resolution, "raw">, now: number): Promise<number> {
  const source = SOURCE[target];
  const seconds = BUCKET_MS[target] / 1000;
  // A transaction-scoped lock: it lives on the same pooled connection as the work it guards.
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    const [newest] = await tx.$queryRaw<{ at: Date | null }[]>`
      SELECT max(at) AS at FROM metric_samples WHERE resolution = ${target}::"MetricResolution"`;
    const [oldest] = await tx.$queryRaw<{ at: Date | null }[]>`
      SELECT min(at) AS at FROM metric_samples WHERE resolution = ${source}::"MetricResolution"`;
    const w = planWindow(newest?.at ?? null, oldest?.at ?? null, now, target);
    if (!w) return 0;
    await tx.$executeRaw`
      DELETE FROM metric_samples
      WHERE resolution = ${target}::"MetricResolution" AND at >= ${w.from} AND at < ${w.to}`;
    return tx.$executeRaw`
      INSERT INTO metric_samples ("appId", resolution, at, "cpuPct", "memoryBytes", pids, restarts, "diskBytes", "netRxBytes", "netTxBytes")
      SELECT "appId", ${target}::"MetricResolution",
             to_timestamp(floor(extract(epoch FROM at) / ${seconds}) * ${seconds}) AS bucket,
             avg("cpuPct"), avg("memoryBytes")::bigint, max(pids), max(restarts), max("diskBytes"),
             max("netRxBytes"), max("netTxBytes")
      FROM metric_samples
      WHERE resolution = ${source}::"MetricResolution" AND at >= ${w.from} AND at < ${w.to}
      GROUP BY "appId", bucket`;
  }, { timeout: 60_000 });
}

async function pruneResolution(db: Db, res: Resolution, cutoff: Date): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await db.$executeRaw`
      DELETE FROM metric_samples WHERE ctid IN (
        SELECT ctid FROM metric_samples WHERE resolution = ${res}::"MetricResolution" AND at < ${cutoff} LIMIT ${RETENTION_BATCH})`;
    total += n;
    if (n < RETENTION_BATCH) return total;
  }
}

export interface MaintenanceResult {
  rolled: number;
  pruned: number;
}

/** Rollup runs first so retention never drops unrolled raw rows. */
export async function metricsMaintenance(db: Db, cfg: Pick<ObserveConfig, "retention">, now = Date.now()): Promise<MaintenanceResult> {
  const rolled = (await rollOne(db, "five_min", now)) + (await rollOne(db, "hour", now));
  const r = cfg.retention;
  const pruned =
    (await pruneResolution(db, "raw", new Date(now - r.rawHours * 3_600_000))) +
    (await pruneResolution(db, "five_min", new Date(now - r.fiveMinDays * 86_400_000))) +
    (await pruneResolution(db, "hour", new Date(now - r.hourDays * 86_400_000)));
  return { rolled, pruned };
}
