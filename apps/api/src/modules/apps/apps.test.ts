import { describe, expect, it } from "vitest";
import { endpoints } from "@dockify/contracts";
import type { Actor } from "../../actor.ts";
import { buildApp, type Ctx, type Handler } from "../../app.ts";
import { describePolicy, POLICIES } from "../../policy.ts";
import { noDb, testConfig, testRing } from "../../test-helpers.ts";
import { appsHandlers, APPS_ENDPOINTS } from "./index.ts";
import { configUpdate, settingsOf, settingsUpdate, zeroDowntimeOf, type AppRow } from "./views.ts";

const APP = "0f0e0d0c-0000-4000-8000-0000000000aa";
const PROJECT = "0f0e0d0c-0000-4000-8000-0000000000cc";
const owner = { kind: "session", userId: "u", name: "Owner", role: "admin", sessionId: "s", elevated: true } as Actor;
const limitedToken = {
  kind: "token", userId: "u", name: "ci", role: "admin", tokenId: "t", scope: "deploy", allProjects: false, projectIds: ["other"], grants: [], elevated: false,
} as Actor;

const base: AppRow = {
  id: APP, name: "web", kind: "frontend", image: null, gitRepository: "https://github.com/acme/web", gitBranch: null, deployTarget: "server", vercelProjectId: null,
  builder: "auto", rootDir: null, dockerfilePath: null, buildCommand: "pnpm build", startCommand: null, releaseCommand: null,
  port: 3000, healthCheckPath: "/health", healthExpectedStatus: 200, healthTimeoutSeconds: 5, healthGraceSeconds: 10, healthIntervalSeconds: 10,
  cpuLimit: null, memoryLimitMb: 512, pidsLimit: null, capAdd: [], sysctls: {},
};

const row = (over: Record<string, unknown> = {}) => ({
  ...base, status: "running", desiredState: "running", replicas: 1, currentDeploymentId: "d1", environmentId: "e1",
  primaryDomain: { hostname: "web.example.com" },
  domains: [{ hostname: "web.example.com" }],
  environment: { name: "production", projectId: PROJECT, project: { slug: "shop" } },
  _count: { volumes: 0 },
  ...over,
});

/** A fake database that records every write the handlers make. */
function fakeDb(app: Record<string, unknown> | null, opts: { inFlight?: boolean; vercel?: Record<string, unknown> | null } = {}) {
  const jobs: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const secretsDeleted: string[][] = [];
  let current = app;
  const tx = {
    $executeRaw: async () => 0,
    deployment: {
      findFirst: async () => (opts.inFlight ? { id: "d-open", app: { name: "web" } } : null),
      findMany: async () => [{ envSecretId: "s-dep" }],
    },
    job: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { jobs.push(data); return { id: `j${jobs.length}` }; },
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => { jobs.push(...data); return { count: data.length }; },
    },
    app: {
      findFirst: async () => null,
      findUnique: async () => current,
      update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); current = { ...current, ...data }; return current; },
      delete: async ({ where }: { where: { id: string } }) => { deleted.push(where.id); return current; },
      findMany: async () => [{ id: APP, name: "web", environmentId: "e1", containerId: "c1", passwordSecretId: "s-pw", volumes: [{ name: "v1" }], domains: [], deployments: [{ imageId: "sha256:one" }, { imageId: "sha256:one" }, { imageId: "sha256:two" }] }],
    },
    envVar: { findMany: async () => [{ secretId: "s-env" }] },
    secret: { deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => { secretsDeleted.push(where.id.in); return { count: where.id.in.length }; } },
    activityLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data; } },
  };
  const db = {
    ...tx,
    app: { ...tx.app, findUnique: async () => current },
    deployment: { ...tx.deployment, findMany: async () => [] },
    instance: { findUnique: async () => ({ terminalEnabled: true }) },
    metricSample: { findFirst: async () => null, findMany: async () => [] },
    integration: { findUnique: async () => opts.vercel ?? null },
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  return { db, jobs, audits, updates, deleted, secretsDeleted };
}

