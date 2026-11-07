import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { endpoints, type EndpointId } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import type { Actor } from "../../actor.ts";
import { buildApp, type Ctx } from "../../app.ts";
import { HttpError } from "../../errors.ts";
import { POLICIES, describePolicy } from "../../policy.ts";
import { noDb, testConfig, testRing } from "../../test-helpers.ts";
import { deploymentHandlers } from "./handlers.ts";
import { apiStatus, decodeChunk, decodeCursor, encodeCursor, median, sseFrame, statusFilter, toSteps } from "./mapping.ts";

describe("mapping", () => {
  it("round-trips the cursor and rejects junk", () => {
    const d = { createdAt: new Date(1_761_782_400_000), id: "0f0e0d0c-0000-4000-8000-000000000001" };
    expect(decodeCursor(encodeCursor(d))).toEqual(d);
    expect(decodeCursor("bm9wZQ")).toBeNull();
  });
  it("maps cancelling to the phase it is unwinding and the building filter to every in-flight state", () => {
    expect(apiStatus("cancelling", null)).toBe("cancelling");
    expect(apiStatus("cancelling", "sha256:x")).toBe("cancelling");
    expect(statusFilter("building")).toEqual(["queued", "building", "deploying", "cancelling"]);
    expect(statusFilter("all")).toBeNull();
  });
  it("hides the internal release step and fills missing steps", () => {
    const s = toSteps([{ id: "release", status: "done" }, { id: "clone", status: "done", startedAt: "a", finishedAt: "b" }]);
    expect(s.map((x) => x.id)).toEqual(["queued", "clone", "build", "push", "release", "deploy", "health"]);
    expect(toSteps([]).map((x) => x.id)).not.toContain("release");
    expect(s[1]).toEqual({ id: "clone", status: "done", startedAt: "a", finishedAt: "b" });
    expect(s[0]!.status).toBe("pending");
  });
  it("decodes the worker's chunk format with seq numbers", () => {
    const gz = gzipSync(Buffer.from([{ ts: "t", stream: "stdout", text: "a" }, { ts: "t", stream: "stderr", text: "b" }].map((x) => JSON.stringify(x)).join("\n")));
    expect(decodeChunk(7, gz)).toEqual([{ seq: 7, ts: "t", stream: "stdout", text: "a" }, { seq: 8, ts: "t", stream: "stderr", text: "b" }]);
  });
  it("frames SSE with the seq as id", () => {
    expect(sseFrame("line", { a: 1 }, 4)).toBe('id: 4\nevent: line\ndata: {"a":1}\n\n');
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });
});

describe("routes", () => {
  it("registers all seven endpoints with the contract path and the policy table entry", async () => {
    const { app, routes } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), logger: false });
    await app.ready();
    const ids = Object.keys(deploymentHandlers).sort() as EndpointId[];
    expect(ids).toEqual(["deployments.cancel", "deployments.get", "deployments.list", "deployments.logs", "deployments.logs.stream", "deployments.redeploy", "deployments.rollback"]);
    for (const id of ids) {
      const r = routes.find((x) => x.url === endpoints[id].path && x.method === endpoints[id].method);
      expect(r?.policy, id).toBe(describePolicy(POLICIES[id]));
    }
    await app.close();
  });
});

// ---------------------------------------------------------------- handlers over a fake db

const APP = "0f0e0d0c-0000-4000-8000-0000000000aa";
const PROJECT = "0f0e0d0c-0000-4000-8000-0000000000cc";
type Row = Record<string, unknown> & { id: string; status: string };

function fakeDb(rows: Row[], current: string | null) {
  const audits: unknown[] = [];
  const updates: unknown[] = [];
  const withApp = (r: Row) => ({
    commitSha: null, branch: null, message: null, trigger: "manual", imageId: null, imageRef: null, actorName: null, error: null, steps: [],
    createdAt: new Date(0), finishedAt: null, appId: APP,
    app: { id: APP, name: "web", kind: "frontend", deployTarget: "server", environment: { name: "prod", project: { slug: "shop", id: PROJECT } } },
    ...r,
  });
  const db = {
    deployment: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const r = rows.find((x) => x.id === where.id);
        return r ? withApp(r) : null;
      },
      updateMany: async ({ where, data }: { where: { id: string; status: { in: string[] } }; data: { status: string } }) => {
        const r = rows.find((x) => x.id === where.id && where.status.in.includes(x.status));
        if (r) Object.assign(r, data);
        updates.push(data);
        return { count: r ? 1 : 0 };
      },
    },
    app: { findUnique: async () => ({ currentDeploymentId: current, kind: "frontend", replicas: 1, volumes: [] }) },
    previewDeployment: { findUnique: async () => ({ env: { prNumber: 42 } }) },
    user: { findMany: async () => [{ id: "u", avatarUrl: "data:image/png;base64,AAAA" }] },
    activityLog: { create: async (x: unknown) => void audits.push(x) },
    $queryRaw: async () => [],
    $transaction: async () => { throw new Error("enqueue reached"); },
  };
  return { db: db as unknown as Db, audits, updates };
}

