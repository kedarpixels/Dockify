import { createHmac } from "node:crypto";
import Fastify from "fastify";
import type { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { storeSecret, type Db } from "@dockify/db";
import type { Ctx } from "../../app.ts";
import { RateLimits } from "../../ratelimit.ts";
import { testConfig, testRing } from "../../test-helpers.ts";
import { defaultDeps } from "./deps.ts";
import type { DeployRequest, DeployRequester } from "./deploy.ts";
import { integrationsPlugin } from "./index.ts";

const ring = testRing();
const HOOK = "whsec-test-value";

/** Just enough of Prisma for the webhook path, in memory. */
async function fakeDb(apps: unknown[] = []) {
  const secrets = new Map<string, Record<string, unknown>>();
  const deliveries: Array<Record<string, unknown>> = [];
  const activity: Array<Record<string, unknown>> = [];
  const db = {
    activityLog: { create: async ({ data }: { data: Record<string, unknown> }) => (activity.push(data), data) },
    secret: {
      create: async ({ data }: { data: Record<string, unknown> }) => (secrets.set(String(data.id), data), data),
      findUnique: async ({ where }: { where: { id: string } }) => secrets.get(where.id) ?? null,
    },
    integration: { findUnique: async () => row },
    webhookDelivery: {
      // A receiver never inserts in a way that can raise a unique violation: Prisma logs those raw.
      create: async () => {
        throw new Error("the webhook path must insert with skipDuplicates");
      },
      createMany: async ({ data, skipDuplicates }: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const row of data) {
          if (deliveries.some((d) => d.deliveryId === row.deliveryId)) {
            if (!skipDuplicates) throw Object.assign(new Error("dup"), { code: "P2002" });
            continue;
          }
          deliveries.push({ id: `d${deliveries.length}`, ...row });
          count++;
        }
        return { count };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(deliveries.find((d) => d.id === where.id) ?? {}, data),
      updateMany: async ({ where, data }: { where: { deliveryId: string; statusCode: { gte: number } }; data: Record<string, unknown> }) => {
        const hit = deliveries.filter((d) => d.deliveryId === where.deliveryId && typeof d.statusCode === "number" && d.statusCode >= where.statusCode.gte);
        hit.forEach((d) => Object.assign(d, data));
        return { count: hit.length };
      },
      findFirstOrThrow: async ({ where }: { where: { deliveryId: string } }) => deliveries.find((d) => d.deliveryId === where.deliveryId),
    },
    app: { findMany: async ({ where }: { where?: { deployTarget?: string } } = {}) => (apps as Array<{ deployTarget?: string }>).filter((a) => !where?.deployTarget || a.deployTarget === where.deployTarget) },
  };
  const pk = await storeSecret(db as never, ring, { kind: "github_private_key", ownerType: "integration", ownerId: "i1" }, "pem", null);
  const wh = await storeSecret(db as never, ring, { kind: "github_webhook_secret", ownerType: "integration", ownerId: "i1" }, HOOK, null);
  const row = { id: "i1", kind: "github_app", name: "default", status: "connected", config: { appId: 1, slug: "dockify-test" }, secretId: pk, secondSecretId: wh };
  return { db: db as unknown as Db, deliveries, activity };
}

function recorder(): DeployRequester & { calls: DeployRequest[] } {
  const calls: DeployRequest[] = [];
  return { calls, request: async (_db, r) => (calls.push(r), { kind: "queued", deploymentId: "dep", jobId: "job" }), teardownPreview: async () => undefined };
}

let app: ReturnType<typeof Fastify> | undefined;
afterEach(async () => app?.close());

async function build(db: Db, deploys: DeployRequester) {
  const f = Fastify();
  app = f;
  f.setValidatorCompiler(({ schema }) => (data: unknown) => {
    const r = (schema as z.ZodType).safeParse(data);
    return r.success ? { value: r.data } : { error: r.error as unknown as Error };
  });
  f.decorateRequest("actor", null);
  f.decorateRequest("clientIp", "");
  const ctx: Ctx = { db, ring, config: testConfig(), web: { origin: "https://dockify.test", secure: true }, limits: new RateLimits() };
  await f.register(integrationsPlugin, { ctx, deps: defaultDeps({ http: async () => { throw new Error("no network in tests"); }, deploys }) });
  return f;
}

const push = JSON.stringify({
  ref: "refs/heads/main",
  after: "b".repeat(40),
  head_commit: { id: "b".repeat(40), message: "ship it", author: { username: "Sam" } },
  sender: { login: "Sam", avatar_url: "https://avatars.githubusercontent.com/u/9?v=4" },
  repository: { id: 5, clone_url: "https://github.com/acme/shop.git", full_name: "acme/shop" },
});
const sig = (body: string, secret = HOOK) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const headers = (body: string, id = "del-1", s = sig(body)) => ({ "content-type": "application/json", "x-github-event": "push", "x-github-delivery": id, "x-hub-signature-256": s });

describe("GitHub webhook through the plugin", () => {
  const apps = [{ id: "app-1", name: "web", gitRepository: "https://github.com/acme/shop", gitBranch: "main", deployTarget: "server", environment: { branch: "main", project: { id: "p1", slug: "shop", gitRepoId: null } } }];

  it("never starts a server build of an app that lives on Vercel, followed or deploying", async () => {
    for (const vercelFollowOnly of [true, false]) {
      const { db } = await fakeDb([{ ...apps[0], deployTarget: "vercel", vercelProjectId: "prj_1", vercelFollowOnly }]);
      const deploys = recorder();
      const a = await build(db, deploys);
      const r = await a.inject({ method: "POST", url: "/api/v1/webhooks/github", payload: push, headers: headers(push, `del-v${vercelFollowOnly}`) });
      expect(r.statusCode).toBe(202);
      expect(deploys.calls).toEqual([]);
      await a.close();
    }
  });

  it("refuses a bad signature before writing anything", async () => {
    const { db, deliveries } = await fakeDb(apps);
    const d = recorder();
    const a = await build(db, d);
    const r = await a.inject({ method: "POST", url: "/api/v1/webhooks/github", payload: push, headers: headers(push, "del-1", sig(push, "wrong")) });
    expect(r.statusCode).toBe(401);
    expect(deliveries).toHaveLength(0);
    expect(d.calls).toHaveLength(0);
  });

  it("verifies the raw bytes, deploys the matching app once, and drops a replay", async () => {
    const { db, deliveries, activity } = await fakeDb(apps);
    const d = recorder();
    const a = await build(db, d);
    // Odd spacing on purpose: a re-serialised body would not match this MAC.
    const body = push.replace('"ref":', '"ref" :');
    const first = await a.inject({ method: "POST", url: "/api/v1/webhooks/github", payload: body, headers: headers(body) });
    expect(first.statusCode).toBe(202);
    expect(d.calls).toEqual([expect.objectContaining({ appId: "app-1", trigger: "push", branch: "main", commitSha: "b".repeat(40), actorType: "webhook", gitAuthor: "sam", gitAuthorAvatarUrl: "https://avatars.githubusercontent.com/u/9?v=4" })]);
    // One activity row per queued deploy, carrying the author login the log resolves to a member.
    expect(activity).toEqual([expect.objectContaining({ category: "deploys", action: "deploy.push", actorType: "webhook", gitAuthor: "sam", targetHref: "/deployments/dep", targetLabel: "shop / web" })]);
    expect(deliveries[0]).toMatchObject({ event: "push", statusCode: 202, projectId: "p1" });
    const again = await a.inject({ method: "POST", url: "/api/v1/webhooks/github", payload: body, headers: headers(body) });
    expect(again.statusCode).toBe(202);
    expect(d.calls).toHaveLength(1);
  });

  it("accepts the form-encoded hook type", async () => {
    const { db } = await fakeDb(apps);
    const d = recorder();
    const a = await build(db, d);
    const body = `payload=${encodeURIComponent(push)}`;
    const r = await a.inject({ method: "POST", url: "/api/v1/webhooks/github", payload: body, headers: { ...headers(body, "del-2"), "content-type": "application/x-www-form-urlencoded" } });
    expect(r.statusCode).toBe(202);
    expect(d.calls).toHaveLength(1);
  });

  it("keeps JSON parsing for the module's other routes", async () => {
    const { db } = await fakeDb();
    const a = await build(db, recorder());
    const r = await a.inject({ method: "POST", url: "/api/v1/integrations/webhooks/test", payload: { provider: "discord", url: "https://example.com/x" } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });
});
