import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@dockify/db";
import { PermanentJobError } from "../errors.ts";
import { cachePruneArgs, duArgs } from "@dockify/engine";
import {
  buildCacheSlice, deletableById, imagesSlice, isBuildkitVolume, isPrunableRecord, parseCacheUsage, parsePrunedRecords,
  parsePruneTargets, removableImages, runPrune, sampleDisk, startDiskSampler, storedSlices, uniqueBytes, volumesSlice,
  type DiskDeps, type DiskDocker, type DiskSlice,
} from "./disk.ts";
import { DockerError, type DiskUsage, type DiskUsageImage, type DiskUsageVolume } from "@dockify/engine";
import { loadRetention } from "./janitor.ts";

const NOW = new Date(Date.UTC(2026, 10, 1, 12, 0, 0));
const HOUR = 3_600_000;
const GB = 1e9;
const ADDR = "unix:///run/buildkit/buildkitd.sock";
const ago = (ms: number) => Math.floor((NOW.getTime() - ms) / 1000);

/** A Dockify-built image two days old that nothing runs: the shape most of these start from. */
const img = (id: string, over: Partial<DiskUsageImage> = {}): DiskUsageImage => ({
  Id: `sha256:${id}`,
  RepoTags: [`dockify/app-x:${id}`],
  Labels: { "dockify.managed": "true", "dockify.app": "x" },
  Created: ago(48 * HOUR),
  Size: 2 * GB,
  SharedSize: 1.5 * GB,
  Containers: 0,
  ...over,
});

const day = (d: number) => new Date(Date.UTC(2026, 9, d));
const dep = (id: string, appId: string, status: string, imageId: string | null, d: number, previewId: string | null = null) => ({ id, appId, status, imageId, createdAt: day(d), previewId });

/**
 * App a builds from git, app b runs a pulled image. With one ready deployment kept per app beyond
 * the current one: a3 serves, a2 is a's rollback target, a1 and the failed a5 are past it, a4 is
 * building, pv1 is what a live preview serves. b2 serves, b1 is b's rollback target, b0 is past it.
 */
const ROWS = [
  dep("a1", "a", "ready", "sha256:r1", 1),
  dep("a2", "a", "ready", "sha256:r2", 2),
  dep("a3", "a", "ready", "sha256:r3", 3),
  dep("a4", "a", "building", null, 4),
  dep("a5", "a", "failed", "sha256:f5", 5),
  dep("pv1", "a", "ready", "sha256:pv", 6, "preview-1"),
  dep("b0", "b", "ready", "sha256:pulled0", 1),
  dep("b1", "b", "ready", "sha256:pulledOld", 2),
  dep("b2", "b", "ready", "sha256:pulledNew", 3),
];
const CONFIG = { keepReady: 1, deploymentRetentionDays: 90 };

const pulled = (id: string, over: Partial<DiskUsageImage> = {}) => img(id, { RepoTags: ["nginx:1.27"], Labels: null, ...over });

/** Every kind of image a host holds. Only r1, f5, dang and pulled0 may go. */
const IMAGES: DiskUsageImage[] = [
  img("r1"),
  img("r2"),
  img("r3", { Containers: 1 }),
  img("f5"),
  // A rebuild of the same deployment moved the tag: untagged, still labelled, nothing points at it.
  img("dang", { RepoTags: [], Size: 1 * GB, SharedSize: 1 * GB }),
  img("fresh", { Created: ago(10 * 60_000) }),
  img("unknown", { Containers: -1 }),
  img("pv"),
  // The previous Dockify release, pinned by digest: no tag, no label, nothing runs it.
  img("ctl", { RepoTags: [], Labels: null, Size: 0.4 * GB, SharedSize: 0 }),
  img("pg", { RepoTags: ["postgres:17.6-alpine"], Labels: null, Containers: 1 }),
  pulled("pulled0", { Size: 0.2 * GB, SharedSize: 0 }),
  pulled("pulledOld"),
  pulled("pulledNew", { Containers: 1 }),
];
const REMOVABLE = ["sha256:r1", "sha256:f5", "sha256:dang", "sha256:pulled0"];