const actor: Actor = { kind: "session", userId: "u", name: "Owner", role: "admin", sessionId: "s", elevated: false };
const ctxOf = (db: Db): Ctx => ({ db, ring: testRing(), config: testConfig(), web: { origin: "https://dockify.test", secure: true }, limits: {} as Ctx["limits"] });
const call = (id: "deployments.cancel" | "deployments.rollback" | "deployments.redeploy" | "deployments.get", db: Db, depId: string, a: Actor = actor) =>
  (deploymentHandlers[id] as (i: unknown) => Promise<unknown>)({ params: { id: depId }, body: {}, query: {}, actor: a, req: { clientIp: "1.2.3.4", headers: {} }, reply: {}, ctx: ctxOf(db) });

const D1 = "0f0e0d0c-0000-4000-8000-000000000d01";

describe("list stats", () => {
  // Records the where of every stats query (the counts and the 48 hour select), not the page query.
  function statsDb() {
    const seen: Array<Record<string, unknown>> = [];
    const db = {
      deployment: {
        findMany: async (args: { where: Record<string, unknown>; select?: unknown }) => {
          if (args.select) seen.push(args.where);
          return [];
        },
        count: async (args: { where: Record<string, unknown> }) => {
          seen.push(args.where);
          return 0;
        },
      },
      user: { findMany: async () => [] },
      $queryRaw: async () => [],
    };
    return { db: db as unknown as Db, seen };
  }
  const list = (db: Db, query: Record<string, string>, a: Actor = actor) =>
    (deploymentHandlers["deployments.list"] as (i: unknown) => Promise<{ stats?: unknown }>)({ params: {}, body: {}, query, actor: a, req: { clientIp: "1.2.3.4", headers: {} }, reply: {}, ctx: ctxOf(db) });

  it("counts every deployment the caller may see, whatever the list is filtered by", async () => {
    const { db, seen } = statsDb();
    const out = await list(db, { status: "failed", project: "shop", q: "fix", from: "2026-10-01", to: "2026-10-31" });
    expect(out.stats).toBeDefined();
    expect(seen).toHaveLength(3);
    for (const w of seen) expect(w).not.toHaveProperty("AND");
  });

  it("still keeps a project-limited token to its own projects", async () => {
    const { db, seen } = statsDb();
    const token: Actor = { kind: "token", userId: "u", name: "ci", role: "admin", tokenId: "t", scope: "read", allProjects: false, projectIds: [PROJECT], grants: [], elevated: false };
    await list(db, { status: "failed", q: "fix" }, token);
    expect(seen).toHaveLength(3);
    for (const w of seen) expect(w.AND).toEqual([{ app: { environment: { projectId: { in: [PROJECT] } } } }]);
  });
});

describe("cancel", () => {
  it("moves an in-flight deployment to cancelling and never writes a terminal status", async () => {
    const rows: Row[] = [{ id: D1, status: "building" }];
    const { db, audits, updates } = fakeDb(rows, null);
    const out = (await call("deployments.cancel", db, D1)) as { deployment: { status: string } };
    expect(rows[0]!.status).toBe("cancelling");
    expect(updates).toEqual([{ status: "cancelling" }]);
    expect(out.deployment.status).toBe("cancelling");
    expect(audits).toHaveLength(1);
  });
  it("refuses a finished deployment", async () => {
    const { db } = fakeDb([{ id: D1, status: "ready" }], null);
    await expect(call("deployments.cancel", db, D1)).rejects.toMatchObject({ status: 409, code: "ALREADY_FINISHED" });
  });
  it("a project-limited token cannot touch other projects", async () => {
    const { db } = fakeDb([{ id: D1, status: "building" }], null);
    const token: Actor = { kind: "token", userId: "u", name: "ci", role: "admin", tokenId: "t", scope: "deploy", allProjects: false, projectIds: ["other"], grants: [], elevated: false };
    await expect(call("deployments.cancel", db, D1, token)).rejects.toBeInstanceOf(HttpError);
  });
});

