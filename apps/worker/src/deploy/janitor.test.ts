import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { UNUSED_VOLUMES_ACTION } from "../data/volumes.ts";
import type { DeployConfig } from "./config.ts";
import { DockerError, type DiskUsageVolume, type DockerApi } from "@dockify/engine";
import { ORPHAN_GRACE_MS, ORPHANS_ACTION, PARKED_ACTION, removeDeletedAppImages, removeOrphanContainers, reportParked, runJanitor } from "./janitor.ts";

describe("images of deleted apps", () => {
  const GONE = "0f0e0d0c-0000-4000-8000-0000000000aa";
  const LIVE = "0f0e0d0c-0000-4000-8000-0000000000bb";
  const summary = (Id: string, RepoTags: string[]) => ({ Id, RepoTags, Labels: { "dockify.managed": "true" }, Size: 100, Created: Math.floor(Date.now() / 1000) });
  const db = { app: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => id === LIVE).map((id) => ({ id })) } } as unknown as Db;

  it("removes by tag whatever its age, and leaves a live app's and anyone else's", async () => {
    const removed: string[] = [];
    const docker = {
      listImages: async () => [summary("i1", [`dockify/app-${GONE}:abc`, `dockify/app-${GONE}:def`]), summary("i2", [`dockify/app-${LIVE}:abc`]), summary("i3", ["nginx:1.27"]), summary("i4", [])],
      removeImage: async (ref: string) => void removed.push(ref),
    };
    // A fresh build of a deleted app goes too: no deploy of it can be about to use it.
    expect(await removeDeletedAppImages(db, docker, "s1")).toEqual({ removed: 2, bytes: 100 });
    expect(removed).toEqual([`dockify/app-${GONE}:abc`, `dockify/app-${GONE}:def`]);
  });

  it("leaves one a container still uses for the next pass, and passes on any other failure", async () => {
    const list = async () => [summary("i1", [`dockify/app-${GONE}:abc`])];
    const conflict = { listImages: list, removeImage: async () => { throw new DockerError(409, "in use"); } };
    expect(await removeDeletedAppImages(db, conflict, "s1")).toEqual({ removed: 0, bytes: 0 });
    const broken = { listImages: list, removeImage: async () => { throw new DockerError(500, "boom"); } };
    await expect(removeDeletedAppImages(db, broken, "s1")).rejects.toThrow("boom");
  });
});

describe("containers of deleted apps", () => {
  const GONE = "0f0e0d0c-0000-4000-8000-0000000000aa";
  const LIVE = "0f0e0d0c-0000-4000-8000-0000000000bb";
  const NOW = new Date("2026-11-07T12:00:00.000Z");
  const OLD = (NOW.getTime() - ORPHAN_GRACE_MS - 1000) / 1000;
  /** What Docker lists: every tenant container carries these labels, blank unless set. */
  const box = (Id: string, name: string, app: string, over: { Labels?: Record<string, string>; Created?: number } = {}) => ({
    Id, Names: [`/${name}`], Image: "x", ImageID: "x", State: "exited", Created: over.Created ?? OLD,
    Labels: { "dockify.managed": "true", "dockify.app": app, "com.docker.compose.project": "", "com.docker.compose.service": "", "dockify.preview": "", "dockify.preview.app": "", ...over.Labels },
  });
  const world = (containers: Array<ReturnType<typeof box>>) => {
    const removed: string[] = [];
    const activity: Array<Record<string, unknown>> = [];
    const db = {
      app: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((id) => id === LIVE).map((id) => ({ id })) },
      activityLog: { create: async ({ data }: { data: Record<string, unknown> }) => void activity.push(data) },
    } as unknown as Db;
    const docker = { listContainers: async () => containers, removeContainer: async (id: string) => void removed.push(id) };
    return { db, docker, removed, activity };
  };

  it("removes a deleted app's containers, its parked and one-off ones too, and records it", async () => {
    const w = world([box("c1", `dk-${GONE}`, GONE), box("c2", `dk-${GONE}-prev-abc`, GONE)]);
    expect(await removeOrphanContainers(w.db, w.docker, NOW)).toEqual([`dk-${GONE}`, `dk-${GONE}-prev-abc`]);
    expect(w.removed).toEqual(["c1", "c2"]);
    expect(w.activity[0]).toMatchObject({ action: ORPHANS_ACTION, category: "system" });
  });

  it("never touches a live app, a new container, or anything that does not prove it is an app's", async () => {
    const w = world([
      box("live", `dk-${LIVE}`, LIVE),
      box("young", `dk-${GONE}`, GONE, { Created: (NOW.getTime() - ORPHAN_GRACE_MS + 60_000) / 1000 }),
      box("control", "dockify-api", GONE),
      box("control2", `dk-${GONE}`, GONE, { Labels: { "com.docker.compose.project": "dockify" } }),
      box("preview", `dk-${GONE}`, GONE, { Labels: { "dockify.preview": "e1" } }),
      box("previewName", `dk-pv-${GONE}`, GONE),
      box("other", "dk-0f0e0d0c-0000-4000-8000-0000000000cc", GONE),
      box("near", `dk-${GONE}x`, GONE),
      box("noApp", `dk-${GONE}`, ""),
      box("badApp", "dk-web", "web"),
      box("notManaged", `dk-${GONE}`, GONE, { Labels: { "dockify.managed": "false" } }),
      box("noDate", `dk-${GONE}`, GONE, { Created: 0 }),
    ]);
    expect(await removeOrphanContainers(w.db, w.docker, NOW)).toEqual([]);
    expect(w.removed).toEqual([]);
    expect(w.activity).toEqual([]);
  });

  it("carries on past one it cannot remove, and logs it", async () => {
    const w = world([box("c1", `dk-${GONE}`, GONE), box("c2", `dk-${GONE}-prev-abc`, GONE)]);
    const logged: string[] = [];
    const docker = { ...w.docker, removeContainer: async (id: string) => { if (id === "c1") throw new DockerError(500, "boom"); w.removed.push(id); } };
    expect(await removeOrphanContainers(w.db, docker, NOW, (m) => logged.push(m))).toEqual([`dk-${GONE}-prev-abc`]);
    expect(logged).toEqual(["could not remove an orphaned container"]);
  });
});