const VOLUMES: DiskUsageVolume[] = [
  { Name: "dockify_dockify-buildkit", Labels: { "com.docker.compose.project": "dockify", "com.docker.compose.volume": "dockify-buildkit" }, UsageData: { Size: 30 * GB, RefCount: 1 } },
  { Name: "dockify_dockify-db", Labels: { "com.docker.compose.volume": "dockify-db" }, UsageData: { Size: 2 * GB, RefCount: 1 } },
  { Name: "dockify-data-0f0e0d0c", Labels: { "dockify.managed": "true" }, UsageData: { Size: 5 * GB, RefCount: 1 } },
  { Name: "nfs-share", Labels: null, UsageData: { Size: -1, RefCount: -1 } },
];

/** Exactly what buildctl du --format '{{json .}}' prints: client.UsageInfo with its json tags. */
const record = (id: string, size: number, over: Record<string, unknown> = {}) => ({
  id, mutable: false, inUse: false, size, createdAt: "2026-10-30T10:00:00.123456789Z", lastUsedAt: "2026-10-31T09:00:00Z",
  usageCount: 2, parents: ["parent-1"], description: "mount / from exec /bin/sh -c npm ci", recordType: "regular", shared: false, ...over,
});
const CACHE = [
  record("c1", 4 * GB),
  record("c2", 1 * GB, { inUse: true }),
  record("c3", 0.5 * GB, { recordType: "frontend" }),
  record("c4", 0.25 * GB, { recordType: "internal" }),
  record("c5", 2 * GB, { recordType: "exec.cachemount" }),
  record("c6", -1, { recordType: "source.local", lastUsedAt: null }),
  record("c7", 1 * GB, { shared: true }),
];
const DU = `${JSON.stringify(CACHE)}\n`;
const PRUNED = `${[record("c1", 4 * GB), record("c5", 2 * GB), record("c6", -1)].map((r) => JSON.stringify(r)).join("\n")}\n`;

function fakeDb(stored: unknown = null) {
  const writes: Array<{ where: unknown; data: { hostDisk: DiskSlice[]; hostDiskAt: Date } }> = [];
  const volumeRows: Array<{ id: string; name: string; sizeBytes: bigint | null }> = [];
  const jobs: Array<{ where: { id: string }; data: { payload: Record<string, unknown> } }> = [];
  const db = {
    deployment: { findMany: async () => ROWS },
    app: { findMany: async () => [{ currentDeploymentId: "a3" }, { currentDeploymentId: "b2" }] },
    previewDeployment: { findMany: async () => [{ currentDeploymentId: "pv1" }] },
    volume: {
      findMany: async ({ where }: { where: { name: { in: string[] } } }) => volumeRows.filter((r) => where.name.in.includes(r.name)),
      update: async ({ where, data }: { where: { id: string }; data: { sizeBytes: bigint } }) => Object.assign(volumeRows.find((r) => r.id === where.id)!, data),
    },
    instance: {
      findUnique: async () => ({ hostDisk: stored }),
      updateMany: async (a: (typeof writes)[number]) => {
        writes.push(a);
        return { count: 1 };
      },
    },
    job: {
      update: async (a: (typeof jobs)[number]) => {
        jobs.push(a);
        return {};
      },
    },
  } as unknown as Db;
  return { db, writes, jobs, volumeRows };
}

/** Answers each /system/df with the next frame (the last one repeats) and records every call. */
function fakeDocker(frames: DiskUsage[], failures: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let next = 0;
  const docker: DiskDocker = {
    diskUsage: async (types) => {
      calls.push(`df ${types.join(",")}`);
      return frames[Math.min(next++, frames.length - 1)]!;
    },
    removeImage: async (id) => {
      calls.push(`rm ${id}`);
      if (failures[id]) throw failures[id];
    },
  };
  return { docker, calls };
}

function fakeBuildctl(out: { du?: string | Error; prune?: string | Error } = {}) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const which = args.includes("prune") ? out.prune : out.du;
    if (which instanceof Error) throw which;
    return which ?? "";
  };
  return { run, calls };
}

/** The fake buildctl behind the Builder interface, with the same arguments the server's builder runs it with. */
const deps = ({ buildctl, ...over }: Partial<DiskDeps> & Pick<DiskDeps, "db" | "docker"> & { buildctl?: (args: string[]) => Promise<string> }): DiskDeps => ({
  config: CONFIG, serverId: "s1", now: () => NOW, log: () => {},
  builder: { cacheUsage: () => (buildctl ?? fakeBuildctl().run)(duArgs(ADDR)), pruneCache: () => (buildctl ?? fakeBuildctl().run)(cachePruneArgs(ADDR)) },
  ...over,
});
const slice = (slices: DiskSlice[], id: DiskSlice["id"]) => slices.find((s) => s.id === id);

