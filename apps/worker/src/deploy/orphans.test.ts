import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { claim, EXHAUSTED_ERROR, failExhausted } from "../queue.ts";
import type { DockerApi } from "@dockify/engine";
import { ORPHAN_ERROR, settleOrphanedDeployments, type DeployDeps } from "./pipeline.ts";

type Row = Record<string, any>;

const sqlOf = (strings: TemplateStringsArray) => strings.join("?");

describe("exhausted jobs", () => {
  it("claim first fails every job whose attempts ran out through expired leases", async () => {
    const calls: string[] = [];
    const db = {
      $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) => {
        calls.push(`exec:${sqlOf(s)}`);
        expect(v).toContain(EXHAUSTED_ERROR);
        return 1;
      },
      $queryRaw: async (s: TemplateStringsArray) => {
        calls.push(`query:${sqlOf(s)}`);
        return [];
      },
    } as unknown as Db;
    expect(await claim(db, "deploy", 60_000, "w1", null)).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^exec:\s*UPDATE jobs SET "failedAt" = now\(\)/);
    expect(calls[0]).toMatch(/attempts >= "maxAttempts"/);
    expect(calls[0]).toMatch(/"lockedUntil" IS NULL OR "lockedUntil" <= now\(\)/);
    expect(calls[0]).toMatch(/"failedAt" IS NULL/);
    expect(calls[1]).toMatch(/^query:/);
  });
  it("returns how many rows it settled", async () => {
    const db = { $executeRaw: async () => 3 } as unknown as Db;
    expect(await failExhausted(db, "data")).toBe(3);
  });
});

function fakeDeps(seed: { deployments: Row[]; apps: Row[] }) {
  const deployments = new Map(seed.deployments.map((d) => [d.id, d]));
  const apps = new Map(seed.apps.map((a) => [a.id, a]));
  const created: Row[] = [];
  let lastQuery = "";
  const tx = {
    $executeRaw: async () => 0,
    app: {
      findUnique: async ({ where }: Row) => apps.get(where.id) ?? null,
      update: async ({ where, data }: Row) => Object.assign(apps.get(where.id)!, data),
      updateMany: async ({ where, data }: Row) => {
        const a = apps.get(where.id);
        if (a) Object.assign(a, data);
        return { count: a ? 1 : 0 };
      },
    },
    deployment: {
      findFirst: async ({ where }: Row) =>
        [...deployments.values()].find((d) => d.appId === where.appId && (where.status.in as string[]).includes(d.status)) ?? null,
      create: async ({ data }: Row) => {
        const row = { id: `new-${created.length}`, status: "queued", ...data };
        created.push(row);
        deployments.set(row.id, row);
        return row;
      },
      updateMany: async ({ where, data }: Row) => {
        const d = deployments.get(where.id);
        if (!d || !(where.status.in as string[]).includes(d.status)) return { count: 0 };
        Object.assign(d, data);
        return { count: 1 };
      },
    },
    job: { create: async ({ data }: Row) => created.push({ job: data }) },
  };
  const db = {
    ...tx,
    $queryRaw: async (s: TemplateStringsArray) => {
      lastQuery = sqlOf(s);
      // The query itself filters on "no open deploy job"; the fake returns every in-flight row.
      return [...deployments.values()].filter((d) => ["queued", "building", "deploying", "cancelling"].includes(d.status) && !d.hasJob)
        .map((d) => ({ id: d.id, appId: d.appId, status: d.status, steps: d.steps ?? [] }));
    },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Db;
  const docker = {
    inspectContainer: async () => ({ Id: "c1", State: { Status: "running", Running: true, Restarting: false } }),
  } as unknown as DockerApi;
  const deps = { db, vault: {} as never, docker, config: {} } as unknown as DeployDeps;
  return { deps, deployments, apps, created, query: () => lastQuery };
}

describe("orphaned deployments", () => {
  it("settles an in-flight deployment with no open job, so the app is never blocked forever", async () => {
    const f = fakeDeps({
      deployments: [
        { id: "d-build", appId: "a1", status: "building" },
        { id: "d-cancel", appId: "a2", status: "cancelling" },
        { id: "d-live", appId: "a3", status: "building", hasJob: true },
      ],
      apps: [
        { id: "a1", pendingDeployAt: new Date(), gitBranch: "main", desiredState: "running", status: "deploying", currentDeploymentId: "d0", deployments: [] },
        { id: "a2", pendingDeployAt: null, desiredState: "running", status: "deploying", currentDeploymentId: "d0", deployments: [] },
        { id: "a3", pendingDeployAt: null, desiredState: "running", status: "deploying", currentDeploymentId: "d0", deployments: [] },
      ],
    });
    const settled = await settleOrphanedDeployments(f.deps, Date.UTC(2026, 9, 30));
    expect(settled.sort()).toEqual(["d-build", "d-cancel"]);
    expect(f.deployments.get("d-build")).toMatchObject({ status: "failed", error: ORPHAN_ERROR });
    expect(f.deployments.get("d-cancel")).toMatchObject({ status: "cancelled", error: null });
    expect(f.deployments.get("d-live")!.status).toBe("building");
    expect(f.apps.get("a1")!.containerId).toBe("c1");
    // An app with nothing coalesced reads what the daemon reports once its dead deployment settles.
    expect(f.apps.get("a2")!.status).toBe("running");
    // The push coalesced behind the dead deployment is promoted now that the app is free.
    expect(f.created.some((r) => r.trigger === "push" && r.appId === "a1")).toBe(true);
    // The real query only picks rows without an open deploy job, past the creation grace period.
    expect(f.query()).toMatch(/NOT EXISTS/);
    expect(f.query()).toMatch(/"completedAt" IS NULL AND j."failedAt" IS NULL/);
    expect(f.query()).toMatch(/"createdAt" </);
  });
});
