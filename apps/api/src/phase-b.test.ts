/**
 * Backups volume, project usage, the channel Send test and role edge cases. Each pins a behaviour a fake database can show.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { projects as P } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import { dangerousGate, dangerousIn, projectsHandlers } from "./modules/projects/handlers.ts";
import { roleAtLeast, scopeAtLeast, type Actor } from "./actor.ts";
import type { Ctx } from "./app.ts";
import { LIVE_ALERT_METRIC } from "@dockify/db";
import { alertsPayload } from "./modules/observe/alerts.ts";
import { defaultDeps } from "./modules/integrations/deps.ts";
import { webhookHandlers } from "./modules/integrations/webhooks.ts";
import { testRing } from "./test-helpers.ts";

const COMPOSE = readFileSync(new URL("../../../deploy/docker-compose.yml", import.meta.url), "utf8");
const service = (name: string) => new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|^\\S)`, "m").exec(COMPOSE)?.[1] ?? "";

describe("the backups volume", () => {
  it("is read-only in the api and writable only in the worker and the updater", () => {
    expect(service("api")).toContain("- dockify-backups:/var/lib/dockify/backups:ro");
    expect(service("api")).toContain("DOCKIFY_BACKUP_DIR: /var/lib/dockify/backups");
    expect(service("worker")).toMatch(/- dockify-backups:\/var\/lib\/dockify\/backups\n/);
    expect(service("web")).not.toContain("dockify-backups");
  });
});

describe("the rank checks fail closed", () => {
  it("passes what the tables know, by rank", () => {
    expect(roleAtLeast("admin", "admin")).toBe(true);
    expect(roleAtLeast("admin", "viewer")).toBe(true);
    expect(roleAtLeast("viewer", "admin")).toBe(false);
    expect(scopeAtLeast("admin", "read")).toBe(true);
    expect(scopeAtLeast("read", "deploy")).toBe(false);
  });

  it("refuses a value this build does not know: a migration ahead of it, or a manual edit", () => {
    const unknownRole = "owner" as never;
    const unknownScope = "root" as never;
    expect(roleAtLeast(unknownRole, "viewer")).toBe(false);
    expect(roleAtLeast(unknownRole, "admin")).toBe(false);
    expect(scopeAtLeast(unknownScope, "read")).toBe(false);
    // Even against itself: undefined against undefined passes nothing.
    expect(roleAtLeast(unknownRole, unknownRole)).toBe(false);
  });
});

describe("alerts for a token limited to some projects", () => {
  const db = () => {
    const seen: Record<string, unknown> = {};
    const fake = {
      alertRule: { findMany: async (a: { where: unknown }) => { seen.rule = a.where; return []; } },
      alertEvent: { findMany: async (a: { where: { startedAt?: unknown } }) => { if (a.where.startedAt) seen.event = a.where; return []; } },
      alertMute: { findMany: async (a: { where: unknown }) => { seen.mute = a.where; return []; } },
      integration: { count: async () => 0 },
      notificationWebhook: { findMany: async () => [] },
    };
    return { fake: fake as unknown as Db, seen };
  };

  it("filters rules, events and mutes through each app's project", async () => {
    const { fake, seen } = db();
    await alertsPayload(fake, 1_000, ["p1"]).catch(() => undefined);
    const inScope = { app: { environment: { projectId: { in: ["p1"] } } } };
    expect(seen.rule).toEqual({ metric: LIVE_ALERT_METRIC, ...inScope });
    expect(seen.event).toMatchObject(inScope);
    expect(seen.mute).toMatchObject(inScope);
  });

  it("adds no filter for a session or an unlimited token", async () => {
    const { fake, seen } = db();
    await alertsPayload(fake, 1_000).catch(() => undefined);
    expect(seen.rule).toEqual({ metric: LIVE_ALERT_METRIC });
    expect(seen.event).not.toHaveProperty("app");
  });
});

describe("usage on the project page", () => {
  const app = (id: string, status: string, over: Record<string, unknown> = {}) => ({
    id, name: id, kind: "backend", status, environmentId: "e1", memoryLimitMb: 256, gitRepository: null, primaryDomain: null, domains: [], deployments: [], ...over,
  });
  const fresh = new Date();
  const project = { id: "p1", slug: "shop", name: "Shop", repoUrl: null, defaultBranch: "main", autoDeploy: false, createdAt: fresh, archivedAt: null };

  it("sends each running app's newest sample, and none for an app that does not run or has no fresh one", async () => {
    const asked: Array<{ where: { appId: { in: string[] } } }> = [];
    const db = {
      project: {
        findUnique: async () => project,
        findUniqueOrThrow: async () => ({ ...project, environments: [{ id: "e1", name: "production", branch: "main", apps: [app("up", "running"), app("quiet", "running", { memoryLimitMb: null }), app("down", "stopped")] }] }),
      },
      deployment: { findMany: async () => [] },
      user: { findMany: async () => [] },
      metricSample: {
        findMany: async (a: (typeof asked)[number]) => {
          asked.push(a);
          // Newest first, as the query orders them.
          return [{ appId: "up", cpuPct: 12.34, memoryBytes: 1000n }, { appId: "up", cpuPct: 99, memoryBytes: 9n }];
        },
      },
    };
    const ctx = { db } as unknown as Ctx;
    const actor = { kind: "session", userId: "u", name: "Owner", role: "admin", sessionId: "s", elevated: false } as Actor;
    const out = (await (projectsHandlers["projects.get"] as (a: unknown) => Promise<{ apps: Array<{ id: string; usage?: unknown }> }>)({ params: { slug: "shop" }, actor, ctx }));
    expect(asked[0]!.where.appId.in).toEqual(["up", "quiet"]);
    const by = Object.fromEntries(out.apps.map((a) => [a.id, a.usage]));
    expect(by.up).toEqual({ cpuPct: 12.3, memoryBytes: 1000, memoryLimitBytes: 256 * 1024 * 1024 });
    expect(by.quiet).toBeUndefined();
    expect(by.down).toBeUndefined();
  });
});

describe("hook keys in a copied environment", () => {
  const changes = [{ key: "NODE_OPTIONS", op: "add" }, { key: "PLAIN", op: "add" }];
  const token = { kind: "token" } as Actor;

  it("finds them and refuses them to a token", () => {
    expect(dangerousIn(changes)).toEqual(["NODE_OPTIONS"]);
    expect(P.isDangerousEnvKey("NODE_OPTIONS")).toBe(true);
    expect(() => dangerousGate(token, dangerousIn(changes), true)).toThrow(/API tokens cannot set NODE_OPTIONS/);
  });

  it("lets a stepped-up session copy keys that exist already, with no new value to confirm", () => {
    expect(dangerousGate({ kind: "session", elevated: true } as Actor, dangerousIn(changes), true)).toEqual(["NODE_OPTIONS"]);
    expect(() => dangerousGate({ kind: "session", elevated: false } as Actor, dangerousIn(changes), true)).toThrow();
  });
});

describe("Send test runs in the worker (be-edge request)", () => {
  const HOOK = "0f0e0d0c-0000-4000-8000-0000000000aa";

  function fakeCtx(job: Record<string, unknown> | ((id: string) => Record<string, unknown>), seen: Date | null = new Date()) {
    const created: Array<Record<string, unknown>> = [];
    const http = vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from("ok") }));
    const secretsDeleted: unknown[] = [];
    const secretRows: Array<Record<string, unknown>> = [];
    const tx = {
      job: { create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return { id: "j1" }; } },
      secret: { create: async ({ data }: { data: Record<string, unknown> }) => { secretRows.push(data); return data; } },
    };
    const db = {
      instance: { findUnique: async ({ select }: { select: Record<string, boolean> }) => (select.workerSeenAt ? { workerSeenAt: seen } : { name: "Acme" }) },
      notificationWebhook: { findUnique: async () => ({ id: HOOK, provider: "generic", chatId: null, secretId: "s1", secondSecretId: null }) },
      secret: {
        findUnique: async () => ({ id: "s1", kekId: "k", wrappedDek: Buffer.alloc(1), dekNonce: Buffer.alloc(1), ciphertext: Buffer.alloc(1), ctNonce: Buffer.alloc(1) }),
        deleteMany: async (a: { where: unknown }) => { secretsDeleted.push(a.where); return { count: 1 }; },
      },
      job: {
        findUnique: async () => (typeof job === "function" ? job("j1") : job),
        updateMany: async (a: { where: unknown }) => { created.push({ withdrawn: a.where }); return { count: 1 }; },
      },
      $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    };
    const ctx = { db, ring: testRing(), config: { publicUrl: new URL("https://dash.example.com") } } as unknown as Ctx;
    const handlers = webhookHandlers(defaultDeps({ http: http as never, webhookTestWait: { waitMs: 20, pollMs: 1 } }));
    const test = handlers["integrations.webhooks.test"] as (a: unknown) => Promise<unknown>;
    return { ctx, created, http, test, secretRows, secretsDeleted };
  }

  it("does not refuse to send a draft through the worker, and never puts its URL in the job", async () => {
    const f = fakeCtx({ completedAt: new Date(), failedAt: null, lastError: null, payload: { result: { ok: true, status: 204, latencyMs: 12 } } });
    const out = await f.test({ body: { provider: "generic", url: "https://hooks.example.com/secret-path" }, ctx: f.ctx }).catch((e: unknown) => e);
    // The worker's answer comes back, the api itself sent nothing, and the job holds no URL.
    expect(out).toEqual({ provider: "generic", status: 204, latencyMs: 12 });
    expect(f.http).not.toHaveBeenCalled();
    expect(JSON.stringify(f.created)).not.toContain("secret-path");
    expect(f.created[0]).toMatchObject({ kind: "webhook_send", lane: "maintenance", maxAttempts: 1, payload: { test: true, draft: { provider: "generic" } } });
    expect(f.secretRows[0]).toMatchObject({ kind: "channel_url", ownerType: "webhook_test" });
  });

  it("answers what the endpoint said when the send failed", async () => {
    const f = fakeCtx({ completedAt: null, failedAt: new Date(), lastError: "Generic webhook answered 503", payload: { result: { ok: false, status: 503 } } });
    await expect(f.test({ body: { provider: "generic", url: "https://hooks.example.com/x" }, ctx: f.ctx })).rejects.toMatchObject({ status: 502, code: "WEBHOOK_FAILED", message: "Generic webhook answered 503" });
  });

  it("says the worker is down, and queues nothing", async () => {
    const f = fakeCtx({}, new Date(Date.now() - 600_000));
    await expect(f.test({ body: { provider: "generic", url: "https://hooks.example.com/x" }, ctx: f.ctx })).rejects.toMatchObject({ status: 503, code: "WORKER_DOWN" });
    expect(f.created).toEqual([]);
  });

  it("withdraws a test the busy worker has not started, and its sealed draft with it", async () => {
    const f = fakeCtx({ completedAt: null, failedAt: null, lastError: null, payload: {} });
    await expect(f.test({ body: { provider: "generic", url: "https://hooks.example.com/x" }, ctx: f.ctx })).rejects.toMatchObject({ status: 503, code: "WORKER_BUSY" });
    expect(f.created.at(-1)).toMatchObject({ withdrawn: { lockedUntil: null } });
    expect(f.secretsDeleted).toHaveLength(1);
  });
});
