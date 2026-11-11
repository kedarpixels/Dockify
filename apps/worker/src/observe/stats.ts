import type { DockerStats } from "./docker.ts";
import type { CpuTimes } from "@dockify/engine";

export { parseMeminfo, parseNetDev, parseProcStat, type CpuTimes } from "@dockify/engine";

/** Docker's own formula: 100 means one whole core, so two saturated cores read 200. */
export function containerCpuPct(s: DockerStats): number {
  const cpu = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sys = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const online = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  if (sys <= 0 || cpu <= 0) return 0;
  return Math.max(0, (cpu / sys) * online * 100);
}

/** Working set: usage minus reclaimable page cache (cgroup v2 and v1 field names). */
export function containerMemBytes(s: DockerStats): number {
  const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.total_inactive_file ?? 0;
  return Math.max(0, (s.memory_stats?.usage ?? 0) - cache);
}

export function containerNetTotals(s: DockerStats): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks ?? {})) {
    rx += n.rx_bytes ?? 0;
    tx += n.tx_bytes ?? 0;
  }
  return { rx, tx };
}

export function cpuBusyPct(prev: CpuTimes, now: CpuTimes): number | null {
  const total = now.total - prev.total;
  if (total <= 0) return null;
  return Math.min(100, Math.max(0, (1 - (now.idle - prev.idle) / total) * 100));
}

