/**
 * Correctness rules checked through the real app and a really migrated Postgres. Needs DATABASE_URL_TEST, like the other
 * integration tests; the rules that need no database are at the top and always run.
 */
import { createHmac, randomUUID } from "node:crypto";
import { hash as argonHash } from "@node-rs/argon2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken, newToken } from "@dockify/crypto";
import { createDb, defaultServerId, storeSecret, type Db } from "@dockify/db";
import { runAdmin } from "./admin.ts";
import { buildApp } from "./app.ts";
import { ensureInstance } from "./boot.ts";
import { configUpdate, type AppRow } from "./modules/apps/views.ts";
import { codeHash } from "./routes/email-auth.ts";
import { defaultDeps } from "./modules/integrations/deps.ts";
import type { DeployRequester } from "./modules/integrations/deploy.ts";
import { imageProblem, setRegistryResolver } from "./modules/projects/handlers.ts";
import { testConfig, testRing } from "./test-helpers.ts";

const row = (over: Partial<AppRow>): AppRow => ({ kind: "frontend", gitRepository: "https://github.com/a/b", deployTarget: "server", vercelProjectId: null, vercelFollowOnly: false, ...over }) as AppRow;
const toDeploy = { target: { kind: "vercel" as const, vercelProjectId: "prj_1", mode: "deploy" as const } };

describe("an app with no repository id cannot start deploying to Vercel", () => {
  it("is refused when the deploy target is chosen, before anything is pushed", () => {
    expect(configUpdate(row({ gitRepoId: null }), toDeploy).refusals.map((r) => r.field)).toEqual(["target"]);
  });
  it("is allowed with the id the dashboard stores on the app", () => {
    expect(configUpdate(row({ gitRepoId: "77" }), toDeploy).refusals).toEqual([]);
  });
  it("following needs no repository at all", () => {
    expect(configUpdate(row({ gitRepository: null, gitRepoId: null }), { target: { kind: "vercel", vercelProjectId: "prj_1", mode: "follow" } }).refusals).toEqual([]);
  });
});

const url = process.env.DATABASE_URL_TEST;
const ring = testRing();
const ORIGIN = "https://dockify.test";
const HOOK = "whsec-audit-final";