describe("rollback", () => {
  it("only targets ready deployments with a pinned image that are not already serving", async () => {
    await expect(call("deployments.rollback", fakeDb([{ id: D1, status: "failed", imageId: "sha256:x" }], null).db, D1)).rejects.toMatchObject({ code: "NOT_ROLLBACK_TARGET" });
    await expect(call("deployments.rollback", fakeDb([{ id: D1, status: "ready", imageId: null }], null).db, D1)).rejects.toMatchObject({ code: "NOT_ROLLBACK_TARGET" });
    await expect(call("deployments.rollback", fakeDb([{ id: D1, status: "ready", imageId: "sha256:x" }], D1).db, D1)).rejects.toMatchObject({ code: "ALREADY_CURRENT" });
    await expect(call("deployments.rollback", fakeDb([{ id: D1, status: "ready", imageId: "sha256:x" }], null).db, D1)).rejects.toThrow("enqueue reached");
  });
  it("refuses to roll back to a preview build (fork code with production secrets)", async () => {
    const preview = fakeDb([{ id: D1, status: "ready", imageId: "sha256:x", previewId: "0f0e0d0c-0000-4000-8000-000000000e01" }], null);
    await expect(call("deployments.rollback", preview.db, D1)).rejects.toMatchObject({ code: "PREVIEW_NOT_PROMOTABLE" });
  });
});

describe("redeploy", () => {
  it("refuses to redeploy a preview build into the live app", async () => {
    const preview = fakeDb([{ id: D1, status: "ready", imageId: "sha256:x", previewId: "0f0e0d0c-0000-4000-8000-000000000e01" }], null);
    await expect(call("deployments.redeploy", preview.db, D1)).rejects.toMatchObject({ code: "PREVIEW_NOT_PROMOTABLE" });
  });
  it("redeploys a normal deployment through the queue", async () => {
    await expect(call("deployments.redeploy", fakeDb([{ id: D1, status: "ready", imageId: "sha256:x" }], null).db, D1)).rejects.toThrow("enqueue reached");
  });
  it("refuses to redeploy a Vercel-target app", async () => {
    const vercel = fakeDb(
      [{ id: D1, status: "ready", imageId: "sha256:x", app: { id: "a", name: "web", kind: "frontend", deployTarget: "vercel", environment: { name: "prod", project: { slug: "shop", id: PROJECT } } } } as unknown as Row],
      null,
    );
    await expect(call("deployments.redeploy", vercel.db, D1)).rejects.toMatchObject({ code: "NOT_SERVER_TARGET" });
  });
});

describe("detail actor", () => {
  it("names who started it, with the team picture for a session and none for a token", async () => {
    const { db } = fakeDb([{ id: D1, status: "ready", actorType: "user", actorId: "u", actorName: "Owner" }], null);
    const out = (await call("deployments.get", db, D1)) as { actor: unknown };
    expect(out.actor).toEqual({ name: "Owner", avatarUrl: "data:image/png;base64,AAAA", kind: "user" });
    const token: Actor = { kind: "token", userId: "u", name: "ci", role: "admin", tokenId: "t", scope: "read", allProjects: true, projectIds: [], grants: [], elevated: false };
    const viaToken = (await call("deployments.get", db, D1, token)) as { actor: unknown };
    expect(viaToken.actor).toEqual({ name: "Owner", avatarUrl: null, kind: "user" });
  });
  it("names a push by its GitHub author, and reads one without a login as Dockify acting", async () => {
    const url = "https://avatars.githubusercontent.com/u/7?v=4";
    const { db } = fakeDb([{ id: D1, status: "ready", actorType: "webhook", actorId: null, actorName: "GitHub", gitAuthor: "tomasberg", gitAuthorAvatarUrl: url }], null);
    const out = (await call("deployments.get", db, D1)) as { actor: unknown };
    expect(out.actor).toEqual({ name: "tomasberg", login: "tomasberg", avatarUrl: url, kind: "github" });
    const bare = fakeDb([{ id: D1, status: "ready", actorType: "webhook", actorId: null, actorName: "GitHub" }], null);
    expect(((await call("deployments.get", bare.db, D1)) as { actor: unknown }).actor).toBeNull();
  });
  it("names the pull request a preview deployment was built from", async () => {
    const preview = fakeDb([{ id: D1, status: "ready", actorType: "system", previewId: "0f0e0d0c-0000-4000-8000-000000000e01" }], null);
    expect(((await call("deployments.get", preview.db, D1)) as { pr: unknown }).pr).toBe(42);
    const plain = fakeDb([{ id: D1, status: "ready", actorType: "user", actorId: "u", actorName: "Owner" }], null);
    expect(((await call("deployments.get", plain.db, D1)) as { pr: unknown }).pr).toBeNull();
  });
});