afterEach(() => {
  vi.useRealTimers();
});

describe("buildctl output", () => {
  it("reads the du record list, an empty cache, and refuses anything that is not that list", () => {
    const got = parseCacheUsage(DU);
    expect(got).toHaveLength(7);
    expect(got[0]).toEqual({ id: "c1", inUse: false, size: 4 * GB, recordType: "regular", shared: false });
    expect(got[6]).toMatchObject({ id: "c7", shared: true });
    expect(parseCacheUsage("null\n")).toEqual([]);
    // A record without a type reads as regular, the type buildctl gives it.
    expect(parseCacheUsage(JSON.stringify([{ id: "x", inUse: false, size: 5 }]))[0]?.recordType).toBe("regular");
    expect(() => parseCacheUsage("")).toThrow(/printed nothing/);
    // The table buildctl prints without --format must never read as an empty cache.
    expect(() => parseCacheUsage("ID\tRECLAIMABLE\tSIZE\tLAST ACCESSED\nabc\ttrue\t1.20GB\t\nTotal:\t1.20GB\n")).toThrow(/did not print JSON/);
    expect(() => parseCacheUsage(JSON.stringify({ id: "x", inUse: false, size: 1 }))).toThrow(/list of cache records/);
    expect(() => parseCacheUsage(JSON.stringify([{ id: "x", size: 1 }]))).toThrow(/inUse/);
    expect(() => parseCacheUsage(JSON.stringify([{ id: "x", inUse: false, size: "1GB" }]))).toThrow(/size/);
  });

  it("reads one pruned record per line, and nothing pruned as no records", () => {
    expect(parsePrunedRecords(PRUNED).map((r) => [r.id, r.size])).toEqual([["c1", 4 * GB], ["c5", 2 * GB], ["c6", -1]]);
    expect(parsePrunedRecords("")).toEqual([]);
    expect(parsePrunedRecords("\n\n")).toEqual([]);
    expect(() => parsePrunedRecords("Total:\t6.00GB\n")).toThrow(/did not print JSON/);
  });

  it("asks for JSON and never for --all or a keep limit, so internal and frontend records stay", () => {
    expect(duArgs(ADDR)).toEqual(["--addr", ADDR, "du", "--format", "{{json .}}"]);
    expect(cachePruneArgs(ADDR)).toEqual(["--addr", ADDR, "prune", "--format", "{{json .}}"]);
  });

  it("counts every record in the cache slice and only what buildctl prune removes as reclaimable", () => {
    const recs = parseCacheUsage(DU);
    expect(recs.filter(isPrunableRecord).map((r) => r.id)).toEqual(["c1", "c5", "c6"]);
    // c6 is not sized yet (-1), so it adds nothing either way.
    expect(buildCacheSlice(recs)).toEqual({ id: "buildCache", bytes: 8.75 * GB, reclaimableBytes: 6 * GB, count: 7 });
    expect(buildCacheSlice([])).toEqual({ id: "buildCache", bytes: 0, reclaimableBytes: 0, count: 0 });
  });
});

