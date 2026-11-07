/**
 * The metrics sampler: on its own clock (not a job, so it keeps running while the queue is busy),
 * one raw MetricSample row for the host and one per running app container. Network columns hold the
 * cumulative byte counters (host interfaces, or the container's own), so a reader takes the delta
 * between two points and treats a negative delta (reboot, replaced container) as zero. restarts is
 * the container's cumulative RestartCount the same way.
 *
 * It also keeps the latest reading in memory for the alert engine, which runs in the same process
 * and needs totals (memory, disk, limits) that the sample table does not store.
 */
import type { Db, Prisma } from "@dockify/db";
import { DockerError, isNotFound } from "@dockify/engine";
import { pickAppContainers, type DockerReader } from "./docker.ts";
import type { HostReading } from "@dockify/engine";
import { appsHere } from "../server/apps-here.ts";
import { containerCpuPct, containerMemBytes, containerNetTotals, cpuBusyPct, type CpuTimes } from "./stats.ts";

/**
 * Stores one tick's samples. A tick reads the app list once and then spends about a second per
 * container, so an app deleted meanwhile fails the foreign key, and createMany takes every other
 * app's samples down with it. That row goes and the rest try again, more than once: deleting a project
 * removes its apps one by one, so another can go while this retries. Past that the tick's samples
 * are dropped, as a missed tick is. Anything but that error still throws.
 */
