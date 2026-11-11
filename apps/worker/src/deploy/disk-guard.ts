/**
 * The common ext4 install has no per-container disk quota (--storage-opt size needs xfs with pquota). So builds
 * and pulls are refused near full, and a reserve file is given up when the disk is nearly gone, which buys time.
 */
import { open, rm, stat, statfs } from "node:fs/promises";
import { PermanentDeployError } from "@dockify/engine";
import type { WorkerHealth } from "../health.ts";
import type { HostReading } from "@dockify/engine";

const GiB = 1024 ** 3;
export const MIN_FREE_BYTES = 3 * GiB;
export const MIN_FREE_PCT = 5;
export const CRITICAL_FREE_BYTES = GiB;
export const RESERVE_BYTES = GiB;
export const RESERVE_PCT = 2;
export const DISK_LOW_ISSUE = "disk_low";

export interface DiskUsage {
  freeBytes: number;
  totalBytes: number;
}
export type DiskUsageReader = () => Promise<DiskUsage>;

export const statfsUsage = (path: string): DiskUsageReader => async () => {
  const s = await statfs(path);
  return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
};

export const hostDiskUsage = (host: () => Promise<HostReading>): DiskUsageReader => async () => {
  const { disk } = await host();
  if (!disk) throw new Error("the host reading has no disk");
  return { freeBytes: disk.freeBytes, totalBytes: disk.totalBytes };
};

const gib = (n: number) => `${(n / GiB).toFixed(1)} GiB`;

export function diskVerdict(u: DiskUsage): { low: boolean; floorBytes: number } {
  const floorBytes = Math.max(MIN_FREE_BYTES, (u.totalBytes * MIN_FREE_PCT) / 100);
  return { low: u.freeBytes < floorBytes, floorBytes };
}

const lowMessage = (u: DiskUsage, floorBytes: number) =>
  `The server's disk has ${gib(u.freeBytes)} free, under the ${gib(floorBytes)} Dockify keeps for itself. Free some space (Server, Prune), then deploy again.`;

/** Throws before a build or a pull on a disk that is near full. A disk it cannot read stops nothing. */
export async function assertRoomToBuild(read: DiskUsageReader): Promise<void> {
  const u = await read().catch(() => null);
  if (!u) return;
  const { low, floorBytes } = diskVerdict(u);
  if (low) throw new PermanentDeployError(lowMessage(u, floorBytes));
}

export interface DiskFs {
  usage: DiskUsageReader;
  exists(path: string): Promise<boolean>;
  /** Writes real blocks: a sparse file would hold no room at all. */
  create(path: string, bytes: number): Promise<void>;
  remove(path: string): Promise<void>;
}

const CHUNK = 1024 ** 2;

export const realDiskFs = (diskPath: string): DiskFs => ({
  usage: statfsUsage(diskPath),
  exists: (p) => stat(p).then(() => true, () => false),
  async create(p, bytes) {
    const f = await open(p, "w", 0o600);
    try {
      const zeros = Buffer.alloc(CHUNK);
      for (let done = 0; done < bytes; done += CHUNK) await f.write(zeros, 0, Math.min(CHUNK, bytes - done));
      await f.sync();
    } catch (e) {
      await f.close().catch(() => {});
      await rm(p, { force: true }).catch(() => {});
      throw e;
    }
    await f.close();
  },
  remove: (p) => rm(p, { force: true }),
});

export interface DiskReserveDeps {
  path: string;
  fs: DiskFs;
  health: WorkerHealth;
  log: (msg: string, extra?: object) => void;
}

/** One pass a minute, off the job lanes. Never throws: a reserve that cannot be written is only less room later. */
export class DiskReserve {
  readonly #d: DiskReserveDeps;
  constructor(deps: DiskReserveDeps) {
    this.#d = deps;
  }

  async tick(): Promise<void> {
    const { fs, health, log, path } = this.#d;
    try {
      const u = await fs.usage();
      const { low, floorBytes } = diskVerdict(u);
      if (low) {
        if (health.set(DISK_LOW_ISSUE, "the disk is nearly full; new builds are refused", lowMessage(u, floorBytes))) log("the disk is nearly full; new builds are refused", { freeBytes: u.freeBytes, floorBytes });
      } else if (health.clear(DISK_LOW_ISSUE)) {
        log("the disk has room again; builds run", { freeBytes: u.freeBytes });
      }
      const has = await fs.exists(path);
      if (has && u.freeBytes < CRITICAL_FREE_BYTES) {
        await fs.remove(path);
        log("gave up the disk reserve so the control plane has room to run", { freeBytes: u.freeBytes });
        return;
      }
      const want = Math.min(RESERVE_BYTES, Math.floor((u.totalBytes * RESERVE_PCT) / 100));
      if (!has && u.freeBytes > floorBytes + want) await fs.create(path, want);
    } catch (e) {
      log("the disk guard could not run", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}