describe("docker disk usage", () => {
  const own = { keep: new Set(["sha256:r2", "sha256:r3", "sha256:pv", "sha256:pulledOld", "sha256:pulledNew"]), referenced: new Set(ROWS.map((r) => r.imageId).filter((x): x is string => !!x)) };

  it("keeps the janitor's rollback images, live and in-flight images, and lists every image deployments point at", async () => {
    const { db } = fakeDb();
    const r = await loadRetention(db, CONFIG, NOW, "s1");
    expect([...r.plan.keepImages].sort()).toEqual([...own.keep].sort());
    expect([...r.referenced].sort()).toEqual([...own.referenced].sort());
  });

  it("picks only Dockify's own unused images: never a rollback target, a running or fresh image, or the control plane's", () => {
    const picked = removableImages(IMAGES, own, NOW.getTime()).map((i) => i.Id);
    expect(picked).toEqual(REMOVABLE);
    // The rollback target r2 is tagged and unused, exactly like r1; only the keep set tells them apart.
    expect(removableImages([img("r2")], own, NOW.getTime())).toEqual([]);
    expect(removableImages([img("r2")], { ...own, keep: new Set() }, NOW.getTime()).map((i) => i.Id)).toEqual(["sha256:r2"]);
    // One hour is the janitor's guard: a minute past it qualifies, a minute short does not.
    expect(removableImages([img("edge", { Created: ago(61 * 60_000) })], own, NOW.getTime())).toHaveLength(1);
    expect(removableImages([img("edge", { Created: ago(59 * 60_000) })], own, NOW.getTime())).toHaveLength(0);
    // A stopped container keeps its image too, and a missing creation time never reads as old.
    expect(removableImages([img("stopped", { Containers: 2 }), img("nodate", { Created: Number.NaN })], own, NOW.getTime())).toEqual([]);
  });

  it("leaves out an image Docker would refuse to remove by id without force, or one another image is built on", () => {
    expect(deletableById(img("one"))).toBe(true);
    expect(deletableById(img("none", { RepoTags: [], RepoDigests: [] }))).toBe(true);
    expect(deletableById(img("placeholder", { RepoTags: ["<none>:<none>"], RepoDigests: ["<none>@<none>"] }))).toBe(true);
    expect(deletableById(img("pulled", { RepoTags: ["nginx:1.27"], RepoDigests: ["nginx@sha256:abc"] }))).toBe(true);
    expect(deletableById(img("port", { RepoTags: ["localhost:5000/app:1"], RepoDigests: ["localhost:5000/app@sha256:abc"] }))).toBe(true);
    expect(deletableById(img("two", { RepoTags: ["nginx:1.27", "nginx:latest"] }))).toBe(false);
    expect(deletableById(img("repos", { RepoTags: ["nginx:1.27"], RepoDigests: ["mirror.example/nginx@sha256:abc"] }))).toBe(false);
    expect(deletableById(img("digests", { RepoTags: [], RepoDigests: ["a/x@sha256:1", "b/x@sha256:1"] }))).toBe(false);
    const none = { keep: new Set<string>(), referenced: new Set<string>() };
    const picked = removableImages([img("base"), img("child", { ParentId: "sha256:base" }), img("two", { RepoTags: ["dockify/app-x:a", "dockify/app-x:b"] })], none, NOW.getTime());
    expect(picked.map((i) => i.Id)).toEqual(["sha256:child"]);
  });

  it("sizes images once per shared layer and promises only bytes no other image shares", () => {
    const removable = removableImages(IMAGES, own, NOW.getTime());
    // r1 and f5 own 0.5 GB each, dang shares everything, pulled0 owns all of its 0.2 GB.
    expect(imagesSlice({ LayersSize: 40 * GB, Images: IMAGES }, removable)).toEqual({ id: "images", bytes: 40 * GB, reclaimableBytes: 1.2 * GB, count: 13 });
    expect(uniqueBytes(img("u", { SharedSize: -1 }))).toBe(0);
    expect(uniqueBytes(img("u", { Size: 1, SharedSize: 5 }))).toBe(0);
    // Without LayersSize: own bytes of each, plus the largest shared part, as a floor.
    expect(imagesSlice({ Images: [img("a", { Size: 3, SharedSize: 1 }), img("b", { Size: 4, SharedSize: 2 })] }, []).bytes).toBe(2 + 2 + 2);
    expect(imagesSlice({ LayersSize: 10, Images: [img("big")] }, [img("big", { Size: 50, SharedSize: 0 })]).reclaimableBytes).toBe(10);
    expect(imagesSlice({}, [])).toEqual({ id: "images", bytes: 0, reclaimableBytes: 0, count: 0 });
  });

  it("leaves BuildKit's own volume to the cache slice and never calls a volume reclaimable", () => {
    expect(VOLUMES.map(isBuildkitVolume)).toEqual([true, false, false, false]);
    expect(isBuildkitVolume({ Name: "dockify-buildkit" })).toBe(true);
    expect(isBuildkitVolume({ Name: "dk-0f0e-dockify-buildkit" })).toBe(false);
    expect(volumesSlice({ Volumes: VOLUMES })).toEqual({ id: "volumes", bytes: 7 * GB, reclaimableBytes: 0, count: 3 });
    expect(volumesSlice({ Volumes: null })).toEqual({ id: "volumes", bytes: 0, reclaimableBytes: 0, count: 0 });
  });

  it("drops stored rows that are not slices", () => {
    const good = { id: "images", bytes: 1, reclaimableBytes: 0, count: 1 };
    expect(storedSlices([good, { id: "logs", bytes: 1, reclaimableBytes: 0 }, { id: "images" }, null, "x"])).toEqual([good]);
    expect(storedSlices({ id: "images" })).toEqual([]);
  });
});

