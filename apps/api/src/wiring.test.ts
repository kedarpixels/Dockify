import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import type { Actor } from "./actor.ts";
import { buildApp, moduleHandlers, PLUGIN_OWNED, type Ctx, type Handler, type Handlers } from "./app.ts";
import { appsHandlers } from "./modules/apps/index.ts";
import { requestDeployTx } from "./modules/deployments/enqueue.ts";
import { statusPagePatch } from "./modules/observe/status.ts";
import { noDb, testConfig, testRing } from "./test-helpers.ts";

type AnyRow = Record<string, any>;
const APP = "0f0e0d0c-0000-4000-8000-0000000000aa";
const owner: Actor = { kind: "session", userId: "u", name: "Owner", role: "admin", sessionId: "s", elevated: true } as Actor;

describe("bootstrap wiring", () => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  beforeAll(async () => {
    ({ app } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), logger: false }));
    await app.ready();
  });
  afterAll(() => app.close());

  it("merges every module table without one endpoint claimed twice, and leaves plugin ids to the plugin", () => {
    const h = moduleHandlers() as Record<string, unknown>;
    for (const id of PLUGIN_OWNED) expect(h[id], id).toBeUndefined();
    expect(Object.keys(h).length).toBeGreaterThan(80);
  });

  it("GitHub's install redirect lands on settings and never reflects the state it was given", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/git/setup?state=forged.state&installation_id=1" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("url=https://dockify.test/settings?section=integrations&github=failed");
  });

  it("keeps a success status a handler chose (a long restore answers 202)", async () => {
    const handlers: Handlers = {
      "public.status": (async ({ reply }: { reply: { code(n: number): unknown } }) => {
        void reply.code(202);
        return { project: { name: "x" } };
      }) as unknown as never,
    };
    const { app: a } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), logger: false, handlers, integrations: false });
    const res = await a.inject({ method: "GET", url: "/api/v1/public/status/demo" });
    expect(res.statusCode).toBe(202);
    await a.close();
  });
});

/** A transaction client that records what the deploy helper writes. */
function fakeTx(state: { openDeployment?: string | null; openJob?: string | null }) {
  const writes: AnyRow = { deployments: [], jobs: [], apps: [], appMany: [] };
  const tx = {
    $executeRaw: async () => 0,
    deployment: {
      findFirst: async () => (state.openDeployment ? { id: state.openDeployment } : null),
      create: async (a: AnyRow) => { writes.deployments.push(a.data); return { id: "dep-1" }; },
    },
    job: {
      findFirst: async () => (state.openJob ? { id: state.openJob } : null),
      create: async (a: AnyRow) => { writes.jobs.push(a.data); return { id: "job-1" }; },
    },
    app: {
      findUnique: async () => ({ serverId: "s1" }),
      update: async (a: AnyRow) => { writes.apps.push(a.data); return {}; },
      updateMany: async (a: AnyRow) => { writes.appMany.push(a.data); return { count: 1 }; },
    },
  };
  return { tx: tx as never, writes };
}

