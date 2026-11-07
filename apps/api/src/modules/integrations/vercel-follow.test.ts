import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import type { HttpClient, HttpRequest, HttpResponse } from "@dockify/net-guard";
import { storeSecret } from "@dockify/db";
import { testRing } from "../../test-helpers.ts";
import { POLICIES } from "../../policy.ts";
import { appsHandlers } from "../apps/index.ts";
import { configUpdate, targetPlan } from "../apps/views.ts";
import { deploymentHandlers, setDeploymentsVercelHttp } from "../deployments/handlers.ts";
import { defaultDeps } from "./deps.ts";
import { createIntegrationHandlers } from "./index.ts";
import { enqueueVercelSync } from "./vercel.ts";

/** A followed app: the API refuses everything that would change Vercel, before any call or job. */

const ring = testRing();
const res = (status: number, body: unknown = {}): HttpResponse => ({ status, headers: {}, body: Buffer.from(JSON.stringify(body)) });
const ADMIN = { kind: "session", userId: "u1", sessionId: "s1", name: "Sam", role: "admin", elevated: true };

async function harness(app: Record<string, unknown> = {}) {
  const calls: HttpRequest[] = [];
  const jobs: Array<Record<string, unknown>> = [];
  const rows: Array<Record<string, unknown>> = [];
  const secrets = new Map<string, Record<string, unknown>>();
  const row: Record<string, unknown> = { id: "a1", name: "web", kind: "frontend", deployTarget: "vercel", vercelProjectId: "prj_1", vercelFollowOnly: true, gitBranch: null, image: null, gitRepository: "https://github.com/acme/web", environment: { projectId: "p1" }, ...app };
  const integration: Record<string, unknown> = { id: "i1", kind: "vercel", name: "default", status: "connected", config: {}, secondSecretId: null };
  const tx = {
    $executeRaw: async () => 0,
    app: { findUnique: async () => row },
    job: { findFirst: async () => null, create: async ({ data }: { data: Record<string, unknown> }) => (jobs.push(data), { id: "j" }) },
    activityLog: { create: async () => ({}) },
    integration: { findUnique: async () => integration },
    secret: {
      create: async ({ data }: { data: Record<string, unknown> }) => (secrets.set(String(data.id), data), data),
      findUnique: async ({ where }: { where: { id: string } }) => secrets.get(where.id) ?? null,
    },
    deployment: {
      create: async ({ data }: { data: Record<string, unknown> }) => (rows.push(data), { id: "d-new" }),
      findUnique: async () => ({
        id: "d1", appId: "a1", status: "building", provider: "vercel", externalId: "dpl_1", createdAt: new Date(0), finishedAt: null,
        app: { id: "a1", name: "web", kind: "frontend", vercelFollowOnly: row.vercelFollowOnly, deployTarget: "vercel", gitRepository: null, environment: { name: "production", project: { slug: "shop", id: "p1" } } },
      }),
      updateMany: async () => ({ count: 1 }),
    },
  };
  const db = { ...tx, $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) } as unknown as Db;
  integration.secretId = await storeSecret(db as never, ring, { kind: "integration_token", ownerType: "integration", ownerId: "i1" }, "the-token", null);
  const http: HttpClient = async (r) => (calls.push(r), res(200, {}));
  return { db, http, calls, jobs, rows };
}

const input = (db: Db, extra: Record<string, unknown> = {}) =>
  ({ params: { id: "a1" }, query: {}, body: {}, actor: ADMIN, req: { clientIp: "1.1.1.1", headers: {}, log: { warn() {} } }, reply: {}, ctx: { db, ring }, ...extra }) as never;

afterEach(() => setDeploymentsVercelHttp(undefined));

describe("a followed app in the API", () => {
  it("refuses Deploy with no row, no job and no call", async () => {
    const h = await harness();
    await expect(appsHandlers["apps.deploy"]!(input(h.db))).rejects.toMatchObject({ status: 409, code: "VERCEL_FOLLOW_ONLY" });
    expect([h.rows, h.jobs, h.calls]).toEqual([[], [], []]);
  });

  it("refuses the variable push", async () => {
    const h = await harness();
    const handlers = createIntegrationHandlers(defaultDeps({ http: h.http }));
    await expect(handlers["apps.vercel.sync"]!(input(h.db))).rejects.toMatchObject({ code: "VERCEL_FOLLOW_ONLY" });
    expect([h.jobs, h.calls]).toEqual([[], []]);
  });

  it("refuses Cancel before anything reaches Vercel", async () => {
    const h = await harness();
    setDeploymentsVercelHttp(h.http);
    await expect(deploymentHandlers["deployments.cancel"]!(input(h.db, { params: { id: "d1" } }))).rejects.toMatchObject({ code: "VERCEL_FOLLOW_ONLY" });
    expect(h.calls).toEqual([]);
  });

  it("cancels for a deploy target, so the guard is only for followed apps", async () => {
    const h = await harness({ vercelFollowOnly: false });
    setDeploymentsVercelHttp(h.http);
    await deploymentHandlers["deployments.cancel"]!(input(h.db, { params: { id: "d1" } }));
    expect(h.calls.map((c) => c.method)).toEqual(["PATCH"]);
  });

  it("refuses at the one way to the sync job, whoever calls it", async () => {
    const h = await harness();
    for (const action of ["sync_env", "deploy", "status"] as const) await expect(enqueueVercelSync(h.db, "a1", action)).rejects.toMatchObject({ code: "VERCEL_FOLLOW_ONLY" });
    expect(h.jobs).toEqual([]);
  });
});