describe("disk sample", () => {
  const FULL: DiskUsage = { LayersSize: 40 * GB, Images: IMAGES, Volumes: VOLUMES };

  it("writes every slice, stamped with its start, and only over an older sample", async () => {
    const { db, writes } = fakeDb();
    const { docker, calls } = fakeDocker([FULL]);
    const out = await sampleDisk(deps({ db, docker, buildctl: fakeBuildctl({ du: DU }).run }), { volumes: true });
    const want = [
      { id: "images", bytes: 40 * GB, reclaimableBytes: 1.2 * GB, count: 13 },
      { id: "buildCache", bytes: 8.75 * GB, reclaimableBytes: 6 * GB, count: 7 },
      { id: "volumes", bytes: 7 * GB, reclaimableBytes: 0, count: 3 },
    ];
    expect(out.slices).toEqual(want);
    expect([...out.fresh].sort()).toEqual(["buildCache", "images", "volumes"]);
    expect(calls).toEqual(["df image,volume"]);
    expect(writes).toEqual([{ where: { id: 1, OR: [{ hostDiskAt: null }, { hostDiskAt: { lt: NOW } }] }, data: { hostDisk: want, hostDiskAt: NOW } }]);
  });

  it("records each app volume's size from the same read, so a new service never reads 0 B for hours", async () => {
    const { db, volumeRows } = fakeDb();
    volumeRows.push({ id: "v1", name: "dockify-data-0f0e0d0c", sizeBytes: 0n });
    await sampleDisk(deps({ db, docker: fakeDocker([FULL]).docker, buildctl: fakeBuildctl({ du: DU }).run }), { volumes: true });
    expect(volumeRows[0]!.sizeBytes).toBe(BigInt(5 * GB));
  });

  it("keeps a failed source's last slice and says so, and fails only when nothing answered", async () => {
    const stored = [{ id: "buildCache", bytes: 5, reclaimableBytes: 1, count: 2 }];
    const { db, writes } = fakeDb(stored);
    const log = vi.fn();
    const out = await sampleDisk(deps({ db, docker: fakeDocker([FULL]).docker, buildctl: fakeBuildctl({ du: new Error("connection refused") }).run, log }), { volumes: true });
    expect(slice(out.slices, "buildCache")).toEqual(stored[0]);
    expect(out.fresh.has("buildCache")).toBe(false);
    expect(log).toHaveBeenCalledWith("disk sample incomplete", { problems: ["buildctl du: connection refused"] });

    const broken = { diskUsage: async () => { throw new Error("timeout"); }, removeImage: async () => {} } satisfies DiskDocker;
    await expect(sampleDisk(deps({ db, docker: broken, buildctl: fakeBuildctl({ du: new Error("down") }).run }), { volumes: true })).rejects.toThrow(/no disk source answered/);
    expect(writes).toHaveLength(1);
  });

  it("never calls an image reclaimable without the retention rules", async () => {
    const stored = [{ id: "images", bytes: 9, reclaimableBytes: 0, count: 1 }];
    const { db } = fakeDb(stored);
    (db as unknown as { deployment: { findMany: () => Promise<never> } }).deployment.findMany = async () => { throw new Error("db down"); };
    const out = await sampleDisk(deps({ db, docker: fakeDocker([FULL]).docker, buildctl: fakeBuildctl({ du: DU }).run }), { volumes: true });
    expect(slice(out.slices, "images")).toEqual(stored[0]);
    expect(out.fresh.has("images")).toBe(false);
  });

  it("skips the volume walk when asked, unless no volume reading exists yet", async () => {
    const stored = [{ id: "volumes", bytes: 3, reclaimableBytes: 0, count: 1 }];
    const quick = fakeDocker([FULL]);
    const out = await sampleDisk(deps({ db: fakeDb(stored).db, docker: quick.docker, buildctl: fakeBuildctl({ du: DU }).run }), { volumes: false });
    expect(quick.calls).toEqual(["df image"]);
    expect(slice(out.slices, "volumes")).toEqual(stored[0]);
    const first = fakeDocker([FULL]);
    await sampleDisk(deps({ db: fakeDb().db, docker: first.docker, buildctl: fakeBuildctl({ du: DU }).run }), { volumes: false });
    expect(first.calls).toEqual(["df image,volume"]);
  });

  it("samples on a timer one pass at a time, and stop waits for the pass in flight", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    let started = 0;
    const docker: DiskDocker = {
      diskUsage: () => {
        started++;
        return new Promise<DiskUsage>((r) => {
          release = () => r(FULL);
        });
      },
      removeImage: async () => {},
    };
    const { db, writes } = fakeDb();
    const sampler = startDiskSampler(deps({ db, docker, buildctl: fakeBuildctl({ du: DU }).run }), { firstMs: 10, everyMs: 100 });
    await vi.advanceTimersByTimeAsync(10);
    expect(started).toBe(1);
    // Three more ticks while the first walk is still running: none starts a second one.
    await vi.advanceTimersByTimeAsync(300);
    expect(started).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(writes).toHaveLength(1);
    expect(started).toBe(2);
    const stopped = sampler.stop();
    release();
    await stopped;
    expect(writes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toBe(2);
  });
});

