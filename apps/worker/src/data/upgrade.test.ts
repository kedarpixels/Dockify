/**
 * The version change's order and its promises, with the dump, replay and container work faked: those
 * have their own tests (pipeline.test.ts, managed.test.ts). What matters here is what happens in which
 * order, and what never happens: no container, volume or database of the old service is ever removed.
 */
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const fail: Record<string, string | undefined> = {};
const step = (name: string) => {
  calls.push(name);
  if (fail[name]) throw new Error(fail[name]);
};
let counts: Record<string, string> = {};
let linked: Array<{ id: string; name: string }> = [];

vi.mock("./pipeline.ts", () => ({
  checkExit: () => {},
  fetchVerified: async () => { step("verify"); return "/tmp/x"; },
  quiesce: async () => { step("quiesce"); return ["app-1", "app-2"]; },
  resume: async (_d: unknown, _j: unknown, _p: unknown, ids: string[]) => { step(`resume:${ids.join(",")}`); return []; },
  replayPostgres: async (_d: unknown, _t: unknown, _b: unknown, container: string) => { step(`replay:${container}`); },
  runBackup: async () => { step("backup"); },
  target: async (_d: unknown, id: string) => ({ containerId: id, creds: { user: "u", password: "p", database: "d" }, app: { id } }),
}));
vi.mock("./managed.ts", () => ({
  deployManagedService: async (_d: unknown, id: string) => { step(`deploy:${id}`); return { containerId: `c-${id}`, pin: "x@sha256:abc" }; },
}));
vi.mock("@dockify/db", () => ({ linkedApps: async () => linked }));

const { parseUpgradePayload, runServiceUpgrade } = await import("./upgrade.ts");

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";

function world() {
  const apps = new Map<string, Record<string, any>>([
    [SOURCE, { id: SOURCE, name: "db", kind: "postgres", image: "postgres:16-alpine", pinnedImage: "postgres:16-alpine@sha256:old", environmentId: "env", backupDestinationId: null, serviceRedirectId: null, serviceUpgrade: { phase: "backing_up", targetId: TARGET }, environment: { name: "production", project: { slug: "p" } } }],
    [TARGET, { id: TARGET, name: "db-pg17", kind: "postgres", image: "postgres:17-alpine", environmentId: "env", backupDestinationId: null, environment: { name: "production", project: { slug: "p" } } }],
    ["app-1", { id: "app-1", desiredState: "running", gitBranch: "main", currentDeployment: { imageId: "sha256:a", imageRef: "x", commitSha: "c" } }],
  ]);
  const deployments: any[] = [];
  const jobs: any[] = [];
  const activity: any[] = [];
  const dbx: any = {
    app: {
      findUnique: async ({ where }: any) => { const a = apps.get(where.id); return a ? { ...a } : null; },
      update: async ({ where, data }: any) => { calls.push(`update:${where.id === SOURCE ? "source" : where.id === TARGET ? "target" : where.id}:${Object.keys(data).join(",")}`); Object.assign(apps.get(where.id)!, data); return apps.get(where.id); },
    },
    backup: {
      create: async () => ({ id: "b1" }),
      findUnique: async () => ({ id: "b1", status: "ready", objectKey: "k" }),
    },
    backupDestination: { findFirst: async () => null },
    deployment: { create: async ({ data }: any) => { deployments.push(data); return { id: `d${deployments.length}` }; } },
    job: { findFirst: async () => null, create: async ({ data }: any) => { jobs.push(data); return { id: "j" }; } },
    activityLog: { create: async ({ data }: any) => { activity.push(data); return data; } },
    $executeRaw: async () => 0,
    $transaction: async (fn: any) => fn(dbx),
  };
  const docker = {
    exec: async (id: string) => {
      const out = new PassThrough();
      out.end(counts[id] ?? "3,10\n");
      return { stdout: out, done: Promise.resolve({ exitCode: 0, stderr: "" }) };
    },
    remove: vi.fn(async () => {}),
    removeVolume: vi.fn(async () => {}),
  };
  const deps: any = { db: dbx, docker, vault: {}, tmpDir: "/tmp", now: () => new Date("2026-11-06T00:00:00Z") };
  return { apps, deployments, jobs, activity, docker, deps };
}

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(fail)) delete fail[k];
  counts = {};
  linked = [];
});

const stateOf = (w: ReturnType<typeof world>) => w.apps.get(SOURCE)!.serviceUpgrade;

