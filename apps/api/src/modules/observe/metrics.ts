/**
 * Metric reads. Each range reads one resolution (1h raw, 24h five_min, 7d hour) and fills the
 * stretch after the newest rollup from the next finer resolution, so a chart is never missing its
 * most recent minutes while a rollup is pending.
 */
import { statfs } from "node:fs/promises";
import os from "node:os";
import { defaultCpuCores } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import { loadPlatformEnv } from "../platform/shared.ts";
import { appPoints, bucketize, RANGES, rate, type Range } from "./logic.ts";

const SAMPLE_SELECT = { at: true, cpuPct: true, memoryBytes: true, pids: true, restarts: true, netRxBytes: true, netTxBytes: true, diskBytes: true } as const;
const MAX_ROWS = 5_000;
/** The worker's defaults in containerSpec(); mirrored so a limit-less app still shows a ceiling. */
export const DEFAULT_MEMORY_MB = 512;
export const DEFAULT_PIDS = 512;

export async function readSeries(db: Db, appId: string | null, range: Range, now = Date.now()) {
  const r = RANGES[range];
  const from = new Date(now - r.ms);
  const main = await db.metricSample.findMany({
    where: { appId, resolution: r.resolution, at: { gte: from } },
    orderBy: { at: "asc" },
    select: SAMPLE_SELECT,
    take: MAX_ROWS,
  });
  let tail: typeof main = [];
  if (r.tail) {
    const last = main[main.length - 1]?.at.getTime();
    const tailFrom = last !== undefined ? new Date(last + r.bucketMs) : from;
    tail = await db.metricSample.findMany({
      where: { appId, resolution: r.tail, at: { gte: tailFrom } },
      orderBy: { at: "asc" },
      select: SAMPLE_SELECT,
      take: MAX_ROWS,
    });
  }
  return [...main, ...tail];
}

export async function appMetrics(
  db: Db,
  app: { id: string; cpuLimit: number | null; memoryLimitMb: number | null; pidsLimit: number | null },
  range: Range,
  now = Date.now(),
) {
  const rows = await readSeries(db, app.id, range, now);
  const { points, lastRestartAt } = appPoints(bucketize(rows, RANGES[range].bucketMs));
  const latest = await db.metricSample.findFirst({
    where: { appId: app.id, resolution: "raw", at: { gte: new Date(now - 120_000) } },
    orderBy: { at: "desc" },
    select: { cpuPct: true, memoryBytes: true, pids: true },
  });
  return {
    range,
    points,
    limits: {
      cpuCores: app.cpuLimit ?? defaultCpuCores(os.cpus().length),
      memoryBytes: (app.memoryLimitMb ?? DEFAULT_MEMORY_MB) * 1024 * 1024,
      pids: app.pidsLimit ?? DEFAULT_PIDS,
    },
    current: latest ? { cpuPct: Math.round(latest.cpuPct * 10) / 10, memoryBytes: Number(latest.memoryBytes), pids: latest.pids ?? 0 } : null,
    lastRestartAt,
  };
}

/** Host totals the sample table does not store; read from this kernel. */
export async function hostTotals(diskPath = process.env.DOCKIFY_METRICS_DISK_PATH || "/") {
  let diskTotal = 0;
  try {
    const s = await statfs(diskPath);
    diskTotal = s.blocks * s.bsize;
  } catch {
    diskTotal = 0;
  }
  return { memoryBytes: os.totalmem(), diskBytes: diskTotal };
}

const pct = (part: number, whole: number): number => (whole > 0 ? Math.min(100, Math.max(0, Math.round((part / whole) * 1000) / 10)) : 0);

/** The overview's host card: the latest host sample, a one-hour history, and running containers. */
export async function hostSnapshot(db: Db, instanceName: string, now = Date.now()) {
  const totals = await hostTotals();
  const rows = await readSeries(db, null, "1h", now);
  const buckets = bucketize(rows, 60_000);
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const recentApps = await db.metricSample.findMany({
    where: { appId: { not: null }, resolution: "raw", at: { gte: new Date(now - 120_000) } },
    distinct: ["appId"],
    select: { appId: true },
  });
  const outMbps = last && prev
    ? (rate(prev.netTxBytes === null ? null : Number(prev.netTxBytes), last.netTxBytes === null ? null : Number(last.netTxBytes), (last.at.getTime() - prev.at.getTime()) / 1000) * 8) / 1e6
    : 0;
  return {
    name: instanceName,
    region: process.env.DOCKIFY_REGION ?? "",
    uptimeSeconds: Math.round(os.uptime()),
    containers: recentApps.length,
    load1: Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
    cpu: { usedPct: last ? Math.round(last.cpuPct * 10) / 10 : 0, cores: os.cpus().length },
    memory: { usedBytes: last ? Number(last.memoryBytes) : os.totalmem() - os.freemem(), totalBytes: totals.memoryBytes },
    disk: { usedBytes: last?.diskBytes ? Number(last.diskBytes) : 0, totalBytes: totals.diskBytes, reclaimableBytes: 0 },
    // The link speed only the installer can know; null (the page hides it) rather than a made-up 1000.
    network: { outMbps: Math.round(outMbps * 10) / 10, capacityMbps: loadPlatformEnv().networkCapacityMbps },
    history: buckets.map((b, i) => {
      const p = buckets[i - 1];
      const secs = p ? (b.at - p.at) / 1000 : 0;
      const disk = rows.find((r) => Math.floor(r.at.getTime() / 60_000) * 60_000 === b.at)?.diskBytes;
      return {
        at: new Date(b.at).toISOString(),
        cpu: Math.round(b.cpuPct * 10) / 10,
        memory: pct(b.memoryBytes, totals.memoryBytes),
        disk: disk ? pct(Number(disk), totals.diskBytes) : 0,
        network: Math.round(((rate(p?.netTx, b.netTx, secs) * 8) / 1e6) * 10) / 10,
      };
    }),
  };
}