describe("one deploy request helper", () => {
  const data = { trigger: "manual" as const, actorType: "user" as const, actorId: "u", actorName: "Owner" };

  it("queues the deployment and its job together, keyed per app", async () => {
    const { tx, writes } = fakeTx({});
    const out = await requestDeployTx(tx, APP, data, "reject");
    expect(out).toEqual({ kind: "queued", deploymentId: "dep-1", jobId: "job-1" });
    expect(writes.jobs[0]).toMatchObject({ kind: "deploy", lane: "deploy", serverId: "s1", dedupeKey: `deploy:${APP}`, payload: { deploymentId: "dep-1" } });
    expect(writes.deployments[0]).toMatchObject({ appId: APP, serverId: "s1" });
    expect(writes.apps[0]).toMatchObject({ status: "deploying", pendingDeployAt: null });
  });

  it("queues one pending commit status when the commit is already known, and never for a preview", async () => {
    const sha = "a".repeat(40);
    const known = fakeTx({});
    await requestDeployTx(known.tx, APP, { ...data, trigger: "push", commitSha: sha }, "coalesce");
    expect(known.writes.jobs).toHaveLength(2);
    expect(known.writes.jobs[1]).toMatchObject({ kind: "deploy_status", lane: "maintenance", dedupeKey: "deploy_status:dep-1:pending", payload: { deploymentId: "dep-1" } });
    const unknown = fakeTx({});
    await requestDeployTx(unknown.tx, APP, data, "reject");
    expect(unknown.writes.jobs).toHaveLength(1);
    const preview = fakeTx({});
    await requestDeployTx(preview.tx, APP, { ...data, trigger: "preview", previewId: "p1", commitSha: sha }, "coalesce");
    expect(preview.writes.jobs).toHaveLength(1);
  });

  it("a click while one is in flight answers 409; a push or env change coalesces", async () => {
    await expect(requestDeployTx(fakeTx({ openDeployment: "d0" }).tx, APP, data, "reject")).rejects.toMatchObject({ status: 409, code: "DEPLOY_IN_FLIGHT" });
    const { tx, writes } = fakeTx({ openJob: "j0" });
    expect(await requestDeployTx(tx, APP, data, "coalesce")).toEqual({ kind: "coalesced" });
    expect(writes.appMany[0].pendingDeployAt).toBeInstanceOf(Date);
    expect(writes.deployments).toHaveLength(0);
  });

  it("a preview deploy has its own key and never touches the app row", async () => {
    const { tx, writes } = fakeTx({});
    await requestDeployTx(tx, APP, { ...data, trigger: "preview", previewId: "p1" }, "coalesce");
    expect(writes.jobs[0].dedupeKey).toBe("deploy:preview:p1");
    expect(writes.apps).toHaveLength(0);
  });
});

describe("apps.deploy", () => {
  const call = (db: AnyRow, actor: Actor = owner) =>
    (appsHandlers["apps.deploy"] as Handler<"apps.deploy">)({
      params: { id: APP }, body: undefined as never, query: undefined as never, actor,
      req: { clientIp: "203.0.113.1", headers: {} } as never, reply: {} as never, ctx: { db } as unknown as Ctx,
    });

  it("404s an unknown app and refuses an app with no source", async () => {
    await expect(call({ app: { findUnique: async () => null } })).rejects.toMatchObject({ status: 404 });
    const bare = { id: APP, name: "web", kind: "frontend", deployTarget: "server", gitBranch: null, image: null, gitRepository: null, environment: { projectId: "p" } };
    await expect(call({ app: { findUnique: async () => bare } })).rejects.toMatchObject({ status: 400, code: "NO_SOURCE" });
  });

  it("refuses a token limited to other projects", async () => {
    const token = { kind: "token", userId: "u", name: "ci", role: "admin", tokenId: "t", scope: "deploy", allProjects: false, projectIds: ["other"], grants: [], elevated: false } as Actor;
    const row = { id: APP, name: "web", kind: "frontend", deployTarget: "server", gitBranch: "main", image: "nginx:1.27", gitRepository: null, environment: { projectId: "p" } };
    await expect(call({ app: { findUnique: async () => row } }, token)).rejects.toMatchObject({ status: 403 });
  });
});

describe("status page patch", () => {
  it("refuses listing an app from another project", async () => {
    const db = {
      project: { findUnique: async () => ({ id: "p1", slug: "shop", statusPage: null }) },
      $transaction: async (fn: (tx: unknown) => unknown) => fn({
        statusPage: { upsert: async () => ({ id: "sp" }) },
        app: { count: async () => 0 },
      }),
    } as unknown as Db;
    await expect(statusPagePatch(db, owner, "shop", { items: [{ appId: APP, label: "Web" }] }, "203.0.113.1", undefined))
      .rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
  });

  it("accepts the extended patch body in the contract", () => {
    const parsed = endpoints["statusPage.patch"].body.parse({ title: "Shop", items: [{ appId: APP, label: "Web" }] });
    expect(parsed.items).toHaveLength(1);
  });
});