describe("parseUpgradePayload", () => {
  it("refuses a payload it cannot trust", () => {
    expect(() => parseUpgradePayload({ action: "drop" })).toThrow(/action/);
    expect(() => parseUpgradePayload({ action: "switch", sourceId: "x", targetId: TARGET })).toThrow(/sourceId/);
    expect(() => parseUpgradePayload(null)).toThrow();
  });
  it("keeps only ids in the quiesced list", () => {
    const p = parseUpgradePayload({ action: "switch", sourceId: SOURCE, targetId: TARGET, quiesced: [SOURCE, "; rm -rf /", 3] });
    expect(p).toMatchObject({ quiesced: [SOURCE] });
  });
});

describe("in place", () => {
  const payload = { action: "in_place", sourceId: SOURCE, toImage: "redis:8.2-alpine", toVersion: "8.2" } as const;

  it("takes the backup before touching the image, then deploys", async () => {
    const w = world();
    await runServiceUpgrade(w.deps, "job", payload);
    const backup = calls.indexOf("backup");
    const image = calls.findIndex((c) => c.startsWith("update:source:image,pinnedImage"));
    expect(backup).toBeGreaterThan(-1);
    expect(backup).toBeLessThan(image);
    expect(image).toBeLessThan(calls.indexOf(`deploy:${SOURCE}`));
    expect(w.apps.get(SOURCE)).toMatchObject({ image: "redis:8.2-alpine", status: "running" });
    expect(stateOf(w).phase).toBe("done");
  });

  it("a failed backup changes nothing and runs no deploy", async () => {
    fail.backup = "no destination";
    const w = world();
    await expect(runServiceUpgrade(w.deps, "job", payload)).rejects.toThrow("no destination");
    expect(calls.some((c) => c.startsWith("deploy:"))).toBe(false);
    expect(w.apps.get(SOURCE)).toMatchObject({ image: "postgres:16-alpine", pinnedImage: "postgres:16-alpine@sha256:old" });
    expect(stateOf(w)).toMatchObject({ phase: "failed", error: "no destination" });
  });

  it("a failed deploy puts the old image and pin back", async () => {
    fail[`deploy:${SOURCE}`] = "did not come up";
    const w = world();
    await expect(runServiceUpgrade(w.deps, "job", payload)).rejects.toThrow("did not come up");
    expect(w.apps.get(SOURCE)).toMatchObject({ image: "postgres:16-alpine", pinnedImage: "postgres:16-alpine@sha256:old" });
    expect(w.activity.at(-1)).toMatchObject({ failed: true });
  });
});

describe("prepare", () => {
  const payload = { action: "prepare", sourceId: SOURCE, targetId: TARGET, toVersion: "17" } as const;

  it("backs up, starts the new service, replays, counts, and touches no link or app", async () => {
    counts = { [TARGET]: "0,0\n" };
    const w = world();
    // The new service is empty when protected, and full once the replay has run.
    const exec = w.docker.exec;
    w.docker.exec = (async (id: string) => {
      if (id === TARGET && calls.includes(`replay:${TARGET}`)) counts[TARGET] = "3,10\n";
      return exec(id);
    }) as typeof w.docker.exec;
    await runServiceUpgrade(w.deps, "job", payload);
    expect(calls.filter((c) => c === "backup")).toHaveLength(1);
    expect(calls.indexOf("backup")).toBeLessThan(calls.indexOf(`deploy:${TARGET}`));
    expect(calls.indexOf(`deploy:${TARGET}`)).toBeLessThan(calls.indexOf(`replay:${TARGET}`));
    expect(stateOf(w)).toMatchObject({ phase: "ready", source: { tables: 3, rows: 10 }, target: { tables: 3, rows: 10 } });
    expect(w.apps.get(SOURCE)!.serviceRedirectId).toBeNull();
    expect(calls).not.toContain("quiesce");
    expect(w.deployments).toHaveLength(0);
  });

  it("a copy over a service that already holds tables backs that one up first", async () => {
    const w = world();
    await runServiceUpgrade(w.deps, "job", payload);
    expect(calls.filter((c) => c === "backup")).toHaveLength(2);
    expect(calls.lastIndexOf("backup")).toBeLessThan(calls.indexOf(`replay:${TARGET}`));
  });

  it("a copy missing tables is a failed copy", async () => {
    counts = { [SOURCE]: "5,10\n", [TARGET]: "3,10\n" };
    const w = world();
    await expect(runServiceUpgrade(w.deps, "job", payload)).rejects.toThrow(/3 tables/);
    expect(stateOf(w).phase).toBe("failed");
  });

  it("refuses anything but Postgres", async () => {
    const w = world();
    w.apps.get(SOURCE)!.kind = "redis";
    await expect(runServiceUpgrade(w.deps, "job", payload)).rejects.toThrow(/Only Postgres/);
    expect(calls.filter((c) => !c.startsWith("update:"))).toEqual([]);
  });
});