export async function insertSamples(db: Db, rows: Prisma.MetricSampleCreateManyInput[]): Promise<void> {
  const onlyLive = async (list: Prisma.MetricSampleCreateManyInput[]) => {
    const ids = list.flatMap((r) => (r.appId ? [r.appId] : []));
    const live = new Set((await db.app.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((a) => a.id));
    return list.filter((r) => !r.appId || live.has(r.appId));
  };
  // Checked first because a refused insert prints a Prisma error on the log, even when handled here.
  let left = await onlyLive(rows);
  for (let tries = 0; left.length && tries < 3; tries++) {
    try {
      await db.metricSample.createMany({ data: left });
      return;
    } catch (e) {
      if ((e as { code?: string }).code !== "P2003") throw e;
      left = await onlyLive(left);
    }
  }
}

export interface HostLatest {
  at: Date;
  cpuPct: number | null;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
}

export interface AppLatest {
  at: Date;
  containerId: string;
  /** Docker state: running, restarting, exited, created, paused, dead. */
  state: string;
  health: string | null;
  /** State.StartedAt as the daemon reports it (an ISO time; year 1 when it never started). */
  startedAt: string | null;
  restartCount: number;
  cpuPct: number | null;
  memBytes: number | null;
  /** Memory cap from HostConfig, 0 when the container has none. */
  memLimitBytes: number;
}

export interface SamplerState {
  host: HostLatest | null;
  apps: Map<string, AppLatest>;
  /** Restart timestamps per app, newest last, for the crash-loop rule. Trimmed to 24 h. */
  restarts: Map<string, number[]>;
  /** False until the first container listing succeeded, so "down" never fires on a blind start. */
  dockerSeen: boolean;
  /**
   * Apps the last successful listing showed a container for, read or not: an app here but missing
   * from `apps` had a failed inspect this tick, which says nothing about its container.
   */
  listed: Set<string>;
  /** When the last listing succeeded (ms), or null before the first one. */
  listedAt: number | null;
}

export const newSamplerState = (): SamplerState => ({ host: null, apps: new Map(), restarts: new Map(), dockerSeen: false, listed: new Set(), listedAt: null });

const DAY_MS = 86_400_000;

/** Records restart increments of the SAME container. A replaced container is a deploy, not a crash. */
export function noteRestarts(state: SamplerState, appId: string, prev: AppLatest | undefined, next: AppLatest, now: number): void {
  if (!prev || prev.containerId !== next.containerId || next.restartCount <= prev.restartCount) return;
  const list = state.restarts.get(appId) ?? [];
  for (let i = prev.restartCount; i < next.restartCount; i++) list.push(now);
  while (list.length > 0 && (list[0] ?? 0) < now - DAY_MS) list.shift();
  if (list.length > 500) list.splice(0, list.length - 500);
  state.restarts.set(appId, list);
}

interface Row {
  appId: string | null;
  at: Date;
  cpuPct: number;
  memoryBytes: bigint;
  pids: number | null;
  restarts: number | null;
  diskBytes: bigint | null;
  netRxBytes: bigint | null;
  netTxBytes: bigint | null;
  memTotalBytes?: bigint | null;
  diskTotalBytes?: bigint | null;
}

const big = (n: number | null | undefined): bigint | null => (n === null || n === undefined ? null : BigInt(Math.max(0, Math.round(n))));

export interface Sampler {
  state: SamplerState;
  tick(): Promise<void>;
}

export function createSampler(db: Db, server: { serverId: string; docker: DockerReader; host: () => Promise<HostReading> }, log: (msg: string, extra?: object) => void): Sampler {
  const { docker, host, serverId } = server;
  const state = newSamplerState();
  let prevCpu: CpuTimes | null = null;
  let dockerReachable = true;

  async function tick(): Promise<void> {
    const at = new Date();
    const rows: Row[] = [];

    const h = await host();
    const cpuPct = prevCpu && h.cpu ? cpuBusyPct(prevCpu, h.cpu) : null;
    prevCpu = h.cpu;
    state.host = {
      at,
      cpuPct,
      memUsedBytes: h.memUsedBytes,
      memTotalBytes: h.memTotalBytes,
      diskUsedBytes: h.disk?.usedBytes ?? null,
      diskTotalBytes: h.disk?.totalBytes ?? null,
    };
    // The first tick has no CPU baseline; a row without CPU would chart a false zero.
    if (cpuPct !== null) {
      rows.push({
        appId: null, at, cpuPct, memoryBytes: BigInt(h.memUsedBytes), pids: null, restarts: null,
        diskBytes: big(h.disk?.usedBytes), netRxBytes: big(h.net?.rx), netTxBytes: big(h.net?.tx),
        memTotalBytes: BigInt(h.memTotalBytes), diskTotalBytes: big(h.disk?.totalBytes),
      });
    }

    let listed;
    try {
      listed = await docker.listManaged();
      state.dockerSeen = true;
    } catch (e) {
      // The socket proxy comes up after this worker on a reboot: one line per outage, not one a tick.
      if (dockerReachable) log("metrics: container listing failed", { error: (e as Error).message });
      dockerReachable = false;
      listed = null;
    }
    if (listed) {
      let answered = true;
      // A container labelled for an app that is not on this server says nothing about that app.
      const known = new Set((await db.app.findMany({ where: appsHere(serverId), select: { id: true } })).map((a) => a.id));
      const picked = pickAppContainers(listed);
      const seen = new Set<string>();
      state.listed = new Set([...picked.keys()].filter((id) => known.has(id)));
      state.listedAt = at.getTime();
      // Serial on purpose: a one-shot stats call blocks about a second in the daemon.
      for (const [appId, c] of picked) {
        if (!known.has(appId)) continue;
        seen.add(appId);
        try {
          const insp = await docker.inspect(c.Id);
          const running = insp.State.Running && !insp.State.Restarting;
          const stats = running ? await docker.stats(c.Id) : null;
          const next: AppLatest = {
            at,
            containerId: c.Id,
            state: insp.State.Status,
            health: insp.State.Health?.Status ?? null,
            startedAt: insp.State.StartedAt || null,
            restartCount: insp.RestartCount,
            cpuPct: stats ? containerCpuPct(stats) : null,
            memBytes: stats ? containerMemBytes(stats) : null,
            memLimitBytes: insp.HostConfig?.Memory ?? stats?.memory_stats?.limit ?? 0,
          };
          noteRestarts(state, appId, state.apps.get(appId), next, at.getTime());
          state.apps.set(appId, next);
          if (!stats) continue;
          const net = containerNetTotals(stats);
          rows.push({
            appId, at, cpuPct: next.cpuPct ?? 0, memoryBytes: BigInt(next.memBytes ?? 0),
            pids: stats.pids_stats?.current ?? null, restarts: insp.RestartCount, diskBytes: null,
            netRxBytes: big(net.rx), netTxBytes: big(net.tx),
          });
        } catch (e) {
          // Gone between the listing and this read: a deploy swapped it, or it was deleted.
          if (isNotFound(e)) continue;
          if (e instanceof DockerError) {
            log("metrics: container read failed", { app: appId, error: e.message });
            continue;
          }
          // No answer at all: the rest of this list would only fail the same way.
          if (dockerReachable) log("metrics: container read failed", { app: appId, error: (e as Error).message });
          answered = false;
          break;
        }
      }
      dockerReachable = answered;
      for (const id of [...state.apps.keys()]) if (!seen.has(id)) state.apps.delete(id);
    }

    await insertSamples(db, rows);
  }

  return { state, tick };
}