describe("targetPlan", () => {
  const server = { deployTarget: "server" as const, vercelProjectId: null, vercelFollowOnly: false };
  const followed = { deployTarget: "vercel" as const, vercelProjectId: "prj_1", vercelFollowOnly: true };
  const deploying = { deployTarget: "vercel" as const, vercelProjectId: "prj_1", vercelFollowOnly: false };
  const link = (mode?: "follow" | "deploy", vercelProjectId = "prj_1") => ({ kind: "vercel" as const, vercelProjectId, mode });

  it("follows by default, and sends nothing", () => {
    expect(targetPlan(server, link())).toEqual({ followOnly: true, startsPushing: false });
    expect(targetPlan(deploying, link())).toEqual({ followOnly: true, startsPushing: false });
    expect(targetPlan(followed, link("follow", "prj_2"))).toEqual({ followOnly: true, startsPushing: false });
  });

  it("calls every way into pushing what it is: a new link, a switch from follow, another project", () => {
    expect(targetPlan(server, link("deploy")).startsPushing).toBe(true);
    expect(targetPlan(followed, link("deploy")).startsPushing).toBe(true);
    expect(targetPlan(deploying, link("deploy", "prj_2")).startsPushing).toBe(true);
  });

  it("does not ask again for a deploy target that stays as it is", () => {
    expect(targetPlan(deploying, link("deploy")).startsPushing).toBe(false);
    expect(targetPlan(deploying, { kind: "server", vercelProjectId: null })).toEqual({ followOnly: false, startsPushing: false });
  });
});

describe("configUpdate on a link", () => {
  const base = { kind: "frontend", gitRepository: null, deployTarget: "server", vercelProjectId: null, vercelFollowOnly: false } as never;
  it("lets a frontend with no repository follow, and not deploy", () => {
    const follow = configUpdate(base, { target: { kind: "vercel", vercelProjectId: "prj_1" } } as never);
    expect(follow.refusals).toEqual([]);
    expect(follow.data).toMatchObject({ deployTarget: "vercel", vercelProjectId: "prj_1", vercelFollowOnly: true });
    expect(configUpdate(base, { target: { kind: "vercel", vercelProjectId: "prj_1", mode: "deploy" } } as never).refusals[0]?.field).toBe("target");
  });
  it("still refuses anything but a frontend", () => {
    expect(configUpdate({ ...(base as object), kind: "backend" } as never, { target: { kind: "vercel", vercelProjectId: "prj_1" } } as never).refusals[0]?.reason).toContain("frontend");
  });
});

describe("the switch to deploying", () => {
  const body = { target: { kind: "vercel", vercelProjectId: "prj_1", mode: "deploy" } };
  const row = {
    id: "a1", name: "web", kind: "frontend", status: "stopped", desiredState: "stopped", gitRepository: "https://github.com/acme/web", gitRepoId: "42", deployTarget: "vercel", vercelProjectId: "prj_1", vercelFollowOnly: true,
    currentDeploymentId: null, environment: { projectId: "p1", name: "production", project: { slug: "shop" } }, _count: { volumes: 0 },
  };
  async function patch(over: Record<string, unknown>) {
    const h = await harness();
    const updates: unknown[] = [];
    const current = { ...row };
    const tx = { $executeRaw: async () => 0, app: { findUnique: async () => current, update: async (a: { data: object }) => (updates.push(a), Object.assign(current, a.data)) }, activityLog: { create: async () => ({}) }, job: { findFirst: async () => null, create: async ({ data }: { data: Record<string, unknown> }) => (h.jobs.push(data), {}) } };
    const db = { ...tx, integration: { findUnique: async () => null }, $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) } as unknown as Db;
    const out = await appsHandlers["apps.config.patch"]!(input(db, { body, ...over })).then(() => null, (e: unknown) => e);
    return { out, updates, jobs: h.jobs };
  }

  it("is an elevated route, which no API token can use", () => {
    expect(POLICIES["apps.config.patch"]).toMatchObject({ access: "elevated", role: "admin" });
    expect((POLICIES["apps.config.patch"] as { token?: unknown }).token).toBeUndefined();
  });

  it("asks for the confirmation, and changes nothing without it", async () => {
    const r = await patch({});
    expect(r.out).toMatchObject({ status: 409, code: "CONFIRM_SEND_SECRETS" });
    expect([r.updates, r.jobs]).toEqual([[], []]);
  });

  it("needs a fresh step-up even with the confirmation", async () => {
    const r = await patch({ body: { ...body, confirmSendSecrets: true }, actor: { ...ADMIN, elevated: false } });
    expect(r.out).toMatchObject({ status: 403, message: "step_up_required" });
    expect(r.updates).toEqual([]);
  });

  it("refuses an API token", async () => {
    const r = await patch({ body: { ...body, confirmSendSecrets: true }, actor: { kind: "token", tokenId: "t1", userId: "u1", name: "ci", role: "admin", scope: "admin" } });
    expect(r.out).toMatchObject({ status: 403 });
  });

  it("applies with both, and only then queues the push", async () => {
    const r = await patch({ body: { ...body, confirmSendSecrets: true } });
    expect(r.out).toBeNull();
    expect(r.updates).toHaveLength(1);
    expect(r.jobs.map((j) => j.kind)).toEqual(["vercel_sync"]);
  });
});