const config = { keepReady: 3, deploymentRetentionDays: 90, buildCacheBytes: 1024 ** 3 } as DeployConfig;

function deps(volumes: DiskUsageVolume[] | null) {
  const activity: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const rows = [{ id: "v1", name: "dockify-data-x", sizeBytes: null as bigint | null }];
  const db = {
    deployment: { findMany: async () => [] },
    app: { findMany: async () => [] },
    previewDeployment: { findMany: async () => [] },
    volume: {
      findMany: async ({ where }: { where: { name: { in: string[] } } }) => rows.filter((r) => where.name.in.includes(r.name)),
      update: async ({ where, data }: { where: { id: string }; data: { sizeBytes: bigint } }) => Object.assign(rows.find((r) => r.id === where.id)!, data),
    },
    activityLog: {
      findFirst: async () => activity.at(-1) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => (activity.push(data), data),
    },
  } as unknown as Db;
  const docker = {
    listImages: async () => [],
    removeImage: async (id: string) => void calls.push(`removeImage:${id}`),
    inspectImage: async () => {
      throw new Error("not used");
    },
  } as unknown as DockerApi;
  return {
    activity,
    calls,
    rows,
    deps: { db, docker, config, serverId: "s1", builder: { trimCache: async () => "" }, ...(volumes ? { volumes: async () => volumes } : {}) },
  };
}

describe("containers an interrupted deploy left parked", () => {
  const A = "0f0e0d0c-0000-4000-8000-0000000000aa";
  const B = "0f0e0d0c-0000-4000-8000-0000000000bb";
  const row = (app: string, name: string) => ({ Id: name, Names: [`/${name}`], Image: "", ImageID: "", State: "exited", Labels: { "dockify.app": app, "dockify.managed": "true" } });
  function world(busyApps: string[] = []) {
    const activity: Array<{ action: string; verb: string; suffix: string | null; changes: unknown }> = [];
    const db = {
      deployment: { findMany: async ({ where }: { where: { appId: { in: string[] } } }) => where.appId.in.filter((a) => busyApps.includes(a)).map((appId) => ({ appId })) },
      activityLog: {
        findFirst: async () => activity.at(-1) ?? null,
        create: async ({ data }: { data: (typeof activity)[number] }) => (activity.push(data), data),
      },
    } as unknown as Db;
    return { db, activity };
  }
  const now = new Date("2026-11-07T00:00:00Z");

  it("reports them once per set, and again when the set empties", async () => {
    const { db, activity } = world();
    const docker = { listContainers: async () => [row(A, `dk-${A}-prev-k1`), row(B, `dk-${B}`)] };
    expect(await reportParked(db, docker, "s1", now)).toEqual([`dk-${A}-prev-k1`]);
    expect(activity[0]).toMatchObject({ action: PARKED_ACTION, verb: "found 1 container an interrupted deploy left parked on", suffix: expect.stringMatching(/Deploy each app again/) });
    await reportParked(db, docker, "s1", now);
    expect(activity).toHaveLength(1);
    await reportParked(db, { listContainers: async () => [] }, "s1", now);
    expect(activity[1]).toMatchObject({ verb: "found no containers left parked on", suffix: null });
  });

  it("says nothing about one a running deploy holds", async () => {
    const { db, activity } = world([A]);
    expect(await reportParked(db, { listContainers: async () => [row(A, `dk-${A}-prev-k1`)] }, "s1", now)).toEqual([]);
    expect(activity).toHaveLength(0);
  });
});

describe("janitor volume report", () => {
  it("lists the unused anonymous volumes in Activity and removes none", async () => {
    const leaked = ["1", "2", "3", "4", "5"].map((c) => ({ Name: c.repeat(64), Labels: { "com.docker.volume.anonymous": "" }, UsageData: { Size: 4096, RefCount: 0 } }));
    const t = deps([...leaked, { Name: "dockify-data-x", Labels: null, UsageData: { Size: 1, RefCount: 1 } }]);
    const report = await runJanitor(t.deps);
    expect(report.unusedVolumes).toBe(5);
    expect(t.activity).toHaveLength(1);
    expect(t.activity[0]).toMatchObject({ action: UNUSED_VOLUMES_ACTION, verb: "found 5 unused anonymous volumes on" });
    expect(t.calls).toEqual([]);
    // The same read records the size of each app volume Dockify knows.
    expect(t.rows[0]!.sizeBytes).toBe(1n);
  });

  it("reports nothing when it cannot read volumes, and never fails the pass for it", async () => {
    const t = deps(null);
    expect((await runJanitor(t.deps)).unusedVolumes).toBeNull();
    const broken = deps([]);
    const report = await runJanitor({ ...broken.deps, volumes: async () => { throw new Error("df timed out"); } });
    expect(report.unusedVolumes).toBeNull();
  });
});