function call<K extends keyof typeof appsHandlers & string>(id: K, db: unknown, input: { body?: unknown; actor?: Actor } = {}): Promise<unknown> {
  const h = appsHandlers[id] as Handler<never>;
  return h({
    params: { id: APP } as never, body: input.body as never, query: undefined as never, actor: input.actor ?? owner,
    req: { clientIp: "203.0.113.1", headers: { "user-agent": "vitest" } } as never, reply: {} as never, ctx: { db, ring: testRing() } as unknown as Ctx,
  });
}

describe("app routes", () => {
  it("registers every app endpoint with its contract path and policy, with the destructive ones elevated", async () => {
    const { app, routes } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), logger: false });
    await app.ready();
    for (const id of APPS_ENDPOINTS) {
      const r = routes.find((x) => x.url === endpoints[id].path && x.method === endpoints[id].method);
      expect(r?.policy, id).toBe(describePolicy(POLICIES[id]));
      expect(appsHandlers[id], id).toBeTypeOf("function");
    }
    for (const id of ["apps.patch", "apps.delete", "apps.stop", "apps.restart", "apps.config.patch"] as const) expect(POLICIES[id].access, id).toBe("elevated");
    expect(describePolicy(POLICIES["apps.start"])).toBe("session:admin+token:deploy");
    await app.close();
  });

  it("asks for a step-up before a delete and refuses one without a session", async () => {
    const { app } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), logger: false });
    const res = await app.inject({ method: "DELETE", url: `/api/v1/apps/${APP}`, payload: { confirm: "web" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("apps.get", () => {
  it("maps the row onto AppDetail, with no host port and the settings the patch writes", async () => {
    const { db } = fakeDb(row());
    const out = (await call("apps.get", db)) as Record<string, unknown>;
    expect(out).toMatchObject({
      id: APP, name: "web", kind: "frontend", status: "running", projectSlug: "shop", environment: "production", url: "https://web.example.com",
      replicas: { desired: 1, running: 1 }, ports: [{ container: 3000, host: null, protocol: "tcp" }],
      settings: { buildCommand: "pnpm build", startCommand: "", dockerfilePath: "", port: 3000, healthCheckPath: "/health", cpuLimit: null, memoryLimitMb: 512 },
      deployments: [],
    });
    expect(endpoints["apps.get"].response.safeParse(out).success).toBe(true);
  });

  it("404s an unknown app and refuses a token limited to other projects", async () => {
    await expect(call("apps.get", fakeDb(null).db)).rejects.toMatchObject({ status: 404 });
    await expect(call("apps.get", fakeDb(row()).db, { actor: limitedToken })).rejects.toMatchObject({ status: 403 });
  });
});

describe("apps.patch", () => {
  const settings = { buildCommand: "pnpm build:prod", startCommand: "", dockerfilePath: "", port: 3000, healthCheckPath: "/healthz", cpuLimit: 1, memoryLimitMb: 512 };

  it("writes the columns and audits what changed, naming a command without its text", async () => {
    const f = fakeDb(row());
    await call("apps.patch", f.db, { body: { settings, advanced: { capAdd: ["NET_ADMIN"] } } });
    expect(f.updates[0]).toMatchObject({ buildCommand: "pnpm build:prod", healthCheckPath: "/healthz", cpuLimit: 1, capAdd: ["NET_ADMIN"] });
    const changes = f.audits[0]?.changes as Array<{ key: string; before: unknown; after: unknown }>;
    expect(changes).toContainEqual({ key: "buildCommand", before: null, after: "changed" });
    expect(changes).toContainEqual({ key: "healthCheckPath", before: "/health", after: "/healthz" });
    expect(changes).toContainEqual({ key: "capAdd", before: null, after: "NET_ADMIN" });
    expect(JSON.stringify(f.audits)).not.toContain("build:prod");
  });

  it("refuses build settings on a managed service and leaves the row alone", async () => {
    const f = fakeDb(row({ kind: "postgres", gitRepository: null, image: "postgres:17-alpine", port: 5432 }));
    await expect(call("apps.patch", f.db, { body: { settings: { ...settings, port: 5432 } } })).rejects.toMatchObject({ status: 400, code: "REFUSED" });
    expect(f.updates).toHaveLength(0);
  });

  it("rejects a capability outside the allowlist in the contract", () => {
    const bad = endpoints["apps.patch"].body.safeParse({ settings, advanced: { capAdd: ["SYS_ADMIN"] } });
    expect(bad.success).toBe(false);
  });
});

describe("apps.delete", () => {
  it("needs the app's name typed, and refuses while a deploy runs", async () => {
    await expect(call("apps.delete", fakeDb(row()).db, { body: { confirm: "Web" } })).rejects.toMatchObject({ status: 400, code: "CONFIRM_MISMATCH" });
    await expect(call("apps.delete", fakeDb(row(), { inFlight: true }).db, { body: { confirm: "web" } })).rejects.toMatchObject({ status: 409, code: "DEPLOY_IN_FLIGHT" });
  });

  it("queues the teardown, drops the row and its secrets, and audits", async () => {
    const f = fakeDb(row());
    await call("apps.delete", f.db, { body: { confirm: "web" } });
    expect(f.jobs).toHaveLength(1);
    expect(f.jobs[0]).toMatchObject({ kind: "remove_app", payload: { appId: APP, volumeNames: ["v1"], containerId: "c1" } });
    expect(f.deleted).toEqual([APP]);
    expect(f.secretsDeleted[0]?.sort()).toEqual(["s-dep", "s-env", "s-pw"]);
    expect(f.audits[0]).toMatchObject({ action: "app.delete", targetId: APP, targetLabel: "shop/production/web", ip: "203.0.113.1" });
  });
});

describe("apps.start, apps.stop, apps.restart", () => {
  it("records the desired state and queues one app_power job with an audit row", async () => {
    const f = fakeDb(row());
    await call("apps.stop", f.db);
    expect(f.updates[0]).toEqual({ desiredState: "stopped" });
    expect(f.jobs[0]).toMatchObject({ kind: "app_power", lane: "deploy", payload: { appId: APP, op: "stop" }, dedupeKey: `app.power:${APP}:stop` });
    expect(f.audits[0]).toMatchObject({ category: "deploys", action: "app.stop", verb: "stopped" });

    const s = fakeDb(row({ desiredState: "stopped", status: "stopped" }));
    await call("apps.start", s.db);
    expect(s.updates[0]).toEqual({ desiredState: "running" });
    expect(s.jobs[0]).toMatchObject({ kind: "app_power", payload: { op: "start" } });

    const r = fakeDb(row());
    await call("apps.restart", r.db);
    expect(r.updates).toHaveLength(0);
    expect(r.jobs[0]).toMatchObject({ kind: "app_power", payload: { op: "restart" } });
  });

  it("refuses a Vercel app, an app never deployed, a restart of a stopped app, and a running deploy", async () => {
    await expect(call("apps.stop", fakeDb(row({ deployTarget: "vercel" })).db)).rejects.toMatchObject({ status: 400, code: "NOT_ON_SERVER" });
    await expect(call("apps.start", fakeDb(row({ currentDeploymentId: null })).db)).rejects.toMatchObject({ status: 409, code: "NOT_DEPLOYED" });
    // No container left: refused here, where the owner sees it, not in a job nobody sees.
    await expect(call("apps.start", fakeDb(row({ status: "missing" })).db)).rejects.toMatchObject({ status: 409, code: "NO_CONTAINER" });
    await expect(call("apps.restart", fakeDb(row({ desiredState: "stopped" })).db)).rejects.toMatchObject({ status: 409, code: "APP_STOPPED" });
    const busy = fakeDb(row(), { inFlight: true });
    await expect(call("apps.restart", busy.db)).rejects.toMatchObject({ status: 409, code: "DEPLOY_IN_FLIGHT" });
    expect(busy.jobs).toHaveLength(0);
  });

  it("refuses a token limited to other projects before anything is queued", async () => {
    const f = fakeDb(row());
    await expect(call("apps.start", f.db, { actor: limitedToken })).rejects.toMatchObject({ status: 403 });
    expect(f.jobs).toHaveLength(0);
  });
});

describe("apps.config", () => {
  it("reads health, limits, defaults and the zero downtime verdict", async () => {
    const out = (await call("apps.config.get", fakeDb(row({ _count: { volumes: 1 } })).db)) as Record<string, unknown>;
    expect(out).toMatchObject({
      health: { path: "/health", expectedStatus: 200, timeoutSeconds: 5, gracePeriodSeconds: 10, intervalSeconds: 10 },
      limits: { cpuCores: null, memoryMb: 512, pids: null },
      defaults: { memoryMb: 512, pids: 512 },
      release: { command: "" },
      zeroDowntime: { possible: false, blockers: ["volume"] },
      target: { kind: "server", vercelProjectId: null },
      vercel: { connected: false, projects: [], sync: null },
    });
    expect(endpoints["apps.config.get"].response.safeParse(out).success).toBe(true);
  });

  it("writes the health path, the rollback toggle and the limits to the columns the settings read", async () => {
    const f = fakeDb(row());
    const health = { path: "/ready", expectedStatus: 204, timeoutSeconds: 3, gracePeriodSeconds: 0, intervalSeconds: 5 };
    const out = (await call("apps.config.patch", f.db, { body: { health, limits: { cpuCores: 2, memoryMb: 1024, pids: 256 } } })) as { health: unknown };
    expect(f.updates[0]).toMatchObject({ healthCheckPath: "/ready", cpuLimit: 2, memoryLimitMb: 1024, pidsLimit: 256 });
    expect(out.health).toEqual(health);
    expect(f.audits[0]).toMatchObject({ action: "app.config" });
  });

  it("will not move a running app to Vercel, nor target Vercel while it is not connected", async () => {
    const target = { kind: "vercel", vercelProjectId: "prj_abc123" };
    await expect(call("apps.config.patch", fakeDb(row()).db, { body: { target } })).rejects.toMatchObject({ status: 409, code: "STOP_FIRST" });
    await expect(call("apps.config.patch", fakeDb(row({ desiredState: "stopped" })).db, { body: { target } })).rejects.toMatchObject({ status: 409, code: "NOT_CONNECTED" });
  });
});

describe("views", () => {
  it("maps empty columns to empty strings and back to null", () => {
    expect(settingsOf({ ...base, healthCheckPath: null }).healthCheckPath).toBe("");
    const { data } = settingsUpdate(base, { ...settingsOf(base), healthCheckPath: "", dockerfilePath: "Dockerfile" }, undefined);
    expect(data).toMatchObject({ healthCheckPath: null, dockerfilePath: "Dockerfile", builder: "dockerfile" });
  });

  it("refuses a Vercel target for anything but a frontend from git, and a service release command", () => {
    expect(configUpdate({ ...base, kind: "backend" }, { target: { kind: "vercel", vercelProjectId: "prj_1" } }).refusals[0]?.field).toBe("target");
    expect(configUpdate({ ...base, kind: "redis" }, { release: { command: "migrate" } }).refusals[0]?.field).toBe("release.command");
    expect(configUpdate(base, { release: { command: "pnpm migrate" } }).changes).toEqual([{ key: "release.command", before: null, after: "changed" }]);
  });

  it("blocks zero downtime for a volume or a managed service only", () => {
    expect(zeroDowntimeOf("backend", 0)).toEqual({ possible: true, blockers: [] });
    expect(zeroDowntimeOf("backend", 2)).toEqual({ possible: false, blockers: ["volume"] });
    expect(zeroDowntimeOf("postgres", 0).possible).toBe(false);
  });
});

describe("change what an app runs (image, branch)", () => {
  const settings = settingsOf(base);

  it("changes an image app's image and a git app's branch, audited, from the next deploy", async () => {
    const img = fakeDb(row({ gitRepository: null, image: "nginx:1.27", buildCommand: null }));
    await call("apps.patch", img.db, { body: { settings: { ...settings, buildCommand: "" }, source: { image: "nginx:1.28" } } });
    expect(img.updates[0]).toMatchObject({ image: "nginx:1.28" });
    expect(img.audits[0]).toMatchObject({ action: "app.update", suffix: "(applies on the next deploy)" });
    expect(img.audits[0]?.changes).toContainEqual({ key: "image", before: "nginx:1.27", after: "nginx:1.28" });

    const git = fakeDb(row());
    await call("apps.patch", git.db, { body: { settings, source: { branch: "release" } } });
    expect(git.updates[0]).toMatchObject({ gitBranch: "release" });
    expect(git.audits[0]?.changes).toContainEqual({ key: "branch", before: null, after: "release" });
    // null goes back to following the environment's branch.
    expect(settingsUpdate({ ...base, gitBranch: "release" }, settings, undefined, { branch: null }).data).toMatchObject({ gitBranch: null });
  });

  it("refuses a branch for an image app, an image for a git app and for a managed service", () => {
    expect(settingsUpdate({ ...base, gitRepository: null, image: "nginx:1", buildCommand: null }, { ...settings, buildCommand: "" }, undefined, { branch: "main" }).refusals[0]?.field).toBe("source.branch");
    expect(settingsUpdate(base, settings, undefined, { image: "nginx:1" }).refusals[0]?.field).toBe("source.image");
    const pg = { ...base, kind: "postgres", gitRepository: null, image: "postgres:17-alpine", buildCommand: null };
    const r = settingsUpdate(pg, { ...settings, buildCommand: "", port: pg.port }, undefined, { image: "postgres:18" });
    expect(r.refusals.map((x) => x.field)).toContain("source.image");
    expect(r.data.image).toBeUndefined();
  });

  it("validates the source in the contract: an image reference and a branch name", () => {
    const body = endpoints["apps.patch"].body!;
    expect(body.safeParse({ settings, source: { image: "ghcr.io/acme/web:1.2" } }).success).toBe(true);
    expect(body.safeParse({ settings, source: { image: "Not An Image" } }).success).toBe(false);
    expect(body.safeParse({ settings, source: { branch: "../main" } }).success).toBe(false);
    expect(body.safeParse({ settings, source: { branch: null } }).success).toBe(true);
  });

  it("sends the branch of a git app only", async () => {
    const out = (await call("apps.get", fakeDb(row({ gitBranch: "release" })).db)) as Record<string, unknown>;
    expect(out.branch).toBe("release");
    const img = (await call("apps.get", fakeDb(row({ gitRepository: null, image: "nginx:1", gitBranch: null })).db)) as Record<string, unknown>;
    expect(img.branch).toBeNull();
  });
});

describe("what the app page shows", () => {
  it("falls back to the oldest domain when no primary domain is set", async () => {
    const out = (await call("apps.get", fakeDb(row({ primaryDomain: null, domains: [{ hostname: "first.example.com" }] })).db)) as Record<string, unknown>;
    expect(out.url).toBe("https://first.example.com");
    const none = (await call("apps.get", fakeDb(row({ primaryDomain: null, domains: [] })).db)) as Record<string, unknown>;
    expect(none.url).toBeNull();
  });

  it("draws the usage card from five-minute rows before two whole hours are rolled up", async () => {
    const f = fakeDb(row());
    const at = (m: number) => new Date(Date.now() - m * 60_000);
    const byResolution: Record<string, unknown[]> = {
      hour: [],
      five_min: [{ at: at(5), cpuPct: 3.21, memoryBytes: 2048n }, { at: at(10), cpuPct: 1.5, memoryBytes: 1024n }],
    };
    const db = { ...f.db, metricSample: { findFirst: async () => ({ cpuPct: 2, memoryBytes: 1024n }), findMany: async ({ where }: { where: { resolution: string } }) => byResolution[where.resolution] ?? [] } };
    const out = (await call("apps.get", db)) as { metrics?: Array<{ at: string; cpuPct: number }> };
    expect(out.metrics).toHaveLength(2);
    // Oldest first, as the card draws it.
    expect(out.metrics![0]!.cpuPct).toBe(1.5);
    expect(out.metrics![1]!.cpuPct).toBe(3.2);
  });
});
