import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assertRoomToBuild, diskVerdict, hostDiskUsage, MIN_FREE_BYTES, statfsUsage } from "../deploy/disk-guard.ts";
import { PermanentDeployError } from "@dockify/engine";
import { readHost, type HostReading } from "@dockify/engine";

const reading = (disk: HostReading["disk"]): HostReading => ({ cpu: null, memUsedBytes: 1, memTotalBytes: 2, disk, net: null });

describe("the disk guard, through the server's host reading", () => {
  it("reads the same figures statfs gives it directly", async () => {
    const path = tmpdir();
    const [through, direct] = [await hostDiskUsage(() => readHost(path))(), await statfsUsage(path)()];
    expect(through.totalBytes).toBe(direct.totalBytes);
    // Another process can write between the two reads; the verdict is what must agree.
    expect(Math.abs(through.freeBytes - direct.freeBytes)).toBeLessThan(1024 ** 3);
    expect(diskVerdict(through).floorBytes).toBe(diskVerdict(direct).floorBytes);
  });

  it("judges free space by what a writer can use, and refuses near full", async () => {
    const total = 100 * 1024 ** 3;
    const low = reading({ usedBytes: total - MIN_FREE_BYTES, totalBytes: total, freeBytes: MIN_FREE_BYTES - 1 });
    await expect(assertRoomToBuild(hostDiskUsage(async () => low))).rejects.toThrow(PermanentDeployError);
    const room = reading({ usedBytes: 0, totalBytes: total, freeBytes: 50 * 1024 ** 3 });
    await expect(assertRoomToBuild(hostDiskUsage(async () => room))).resolves.toBeUndefined();
  });

  it("a host that cannot say stops nothing, as a disk it cannot read never did", async () => {
    await expect(assertRoomToBuild(hostDiskUsage(async () => reading(null)))).resolves.toBeUndefined();
    await expect(assertRoomToBuild(hostDiskUsage(async () => { throw new Error("link down"); }))).resolves.toBeUndefined();
  });
});