describe("switch", () => {
  const payload = { action: "switch", sourceId: SOURCE, targetId: TARGET } as const;

  it("stops the apps, copies fresh, then sets the one column and queues the linked redeploys together", async () => {
    linked = [{ id: "app-1", name: "web" }];
    const w = world();
    await runServiceUpgrade(w.deps, "job", payload);
    expect(calls.indexOf("quiesce")).toBeLessThan(calls.indexOf("backup"));
    expect(calls.lastIndexOf("backup")).toBeLessThan(calls.indexOf(`replay:${TARGET}`));
    expect(calls.indexOf(`replay:${TARGET}`)).toBeLessThan(calls.findIndex((c) => c.includes("serviceRedirectId")));
    expect(w.apps.get(SOURCE)!.serviceRedirectId).toBe(TARGET);
    expect(stateOf(w).phase).toBe("switched");
    expect(w.deployments).toEqual([expect.objectContaining({ appId: "app-1", trigger: "redeploy", imageId: "sha256:a", actorName: "Dockify" })]);
    expect(w.jobs).toEqual([expect.objectContaining({ kind: "deploy", dedupeKey: "deploy:app-1" })]);
    // The linked app comes back through its redeploy; the others are started as they were.
    expect(calls.filter((c) => c.startsWith("resume:"))).toEqual(["resume:app-2"]);
  });

  it("different counts switch nothing, and every app starts again on the old database", async () => {
    counts = { [SOURCE]: "3,11\n", [TARGET]: "3,10\n" };
    linked = [{ id: "app-1", name: "web" }];
    const w = world();
    await expect(runServiceUpgrade(w.deps, "job", payload)).rejects.toThrow(/does not match/);
    expect(w.apps.get(SOURCE)!.serviceRedirectId).toBeNull();
    expect(w.deployments).toHaveLength(0);
    expect(calls.filter((c) => c.startsWith("resume:"))).toEqual(["resume:app-1,app-2"]);
    expect(stateOf(w)).toMatchObject({ phase: "failed", failedAt: "switch" });
  });

  it("a failed replay also leaves the links where they were and starts the apps", async () => {
    fail[`replay:${TARGET}`] = "psql exited";
    const w = world();
    await expect(runServiceUpgrade(w.deps, "job", payload)).rejects.toThrow("psql exited");
    expect(w.apps.get(SOURCE)!.serviceRedirectId).toBeNull();
    expect(calls.filter((c) => c.startsWith("resume:"))).toEqual(["resume:app-1,app-2"]);
  });

  it("refuses two services of different environments", async () => {
    const w = world();
    w.apps.get(TARGET)!.environmentId = "other";
    await expect(runServiceUpgrade(w.deps, "job", payload)).rejects.toThrow(/no longer exists/);
    expect(calls).not.toContain("quiesce");
  });

  it("an app with a deploy already open gets a pending mark, never a second job", async () => {
    linked = [{ id: "app-1", name: "web" }];
    const w = world();
    w.deps.db.job.findFirst = async () => ({ id: "open" });
    await runServiceUpgrade(w.deps, "job", payload);
    expect(w.deployments).toHaveLength(0);
    expect(w.apps.get("app-1")!.pendingDeployAt).toBeInstanceOf(Date);
  });
});

describe("what never happens", () => {
  it("no path removes a container or a volume", async () => {
    for (const p of [
      { action: "in_place", sourceId: SOURCE, toImage: "postgres:16-alpine", toVersion: "16" },
      { action: "prepare", sourceId: SOURCE, targetId: TARGET, toVersion: "17" },
      { action: "switch", sourceId: SOURCE, targetId: TARGET },
    ] as const) {
      const w = world();
      await runServiceUpgrade(w.deps, "job", p);
      expect(w.docker.remove).not.toHaveBeenCalled();
      expect(w.docker.removeVolume).not.toHaveBeenCalled();
    }
  });
});
