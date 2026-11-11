/**
 * A restore holds an app while it replaces its data. A deploy job queued by any path makes no container
 * for it, and a push kept as pending is not promoted until the restore lets go.
 */
import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { PermanentDeployError } from "@dockify/engine";
import { runPower } from "../power.ts";
import { assertNotHeldByRestore, handleDeploy, promotePending, type DeployDeps } from "./pipeline.ts";

const DEP = "0f0e0d0c-0000-4000-8000-0000000000d1";
const APP = "0f0e0d0c-0000-4000-8000-0000000000a1";
const untouched = (name: string) => new Proxy({}, { get: () => { throw new Error(`${name} touched`); } });

describe("an app held by a restore", () => {
  it("is refused by the deploy pipeline before any container, with the reason on the deployment", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const app = { id: APP, name: "storage", kind: "backend", deployTarget: "server", environment: { projectId: "p", project: {} }, volumes: [], domains: [] };
    const db = {
      deployment: {
        findUnique: async () => ({ id: DEP, appId: APP, previewId: null, status: "queued", steps: [], startedAt: null, app }),
        update: async ({ data }: { data: Record<string, unknown> }) => (writes.push(data), {}),
        updateMany: async ({ data }: { data: Record<string, unknown> }) => (writes.push(data), { count: 1 }),
      },
      app: { findUnique: async () => ({ quiescedByJobId: "job-1" }), update: async () => ({}), updateMany: async () => ({ count: 1 }) },
      job: { create: async () => ({}), findFirst: async () => null },
      previewDeployment: { findUnique: async () => null },
      deploymentLogChunk: { create: async () => ({}) },
      activityLog: { create: async () => ({}) },
      $queryRaw: async () => [{ logSeq: 1 }],
      $executeRaw: async () => 0,
      $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    };
    const deps = { db: db as unknown as Db, vault: untouched("vault"), docker: { inspectContainer: async () => { throw Object.assign(new Error("no such container"), { status: 404 }); } }, config: {} } as unknown as DeployDeps;
    const job = { id: "j1", kind: "deploy", payload: { deploymentId: DEP }, attempts: 1, maxAttempts: 3 } as never;
    await handleDeploy(deps, job, new AbortController().signal).catch(() => undefined);
    const settled = writes.find((w) => w.status === "failed");
    expect(settled?.error).toBe("A restore of this app's data is running. Try again when it finishes.");
  });

  it("the check itself: held is a permanent refusal, free passes", async () => {
    const db = (quiescedByJobId: string | null) => ({ app: { findUnique: async () => ({ quiescedByJobId }) } }) as unknown as Db;
    await expect(assertNotHeldByRestore(db("job-1"), APP)).rejects.toBeInstanceOf(PermanentDeployError);
    await expect(assertNotHeldByRestore(db(null), APP)).resolves.toBeUndefined();
  });

  it("a push deploy that meets the hold is kept as the pending deploy; a redeploy or rollback is only refused", async () => {
    const stamped: unknown[] = [];
    const db = { app: { findUnique: async () => ({ quiescedByJobId: "job-1" }), updateMany: async ({ data }: { data: unknown }) => (stamped.push(data), { count: 1 }) } } as unknown as Db;
    await expect(assertNotHeldByRestore(db, APP, "push")).rejects.toThrow(/The push is kept and deploys when the restore has finished/);
    expect(stamped).toEqual([{ pendingDeployAt: expect.any(Date) }]);
    for (const trigger of ["redeploy", "rollback", "manual"]) await expect(assertNotHeldByRestore(db, APP, trigger)).rejects.toThrow(/^A restore of this app's data is running\. Try again when it finishes\.$/);
    expect(stamped).toHaveLength(1);
  });

  it("a start brings a kept push with it: it deploys once the app runs again", async () => {
    const promoted: string[] = [];
    const calls: string[] = [];
    const db = {
      app: { findUnique: async () => ({ id: APP, name: "storage", kind: "bot", desiredState: "running", deployTarget: "server", serverId: "s1", quiescedByJobId: null, status: "running", deployments: [] }), updateMany: async () => ({ count: 1 }), update: async () => ({}) },
      deployment: { findFirst: async () => null },
    } as unknown as Db;
    const docker = {
      inspectContainer: async () => ({ Id: "c1", Config: { Labels: { "dockify.app": APP } }, State: { Status: "running", StartedAt: null } }),
      startContainer: async () => void calls.push("start"),
      stopContainer: async () => void calls.push("stop"),
    };
    const deps = { db, docker: docker as never, promotePending: async (id: string) => void promoted.push(id) };
    expect(await runPower(deps, { appId: APP, op: "start" })).toBe("started");
    expect(promoted).toEqual([APP]);
    // A restart is not a wait ending: nothing was held back for it.
    expect(await runPower(deps, { appId: APP, op: "restart" })).toBe("restarted");
    expect(promoted).toEqual([APP]);
  });

  it("keeps a pending push pending, and is not started or restarted by a power job", async () => {
    const created: unknown[] = [];
    const row = { id: APP, name: "storage", kind: "backend", pendingDeployAt: new Date(), gitBranch: "main", desiredState: "running", deployTarget: "server", serverId: "s1", quiescedByJobId: "job-1" as string | null };
    const db = {
      app: { findUnique: async () => row, update: async () => ({}) },
      deployment: { findFirst: async () => null, create: async ({ data }: { data: unknown }) => (created.push(data), { id: DEP }) },
      job: { create: async () => ({}) },
      $executeRaw: async () => 0,
      $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    } as unknown as Db;
    expect(await promotePending(db, APP)).toBeNull();
    expect(created).toEqual([]);
    expect(await runPower({ db, docker: untouched("docker") as never }, { appId: APP, op: "start" })).toBe("skipped");
    expect(await runPower({ db, docker: untouched("docker") as never }, { appId: APP, op: "restart" })).toBe("skipped");
    row.quiescedByJobId = null;
    expect(await promotePending(db, APP)).toBe(DEP);
  });
});