describe.skipIf(!url)("final audit (postgres)", () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let sent: Array<{ url: string; auth: string | null }> = [];
  let domains: string[] = [];
  let deploys: DeployRequester | undefined;
  let serverId: string;
  let teamId: string;

  const http = async (r: { url: string; headers?: Record<string, string> }) => {
    sent.push({ url: r.url, auth: r.headers?.Authorization ?? null });
    const body = r.url.includes("/domains") ? { domains: domains.map((name) => ({ name })) } : r.url.includes("/env") ? { envs: [] } : {};
    return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(body)) };
  };

  const boot = async () => {
    await app?.close();
    ({ app } = await buildApp({ db, ring, config: testConfig(), workerWatch: false, logger: false, integrationDeps: defaultDeps({ http: http as never, ...(deploys ? { deploys } : {}) }) }));
    await app.ready();
  };

  beforeAll(() => {
    db = createDb(url);
    setRegistryResolver(async () => [{ address: "8.8.8.8" }]);
  });
  afterAll(async () => {
    setRegistryResolver(undefined);
    await app?.close();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    const tables = await db.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'servers')`;
    await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
    await ensureInstance(db, ring, ORIGIN, "direct_tls");
    serverId = await defaultServerId(db);
    teamId = (await db.team.create({ data: { name: "t" } })).id;
    sent = [];
    domains = [];
    deploys = undefined;
    await boot();
  });
  afterEach(() => setRegistryResolver(async () => [{ address: "8.8.8.8" }]));

  const PASSWORD = "correct horse battery";
  let n = 0;
  const member = async (role: "admin" | "viewer", password?: string) => {
    const email = `${role}-${++n}@x.test`;
    const user = await db.user.create({ data: { email, name: `${role}${n}`, passwordHash: password ? await argonHash(password) : "x", passwordChangedAt: new Date() } });
    await db.member.create({ data: { teamId, userId: user.id, role } });
    const tok = newToken();
    const now = Date.now();
    await db.session.create({ data: { userId: user.id, tokenHash: hashToken(tok), lastSeenAt: new Date(), expiresAt: new Date(now + 3.6e6), absoluteExpiresAt: new Date(now + 3.6e6), elevatedUntil: new Date(now + 3e5) } });
    return { id: user.id, email, cookie: `__Host-dockify_sid=${tok}` };
  };
  type Who = { cookie?: string; bearer?: string };
  const call = (who: Who, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, payload?: unknown) =>
    app.inject({
      method, url: path,
      headers: { origin: ORIGIN, ...(who.cookie ? { cookie: who.cookie } : {}), ...(who.bearer ? { authorization: `Bearer ${who.bearer}` } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const apiToken = async (userId: string, scope: "read" | "deploy" | "admin", projectIds: string[] | "all") => {
    const secret = `dk_${newToken()}`;
    await db.apiToken.create({
      data: {
        userId, name: `t${++n}`, tokenHash: hashToken(secret), prefix: secret.slice(0, 7), scope, allProjects: projectIds === "all",
        ...(projectIds === "all" ? {} : { projects: { create: projectIds.map((projectId) => ({ projectId })) } }),
      },
    });
    return secret;
  };
  const project = async (slug = `p${++n}`, extraEnv = false) => {
    const p = await db.project.create({ data: { slug, name: slug } });
    const env = await db.environment.create({ data: { projectId: p.id, name: "production", branch: "main" } });
    if (extraEnv) await db.environment.create({ data: { projectId: p.id, name: "staging", branch: "dev" } });
    return { ...p, env };
  };
  const newApp = (environmentId: string, data: Record<string, unknown> = {}) =>
    db.app.create({ data: { environmentId, serverId, name: `a${++n}`, kind: "backend", image: "nginx:1", port: 80, ...data } as never });

  describe("an invite does not outlive its maker's power", () => {
    const accept = (url: string) => {
      const token = url.split("/invite/")[1];
      return app.inject({ method: "POST", url: `/api/v1/auth/invite/${token}`, headers: { origin: ORIGIN }, payload: { name: "back", password: PASSWORD } });
    };

    it("removing an admin revokes the invites they made, and says so in the log", async () => {
      const [boss, gone] = [await member("admin"), await member("admin")];
      const inv = await call(gone, "POST", "/api/v1/team/invites", { email: "back@x.test", role: "admin" });
      expect(inv.statusCode).toBe(200);
      expect((await call(boss, "POST", "/api/v1/team", { changes: [{ id: gone.id, remove: true }] })).statusCode).toBe(200);
      expect((await accept(inv.json().url)).statusCode).toBeGreaterThanOrEqual(400);
      expect(await db.user.findUnique({ where: { email: "back@x.test" } })).toBeNull();
      expect(await db.activityLog.count({ where: { action: "team.invite.revoke", targetId: gone.id } })).toBe(1);
    });

    it("demoting an admin revokes them too; someone else's invite stays", async () => {
      const [boss, gone] = [await member("admin"), await member("admin")];
      const theirs = await call(gone, "POST", "/api/v1/team/invites", { email: "back@x.test", role: "viewer" });
      const mine = await call(boss, "POST", "/api/v1/team/invites", { email: "ok@x.test", role: "viewer" });
      expect((await call(boss, "POST", "/api/v1/team", { changes: [{ id: gone.id, role: "viewer" }] })).statusCode).toBe(200);
      expect((await accept(theirs.json().url)).statusCode).toBeGreaterThanOrEqual(400);
      expect((await accept(mine.json().url)).statusCode).toBe(200);
    });
  });

  describe("apps.patch applies the registry host rule", () => {
    const settings = { buildCommand: "", startCommand: "", dockerfilePath: "", port: 80, healthCheckPath: "", cpuLimit: null, memoryLimitMb: null };
    const patch = (who: Who, id: string, image: string) => call(who, "PATCH", `/api/v1/apps/${id}`, { settings, source: { image } });

    it("refuses what create refuses, and stores nothing", async () => {
      const admin = await member("admin");
      const p = await project();
      const a = await newApp(p.env.id);
      for (const image of ["127.0.0.1:5000/x", "localhost:2375/x", "172.30.3.2:5432/x", "2130706433:5000/x", "169.254.169.254/x"]) {
        const r = await patch(admin, a.id, image);
        expect(r.statusCode, image).toBe(400);
        expect(r.json().field).toBe("source.image");
      }
      expect((await db.app.findUniqueOrThrow({ where: { id: a.id } })).image).toBe("nginx:1");
    });

    it("takes a LAN registry, as a create does", async () => {
      const admin = await member("admin");
      const a = await newApp((await project()).env.id);
      setRegistryResolver(async () => [{ address: "192.168.1.5" }]);
      for (const image of ["192.168.1.5:5000/x", "10.0.0.7:5000/x", "registry.lan:5000/x", "registry.example.com:5000/x"]) {
        const r = await patch(admin, a.id, image);
        expect(r.statusCode, image).toBe(200);
        expect((await db.app.findUniqueOrThrow({ where: { id: a.id } })).image).toBe(image);
        expect(await imageProblem(image), image).toBeNull();
      }
    });

    it("create and patch give the same answer, in the same words", async () => {
      const admin = await member("admin");
      const p = await project();
      const a = await newApp(p.env.id);
      setRegistryResolver(async () => [{ address: "192.168.1.5" }]);
      const create = (name: string, image: string) => call(admin, "POST", `/api/v1/projects/${p.slug}/apps`, { name, kind: "backend", environment: "production", target: "server", source: { type: "image", image, registryId: null } });
      let i = 0;
      for (const image of ["192.168.1.5:5000/x", "registry.lan:5000/x", "ghcr.io/o/r:1"]) {
        expect((await create(`lan${++i}`, image)).statusCode, image).toBe(201);
        expect((await patch(admin, a.id, image)).statusCode, image).toBe(200);
      }
      for (const image of ["127.0.0.1:5000/x", "172.30.3.2:5432/x", "0x7f.0.0.1:5000/x", "metadata.google.internal/x"]) {
        const made = await create(`bad${++i}`, image);
        const patched = await patch(admin, a.id, image);
        expect(made.statusCode, image).toBe(400);
        expect(patched.statusCode, image).toBe(400);
        expect(patched.json().error, image).toContain("Dockify does not pull from");
        expect(made.json().error, image).toBe(patched.json().error);
      }
    });

    it("refuses a name that resolves to an internal address, which the gate cannot see", async () => {
      const admin = await member("admin");
      const a = await newApp((await project()).env.id);
      setRegistryResolver(async () => [{ address: "127.0.0.1" }]);
      expect((await patch(admin, a.id, "reg.example.com/x:1")).statusCode).toBe(400);
    });

    it("takes a public image, and a save that keeps the image asks no DNS", async () => {
      const admin = await member("admin");
      const a = await newApp((await project()).env.id, { image: "ghcr.io/o/r:1" });
      setRegistryResolver(async () => {
        throw new Error("ENOTFOUND");
      });
      expect((await patch(admin, a.id, "ghcr.io/o/r:1")).statusCode).toBe(200);
      setRegistryResolver(async () => [{ address: "8.8.8.8" }]);
      expect((await patch(admin, a.id, "ghcr.io/o/r:2")).statusCode).toBe(200);
      expect((await db.app.findUniqueOrThrow({ where: { id: a.id } })).image).toBe("ghcr.io/o/r:2");
    });
  });

  describe("a stored credential stays with its host", () => {
    const registry = async () => {
      const r = await db.integration.create({ data: { kind: "registry", name: "reg", config: { kind: "custom", host: "registry.example.com", username: "bot" } } });
      const secretId = await storeSecret(db, ring, { kind: "integration_token", ownerType: "integration", ownerId: r.id }, "STOREDTOKEN", "OKEN");
      await db.integration.update({ where: { id: r.id }, data: { secretId } });
      return r;
    };

    it("a new registry host without the token is refused and nothing goes out", async () => {
      const admin = await member("admin");
      const r = await registry();
      const res = await call(admin, "PATCH", `/api/v1/integrations/registries/${r.id}`, { host: "attacker.example.net" });
      expect(res.statusCode).toBe(400);
      expect(res.json().field).toBe("token");
      expect(sent).toEqual([]);
      expect((await db.integration.findUniqueOrThrow({ where: { id: r.id } })).config).toMatchObject({ host: "registry.example.com" });
    });

    it("a new username without the token is refused too", async () => {
      const admin = await member("admin");
      const r = await registry();
      expect((await call(admin, "PATCH", `/api/v1/integrations/registries/${r.id}`, { username: "other" })).statusCode).toBe(400);
      expect(sent).toEqual([]);
    });

    it("the new host with a typed token goes through, carrying that token only", async () => {
      const admin = await member("admin");
      const r = await registry();
      expect((await call(admin, "PATCH", `/api/v1/integrations/registries/${r.id}`, { host: "new.example.net", token: "TYPEDTOKEN-1234" })).statusCode).toBe(200);
      expect(sent[0]?.url).toContain("new.example.net");
      expect(Buffer.from(String(sent[0]?.auth).replace("Basic ", ""), "base64").toString()).toBe("bot:TYPEDTOKEN-1234");
    });

    it("saving an unchanged host and username needs no token and sends nothing", async () => {
      const admin = await member("admin");
      const r = await registry();
      expect((await call(admin, "PATCH", `/api/v1/integrations/registries/${r.id}`, { username: "bot" })).statusCode).toBe(200);
      expect(sent).toEqual([]);
    });

    it("a new storage endpoint needs both keys again, and signs nothing with the stored ones", async () => {
      const admin = await member("admin");
      const s = await db.integration.create({ data: { kind: "storage", name: "s3", config: { provider: "s3", endpoint: "https://s3.example.com", bucket: "b", region: "eu" } } });
      const a = await storeSecret(db, ring, { kind: "integration_token", ownerType: "integration", ownerId: s.id }, "AKIASTORED", "ORED");
      const k = await storeSecret(db, ring, { kind: "storage_secret_key", ownerType: "integration", ownerId: s.id }, "secretstored", "ORED");
      await db.integration.update({ where: { id: s.id }, data: { secretId: a, secondSecretId: k } });
      await db.backupDestination.create({ data: { name: "s3", type: "s3", integrationId: s.id } });
      const res = await call(admin, "PATCH", `/api/v1/integrations/storage/${s.id}`, { endpoint: "https://attacker.example.net" });
      expect(res.statusCode).toBe(400);
      expect(sent).toEqual([]);
    });
  });

  describe("integrations.summary", () => {
    it("tells a Viewer what is connected and nothing about it; an admin keeps the cards", async () => {
      const [viewer, admin] = [await member("viewer"), await member("admin")];
      const r = await db.integration.create({ data: { kind: "registry", name: "reg", config: { kind: "custom", host: "registry.example.com", username: "bot" } } });
      const secretId = await storeSecret(db, ring, { kind: "integration_token", ownerType: "integration", ownerId: r.id }, "STOREDTOKEN", "OKEN");
      await db.integration.update({ where: { id: r.id }, data: { secretId } });
      const seen = await call(viewer, "GET", "/api/v1/integrations");
      expect(seen.statusCode).toBe(200);
      expect(seen.json()).toEqual({ limited: true, github: false, vercel: false, cloudflare: false, registries: true, storage: false, webhooks: false, email: false });
      expect(seen.body).not.toContain("registry.example.com");
      const full = (await call(admin, "GET", "/api/v1/integrations")).json();
      expect(full.registries[0]).toMatchObject({ host: "registry.example.com", username: "bot", tokenHint: "OKEN" });
    });
  });

  describe("project and environment delete hold for a running deploy", () => {
    it("project delete answers 409, queues no teardown and goes through once it settles", async () => {
      const admin = await member("admin");
      const p = await project();
      const a = await newApp(p.env.id);
      const dep = await db.deployment.create({ data: { appId: a.id, serverId, trigger: "manual", status: "deploying", actorType: "user", steps: [] } });
      const res = await call(admin, "DELETE", `/api/v1/projects/${p.slug}`, { confirm: p.slug });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "DEPLOY_IN_FLIGHT", deploymentId: dep.id });
      expect(await db.job.count({ where: { kind: "remove_app" } })).toBe(0);
      expect(await db.project.count({ where: { id: p.id } })).toBe(1);
      await db.deployment.update({ where: { id: dep.id }, data: { status: "ready" } });
      expect((await call(admin, "DELETE", `/api/v1/projects/${p.slug}`, { confirm: p.slug })).statusCode).toBe(204);
    });

    it("environment delete answers 409 the same way", async () => {
      const admin = await member("admin");
      const p = await project(undefined, true);
      const staging = await db.environment.findFirstOrThrow({ where: { projectId: p.id, name: "staging" } });
      const a = await newApp(staging.id);
      await db.deployment.create({ data: { appId: a.id, serverId, trigger: "manual", status: "queued", actorType: "user", steps: [] } });
      const res = await call(admin, "DELETE", `/api/v1/projects/${p.slug}/environments/staging`, { confirm: "staging" });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("DEPLOY_IN_FLIGHT");
      expect(await db.job.count({ where: { kind: "remove_app" } })).toBe(0);
    });

    it("apps.delete keeps its answer", async () => {
      const admin = await member("admin");
      const a = await newApp((await project()).env.id);
      await db.deployment.create({ data: { appId: a.id, serverId, trigger: "manual", status: "deploying", actorType: "user", steps: [] } });
      const res = await call(admin, "DELETE", `/api/v1/apps/${a.id}`, { confirm: a.name });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("DEPLOY_IN_FLIGHT");
    });
  });

  describe("a second Deploy on a Vercel app", () => {
    const vercelApp = async () => newApp((await project()).env.id, { kind: "frontend", image: null, deployTarget: "vercel", vercelFollowOnly: false, vercelProjectId: "prj_1", gitRepository: "https://github.com/a/b", gitRepoId: "42" });

    it("is refused, leaving one row and one job", async () => {
      const admin = await member("admin");
      const a = await vercelApp();
      const first = await call(admin, "POST", `/api/v1/apps/${a.id}/deploy`, {});
      expect(first.statusCode).toBe(202);
      const second = await call(admin, "POST", `/api/v1/apps/${a.id}/deploy`, {});
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe("DEPLOY_IN_FLIGHT");
      expect(await db.deployment.count({ where: { appId: a.id } })).toBe(1);
      expect(await db.job.count({ where: { dedupeKey: `vercel_sync:${a.id}:deploy` } })).toBe(1);
    });

    it("cancel still waits while a job can pick the row up, and settles one nothing will run", async () => {
      const admin = await member("admin");
      const a = await vercelApp();
      const { deploymentId } = (await call(admin, "POST", `/api/v1/apps/${a.id}/deploy`, {})).json();
      const waiting = await call(admin, "POST", `/api/v1/deployments/${deploymentId}/cancel`, {});
      expect(waiting.statusCode).toBe(409);
      expect(waiting.json().code).toBe("NOT_STARTED");
      await db.job.deleteMany({ where: { dedupeKey: `vercel_sync:${a.id}:deploy` } });
      expect((await call(admin, "POST", `/api/v1/deployments/${deploymentId}/cancel`, {})).statusCode).toBe(200);
      expect((await db.deployment.findUniqueOrThrow({ where: { id: deploymentId } })).status).toBe("cancelled");
      expect(sent).toEqual([]);
    });
  });

  describe("reset links and API tokens", () => {
    const link = async (userId: string) => {
      const token = newToken();
      await db.passwordReset.create({ data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 30 * 60_000) } });
      return token;
    };
    const dead = async (token: string) => (await app.inject({ method: "GET", url: `/api/v1/auth/reset/${token}` })).statusCode;

    it("a password change voids an open link, and keeps API tokens", async () => {
      const u = await member("viewer", PASSWORD);
      const token = await link(u.id);
      const secret = await apiToken(u.id, "read", "all");
      expect(await dead(token)).toBe(200);
      expect((await call(u, "POST", "/api/v1/me/password", { current: PASSWORD, next: "another long password" })).statusCode).toBe(204);
      expect(await dead(token)).toBe(410);
      expect((await call({ bearer: secret }, "GET", "/api/v1/projects")).statusCode).toBe(200);
    });

    it("an email change through PATCH /me voids an open link", async () => {
      const u = await member("viewer");
      const token = await link(u.id);
      expect((await call(u, "PATCH", "/api/v1/me", { email: "new@x.test" })).statusCode).toBe(200);
      expect(await dead(token)).toBe(410);
    });

    it("an email change confirmed by code voids an open link; verifying the same address does not", async () => {
      const u = await member("viewer");
      const token = await link(u.id);
      const code = async (purpose: "verify" | "change", email: string) => {
        const id = randomUUID();
        await db.emailCode.create({ data: { id, userId: u.id, purpose, email, codeHash: codeHash(ring, id, "123456"), expiresAt: new Date(Date.now() + 600_000) } });
      };
      await code("verify", u.email);
      expect((await call(u, "POST", "/api/v1/me/email/confirm", { code: "123456" })).statusCode).toBe(200);
      expect(await dead(token)).toBe(200);
      await code("change", "moved@x.test");
      expect((await call(u, "POST", "/api/v1/me/email/confirm", { code: "123456" })).statusCode).toBe(200);
      expect(await dead(token)).toBe(410);
    });

    it("a reset revokes the account's API tokens and logs it; another member's stay", async () => {
      const [u, other] = [await member("viewer", PASSWORD), await member("viewer")];
      const [mine, theirs] = [await apiToken(u.id, "read", "all"), await apiToken(other.id, "read", "all")];
      const token = await link(u.id);
      expect((await app.inject({ method: "POST", url: `/api/v1/auth/reset/${token}`, headers: { origin: ORIGIN }, payload: { password: "another long password" } })).statusCode).toBe(200);
      expect((await call({ bearer: mine }, "GET", "/api/v1/projects")).statusCode).toBe(401);
      expect((await call({ bearer: theirs }, "GET", "/api/v1/projects")).statusCode).toBe(200);
      expect(await db.activityLog.count({ where: { action: "token.revoke", actorId: u.id } })).toBe(1);
    });
  });

  describe("reset links and API tokens from the server", () => {
    it("dockify admin reset-password voids links and revokes tokens, and says how many", async () => {
      const u = await member("viewer");
      const secret = await apiToken(u.id, "read", "all");
      const token = newToken();
      await db.passwordReset.create({ data: { userId: u.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 30 * 60_000) } });
      expect(await runAdmin(db, "reset-password", u.email)).toContain("1 API token was revoked");
      expect((await app.inject({ method: "GET", url: `/api/v1/auth/reset/${token}` })).statusCode).toBe(410);
      expect((await call({ bearer: secret }, "GET", "/api/v1/projects")).statusCode).toBe(401);
    });
  });

  describe("GitHub deliveries", () => {
    const seedApp = async () => {
      const row = await db.integration.create({ data: { kind: "github_app", name: "default", config: { appId: 1, slug: "dockify-test" } } });
      const a = await storeSecret(db, ring, { kind: "github_private_key", ownerType: "integration", ownerId: row.id }, "pem", null);
      const b = await storeSecret(db, ring, { kind: "github_webhook_secret", ownerType: "integration", ownerId: row.id }, HOOK, null);
      await db.integration.update({ where: { id: row.id }, data: { secretId: a, secondSecretId: b } });
    };
    const push = (repoId: number, full = "acme/shop") => JSON.stringify({
      ref: "refs/heads/main", after: "b".repeat(40), head_commit: { id: "b".repeat(40), message: "ship it", author: { username: "Sam" } },
      sender: { login: "Sam" }, repository: { id: repoId, clone_url: `https://github.com/${full}.git`, full_name: full },
    });
    const deliver = (body: string, id: string) => app.inject({
      method: "POST", url: "/api/v1/webhooks/github", payload: body,
      headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": id, "x-hub-signature-256": `sha256=${createHmac("sha256", HOOK).update(body).digest("hex")}` },
    });
    const requests: string[] = [];
    const recorder = (fail: { times: number }): DeployRequester => ({
      request: async (_db, r) => {
        if (fail.times-- > 0) throw new Error("the database went away");
        requests.push(r.appId);
        return { kind: "queued", deploymentId: randomUUID(), jobId: randomUUID() };
      },
      teardownPreview: async () => undefined,
    });

    it("a delivery that failed here runs again when redelivered with its id; a good one does not", async () => {
      requests.length = 0;
      await seedApp();
      const a = await newApp((await project()).env.id, { image: null, gitRepository: "https://github.com/acme/shop", gitBranch: "main" });
      deploys = recorder({ times: 1 });
      await boot();
      expect((await deliver(push(5), "del-1")).statusCode).toBe(500);
      expect((await deliver(push(5), "del-1")).statusCode).toBe(202);
      expect(requests).toEqual([a.id]);
      expect((await db.webhookDelivery.findFirstOrThrow({ where: { deliveryId: "del-1" } })).statusCode).toBe(202);
      expect((await deliver(push(5), "del-1")).statusCode).toBe(202);
      expect(requests).toEqual([a.id]);
    });

    it("a redelivery of a delivery already handled is answered, once, without a failed insert", async () => {
      await seedApp();
      await newApp((await project()).env.id, { image: null, gitRepository: "https://github.com/acme/shop", gitBranch: "main" });
      deploys = recorder({ times: 0 });
      await boot();
      requests.length = 0;
      expect((await deliver(push(5), "del-quiet")).statusCode).toBe(202);
      // Prisma logs every failed query raw (prisma:error), caught or not: the repeat must not be one.
      const create = vi.spyOn(db.webhookDelivery, "create");
      expect((await deliver(push(5), "del-quiet")).statusCode).toBe(202);
      expect(create).not.toHaveBeenCalled();
      create.mockRestore();
      expect(requests).toHaveLength(1);
      expect(await db.webhookDelivery.count({ where: { deliveryId: "del-quiet" } })).toBe(1);
    });

    it("two redeliveries at once run it once", async () => {
      requests.length = 0;
      await seedApp();
      await newApp((await project()).env.id, { image: null, gitRepository: "https://github.com/acme/shop", gitBranch: "main" });
      deploys = recorder({ times: 1 });
      await boot();
      await deliver(push(5), "del-2");
      await Promise.all([deliver(push(5), "del-2"), deliver(push(5), "del-2")]);
      expect(requests).toHaveLength(1);
    });

    it("webhooks past the anonymous limit are not refused, and leave that limit alone", async () => {
      await seedApp();
      const body = push(5);
      for (let i = 0; i < 150; i++) {
        const res = await app.inject({ method: "POST", url: "/api/v1/webhooks/github", payload: body, headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": `x-${i}`, "x-hub-signature-256": "sha256=bad" } });
        expect(res.statusCode).toBe(401);
      }
      expect((await app.inject({ method: "GET", url: "/api/v1/public/status/none" })).statusCode).not.toBe(429);
    });

    describe("push matching reads the app's repository", () => {
      it("an app from repo B follows B's pushes, whatever its project was made for", async () => {
        requests.length = 0;
        await seedApp();
        const p = await db.project.create({ data: { slug: "made-for-a", name: "made-for-a", gitRepoId: "1000" } });
        const env = await db.environment.create({ data: { projectId: p.id, name: "production", branch: "main" } });
        const a = await newApp(env.id, { image: null, gitRepository: "https://github.com/acme/b", gitRepoId: "2000", gitBranch: "main" });
        deploys = recorder({ times: 0 });
        await boot();
        expect((await deliver(push(1000, "acme/a"), "a-1")).statusCode).toBe(202);
        expect(requests).toEqual([]);
        expect((await deliver(push(2000, "acme/b"), "b-1")).statusCode).toBe(202);
        expect(requests).toEqual([a.id]);
      });

      it("an app with no id of its own goes by its URL, not by its project's id", async () => {
        requests.length = 0;
        await seedApp();
        const p = await db.project.create({ data: { slug: "made-for-a2", name: "made-for-a2", gitRepoId: "1000" } });
        const env = await db.environment.create({ data: { projectId: p.id, name: "production", branch: "main" } });
        const a = await newApp(env.id, { image: null, gitRepository: "https://github.com/acme/b", gitBranch: "main" });
        deploys = recorder({ times: 0 });
        await boot();
        await deliver(push(1000, "acme/a"), "a-2");
        expect(requests).toEqual([]);
        await deliver(push(2000, "acme/b"), "b-2");
        expect(requests).toEqual([a.id]);
      });
    });
  });

  describe("Vercel import applies the domain rules", () => {
    const connect = async () => {
      const r = await db.integration.create({ data: { kind: "vercel", name: "default", config: { username: "o", name: "O", team: null } } });
      const secretId = await storeSecret(db, ring, { kind: "integration_token", ownerType: "integration", ownerId: r.id }, "vercel-token", "oken");
      await db.integration.update({ where: { id: r.id }, data: { secretId } });
    };
    const run = (admin: Who, slug: string) => call(admin, "POST", "/api/v1/integrations/vercel/import", { project: slug, environment: "production", vercelProjectId: "prj_1", target: "production" });

    it("skips a name the rules refuse, counts it, and takes the good one", async () => {
      const admin = await member("admin");
      await connect();
      const p = await project();
      const a = await newApp(p.env.id, { kind: "frontend" });
      domains = ["shop.example.com", "printer.local"];
      const res = await run(admin, p.slug);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ domains: 1, domainsSkipped: 1 });
      expect((await db.domain.findMany({ where: { appId: a.id } })).map((d) => d.hostname)).toEqual(["shop.example.com"]);
    });

    it("a dashboard's previous address is refused like any other path", async () => {
      const admin = await member("admin");
      await connect();
      const p = await project();
      await newApp(p.env.id, { kind: "frontend" });
      await db.instance.update({ where: { id: 1 }, data: { dashboardPreviousHosts: ["old-dash.example.com"] } });
      domains = ["old-dash.example.com"];
      expect((await run(admin, p.slug)).json()).toMatchObject({ domains: 0, domainsSkipped: 1 });
      expect(await db.domain.count()).toBe(0);
    });

    it("gives no domain to a linked app that stays on Vercel, even beside a server frontend", async () => {
      const admin = await member("admin");
      await connect();
      const p = await project();
      await newApp(p.env.id, { kind: "frontend", image: null, deployTarget: "vercel", vercelFollowOnly: true, vercelProjectId: "prj_1" });
      await newApp(p.env.id, { kind: "frontend" });
      domains = ["shop.example.com"];
      expect((await run(admin, p.slug)).json()).toMatchObject({ domains: 0, domainsSkipped: 1 });
      expect(await db.domain.count()).toBe(0);
    });

    it("gives no domain to an environment's only app when it is a database", async () => {
      const admin = await member("admin");
      await connect();
      const p = await project();
      await newApp(p.env.id, { kind: "postgres" });
      domains = ["shop.example.com"];
      expect((await run(admin, p.slug)).json()).toMatchObject({ domains: 0, domainsSkipped: 1 });
      expect(await db.domain.count()).toBe(0);
    });
  });

  describe("commands are an admin's to read", () => {
    const seed = async () => {
      const p = await project();
      const a = await newApp(p.env.id, { image: null, gitRepository: "https://github.com/a/b", startCommand: "run --token=START", buildCommand: "build --token=BUILD", installCommand: "npm ci --token=INSTALL", releaseCommand: "migrate --token=RELEASE" });
      await db.scheduledJob.create({ data: { appId: a.id, name: "nightly", schedule: "0 3 * * *", command: "report --token=JOB" } });
      return a;
    };

    it("a Viewer and a read token get no command text on any route", async () => {
      const a = await seed();
      const viewer = await member("viewer");
      const owner = await member("admin");
      for (const who of [viewer, { bearer: await apiToken(owner.id, "read", "all") }] satisfies Who[]) {
        for (const path of [`/api/v1/apps/${a.id}`, `/api/v1/apps/${a.id}/config`, `/api/v1/apps/${a.id}/jobs`]) {
          const res = await call(who, "GET", path);
          expect(res.statusCode, path).toBe(200);
          expect(res.body, path).not.toContain("--token=");
        }
        expect((await call(who, "GET", `/api/v1/apps/${a.id}/jobs`)).json().jobs[0]).toMatchObject({ name: "nightly", command: "" });
      }
    });

    it("an admin session and an admin token still read them", async () => {
      const a = await seed();
      const admin = await member("admin");
      for (const who of [admin, { bearer: await apiToken(admin.id, "admin", "all") }] satisfies Who[]) {
        expect((await call(who, "GET", `/api/v1/apps/${a.id}`)).json().settings).toMatchObject({ startCommand: "run --token=START", buildCommand: "build --token=BUILD", installCommand: "npm ci --token=INSTALL" });
        expect((await call(who, "GET", `/api/v1/apps/${a.id}/config`)).json().release.command).toBe("migrate --token=RELEASE");
        expect((await call(who, "GET", `/api/v1/apps/${a.id}/jobs`)).json().jobs[0].command).toBe("report --token=JOB");
      }
    });
  });

  describe("a project-limited token reads no server-wide details", () => {
    const seed = async () => {
      await db.notificationWebhook.create({ data: { name: "ops-discord", provider: "discord", host: "discord.com" } });
      const s = await db.integration.create({ data: { kind: "storage", name: "s3", config: { provider: "s3", endpoint: "https://s3.example.com", bucket: "private-bucket", region: "eu" } } });
      const d = await db.backupDestination.create({ data: { name: "s3", type: "s3", integrationId: s.id } });
      await db.backup.create({ data: { sourceAppId: randomUUID(), appSnapshot: {}, kind: "control_plane", trigger: "pre_update", status: "failed", destinationId: d.id, error: "bucket private-bucket refused" } });
    };

    it("alerts and server, with an all-project token keeping them", async () => {
      await seed();
      const admin = await member("admin");
      const p = await project();
      const limited = { bearer: await apiToken(admin.id, "admin", [p.id]) };
      const all = { bearer: await apiToken(admin.id, "admin", "all") };

      const seen = (await call(limited, "GET", "/api/v1/alerts")).json();
      expect(seen.webhooks).toEqual([]);
      expect(seen.channels).toEqual({ discord: false, webhook: false, email: false });
      const server = await call(limited, "GET", "/api/v1/server");
      expect(server.statusCode).toBe(200);
      expect(server.json().controlPlaneBackup).toBeNull();
      expect(server.body).not.toContain("private-bucket");

      expect((await call(all, "GET", "/api/v1/alerts")).json().webhooks).toHaveLength(1);
      expect((await call(all, "GET", "/api/v1/server")).json().controlPlaneBackup).toMatchObject({ status: "failed" });
    });
  });
});
