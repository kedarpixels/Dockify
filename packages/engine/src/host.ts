/**
 * Host readings. The worker sees the host kernel's /proc, so these are the box, not the container.
 * Each read degrades to null instead of throwing, so one missing file never loses a whole tick.
 */
import { readFile, statfs } from "node:fs/promises";
import os from "node:os";

export interface HostReading {
  cpu: CpuTimes | null;
  memUsedBytes: number;
  memTotalBytes: number;
  /** freeBytes is what an unprivileged writer can still use (bavail), the figure the disk guard judges by. */
  disk: { usedBytes: number; totalBytes: number; freeBytes: number } | null;
  net: { rx: number; tx: number } | null;
}

const read = (p: string): Promise<string | null> => readFile(p, "utf8").catch(() => null);

function osCpu(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

export async function readHost(diskPath: string): Promise<HostReading> {
  const [stat, mem, net] = await Promise.all([read("/proc/stat"), read("/proc/meminfo"), read("/proc/net/dev")]);
  const memInfo = mem ? parseMeminfo(mem) : null;
  const memTotal = memInfo?.totalBytes ?? os.totalmem();
  const memAvail = memInfo?.availableBytes ?? os.freemem();
  let disk: HostReading["disk"] = null;
  try {
    const st = await statfs(diskPath);
    disk = { totalBytes: st.blocks * st.bsize, usedBytes: (st.blocks - st.bfree) * st.bsize, freeBytes: st.bavail * st.bsize };
  } catch {
    disk = null;
  }
  return {
    cpu: (stat ? parseProcStat(stat) : null) ?? osCpu(),
    memUsedBytes: Math.max(0, memTotal - memAvail),
    memTotalBytes: memTotal,
    disk,
    net: net ? parseNetDev(net) : null,
  };
}

export interface CpuTimes {
  idle: number;
  total: number;
}

/** The aggregate "cpu" line of /proc/stat. iowait counts as idle; steal counts as busy. */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split("\n").find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  if (v.length < 4 || v.some((x) => !Number.isFinite(x))) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = v;
  return { idle: idle + iowait, total: user + nice + system + idle + iowait + irq + softirq + steal };
}

/** MemTotal and MemAvailable from /proc/meminfo, in bytes. MemAvailable is what "used" should subtract. */
export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } | null {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb("MemTotal");
  const avail = kb("MemAvailable") ?? kb("MemFree");
  return total === null || avail === null ? null : { totalBytes: total, availableBytes: avail };
}

/** Summed rx and tx bytes of /proc/net/dev, skipping loopback and Docker's virtual interfaces. */
export function parseNetDev(text: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const raw of text.split("\n").slice(2)) {
    const idx = raw.indexOf(":");
    if (idx < 0) continue;
    const name = raw.slice(0, idx).trim();
    if (name === "lo" || /^(veth|docker|br-|virbr|cni|flannel|cali)/.test(name)) continue;
    const f = raw.slice(idx + 1).trim().split(/\s+/).map(Number);
    rx += f[0] ?? 0;
    tx += f[8] ?? 0;
  }
  return { rx, tx };
}