describe("prune job", () => {
  const STORED = [
    { id: "images", bytes: 40 * GB, reclaimableBytes: 1.2 * GB, count: 13 },
    { id: "buildCache", bytes: 8.75 * GB, reclaimableBytes: 6 * GB, count: 7 },
    { id: "volumes", bytes: 7 * GB, reclaimableBytes: 0, count: 3 },
  ];
  const BEFORE: DiskUsage = { LayersSize: 40 * GB, Images: IMAGES };
  const left = IMAGES.filter((i) => !["sha256:r1", "sha256:dang", "sha256:pulled0"].includes(i.Id));
  const conflict = new DockerError(409, "conflict: unable to remove repository reference (must force) - container abc is using its referenced image");
  const AFTER_DU = JSON.stringify(CACHE.filter((r) => !["c1", "c5", "c6"].includes(r.id)));

  it("removes only Dockify's own unused images and unused cache, never a rollback image, the control plane or a volume", async () => {
    const { db, writes, jobs } = fakeDb(STORED);
    // r1 and dang shared a 0.5 GB layer only with each other, so the slice shrinks by more than their own bytes.
    const { docker, calls } = fakeDocker([BEFORE, { LayersSize: 38_800_000_000, Images: left }], { "sha256:f5": conflict });
    const bk = fakeBuildctl({ prune: PRUNED, du: AFTER_DU });
    const report = await runPrune(deps({ db, docker, buildctl: bk.run }), { id: "job-1", payload: { targets: ["buildCache", "images"] } });

    expect(calls.filter((c) => c.startsWith("rm "))).toEqual(REMOVABLE.map((id) => `rm ${id}`));
    for (const keep of ["r2", "r3", "pv", "ctl", "pg", "fresh", "unknown", "pulledOld", "pulledNew"]) expect(calls, keep).not.toContain(`rm sha256:${keep}`);
    // Volumes are read, never touched: the only destructive call is an image removal, and the
    // sample after the prune leaves the volume walk to the timer.
    expect(calls.every((c) => c.startsWith("rm sha256:") || c === "df image")).toBe(true);
    expect(bk.calls).toEqual([cachePruneArgs(ADDR), duArgs(ADDR)]);
    expect(bk.calls.flat()).not.toContain("--all");

    // f5 gained a container meanwhile and stays. Images freed 1.2 GB (the slice shrinking beats
    // the 0.7 GB the removed images owned outright), the cache 6 GB.
    expect(report).toEqual({ reclaimedBytes: 7.2 * GB, imagesRemoved: 3, cacheRecordsRemoved: 3 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.where).toEqual({ id: "job-1" });
    expect(jobs[0]!.data.payload).toEqual({ targets: ["images", "buildCache"], result: { ...report, at: expect.any(String) } });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.data.hostDisk).toEqual([
      { id: "images", bytes: 38_800_000_000, reclaimableBytes: 0.5 * GB, count: 10 },
      { id: "buildCache", bytes: 2.75 * GB, reclaimableBytes: 0, count: 4 },
      STORED[2],
    ]);
  });

  it("never reports more freed than the removed images owned when the slice grew meanwhile", async () => {
    const { db } = fakeDb(STORED);
    // A build loaded a 1 GB image while the prune ran.
    const { docker } = fakeDocker([BEFORE, { LayersSize: 41 * GB, Images: left }]);
    const report = await runPrune(deps({ db, docker, buildctl: fakeBuildctl({ du: AFTER_DU }).run }), { id: "job-2", payload: { targets: ["images"] } });
    expect(report).toEqual({ reclaimedBytes: 1.2 * GB, imagesRemoved: 4, cacheRecordsRemoved: 0 });
  });

  it("fails a payload that names volumes, or nothing, before it touches the disk", async () => {
    for (const payload of [{ targets: ["volumes"] }, { targets: ["images", "volumes"] }, { targets: [] }, {}, null, { targets: "images" }]) {
      expect(() => parsePruneTargets(payload), JSON.stringify(payload)).toThrow(PermanentJobError);
      const { db, writes, jobs } = fakeDb(STORED);
      const { docker, calls } = fakeDocker([BEFORE]);
      const bk = fakeBuildctl({ prune: PRUNED, du: DU });
      await expect(runPrune(deps({ db, docker, buildctl: bk.run }), { id: "job-3", payload })).rejects.toThrow(PermanentJobError);
      expect(calls).toEqual([]);
      expect(bk.calls).toEqual([]);
      expect(writes).toEqual([]);
      expect(jobs).toEqual([]);
    }
    expect(parsePruneTargets({ targets: ["logs", "images", "logs"] })).toEqual(["images", "logs"]);
  });

  it("removes nothing for logs, which the worker cannot measure, and still reports", async () => {
    const { db, jobs } = fakeDb(STORED);
    const { docker, calls } = fakeDocker([BEFORE]);
    const bk = fakeBuildctl({ du: DU });
    expect(await runPrune(deps({ db, docker, buildctl: bk.run }), { id: "job-4", payload: { targets: ["logs"] } })).toEqual({ reclaimedBytes: 0, imagesRemoved: 0, cacheRecordsRemoved: 0 });
    expect(calls).toEqual(["df image"]);
    expect(bk.calls).toEqual([duArgs(ADDR)]);
    expect(jobs[0]!.data.payload).toMatchObject({ targets: ["logs"], result: { reclaimedBytes: 0 } });
  });

  it("fails on a Docker error other than in use or gone, and on a cache prune that fails", async () => {
    const boom = new DockerError(500, "driver failed");
    const a = fakeDb(STORED);
    await expect(runPrune(deps({ db: a.db, docker: fakeDocker([BEFORE], { "sha256:r1": boom }).docker, buildctl: fakeBuildctl({ du: DU }).run }), { id: "j", payload: { targets: ["images"] } })).rejects.toThrow(/driver failed/);
    expect(a.jobs).toEqual([]);
    const b = fakeDb(STORED);
    await expect(runPrune(deps({ db: b.db, docker: fakeDocker([BEFORE]).docker, buildctl: fakeBuildctl({ prune: new Error("buildkitd not reachable") }).run }), { id: "j", payload: { targets: ["buildCache"] } })).rejects.toThrow(/buildkitd/);
    expect(b.jobs).toEqual([]);
  });

  it("still reports what it removed when the sample after it fails", async () => {
    const { db, jobs } = fakeDb(STORED);
    let n = 0;
    const docker: DiskDocker = {
      diskUsage: async () => {
        if (n++ === 0) return BEFORE;
        throw new Error("df timed out");
      },
      removeImage: async () => {},
    };
    const log = vi.fn();
    const report = await runPrune(deps({ db, docker, buildctl: fakeBuildctl({ du: new Error("down") }).run, log }), { id: "job-5", payload: { targets: ["images"] } });
    // r1 0.5 + f5 0.5 + dang 0 + pulled0 0.2, the bytes those images owned outright.
    expect(report.reclaimedBytes).toBe(1.2 * GB);
    expect(log).toHaveBeenCalledWith("disk sample after a prune failed", expect.anything());
    expect(jobs).toHaveLength(1);
  });
});
