/**
 * Regression tests for these security rules:
 *   3   a two-factor change ends every other session (turning two-factor off)
 *   5   a token's project scope is explicit: "all" chosen at creation, or named projects; never implied
 *   6   env writes are elevated; a token needs admin plus the env:write grant; hook keys need an
 *       explicit confirmation and leave an audit row
 *   20  the secret-opening routes: internal token, pinned peer, kind allowlist, live job, audit
 * No database: fakes only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auth, projects as P } from "@dockify/contracts";
import { hashToken, internalChannelToken, open } from "@dockify/crypto";
import { storeSecret, type Db } from "@dockify/db";
import { assertProjectScope, tokenProjectLimit, type Actor } from "./actor.ts";
import { buildApp, type Ctx, type Handlers } from "./app.ts";
import { cookieName } from "./cookies.ts";
import { HttpError } from "./errors.ts";
import { WORKER_OPEN_KINDS } from "./internal/secrets.ts";
import { POLICIES } from "./policy.ts";
import { RateLimits } from "./ratelimit.ts";
import { accountHandlers } from "./routes/account.ts";
import { checkSpec } from "./modules/projects/app-source.ts";
import { dangerousGate, dangerousIn, projectsHandlers } from "./modules/projects/handlers.ts";
import { tokenHandlers } from "./modules/platform/tokens.ts";
import { totpAt } from "./totp.ts";
import { noDb, testConfig, testRing } from "./test-helpers.ts";

const web = { origin: "https://dockify.test", secure: true };
const ring = testRing();
const call = <T>(h: unknown, input: Record<string, unknown>): Promise<T> => (h as (i: unknown) => Promise<T>)(input);
const fakeReq = () => ({ clientIp: "203.0.113.9", headers: { "user-agent": "vitest" } });
const session = (elevated = false, role: Actor["role"] = "admin"): Actor => ({ kind: "session", userId: "u1", name: "Owner", role, sessionId: "s1", elevated });
const token = (over: Partial<Extract<Actor, { kind: "token" }>> = {}): Actor => ({
  kind: "token", userId: "u1", name: "ci", role: "admin", tokenId: "t1", scope: "admin", allProjects: false, projectIds: [], grants: [], elevated: false, ...over,
});
const ctxOf = (db: unknown): Ctx => ({ db: db as Db, ring, config: testConfig(), web, limits: new RateLimits() });

async function rejects(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("expected a rejection");
}

/** A secrets table in a map, enough for storeSecret and both shapes keyringVault reads with. */
function secretsTable() {
  const rows = new Map<string, Record<string, unknown>>();
  const secret = {
    create: async ({ data }: { data: Record<string, unknown> }) => (rows.set(String(data.id), data), data),
    findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
    findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => rows.get(id)).filter(Boolean),
  };
  return { rows, secret };
}

// ------------------------------------------------------------------ 3

describe("item 3: a two-factor change ends every other session", () => {
  it("turning two-factor off evicts other sessions, trusted devices and pending sign-ins in the same transaction", async () => {
    const { secret } = secretsTable();
    const totpSecretId = await storeSecret({ secret } as never, ring, { kind: "totp", ownerType: "user", ownerId: "u1" }, "JBSWY3DPEHPK3PXP");
    const sessionUpdates: unknown[] = [];
    const devices = vi.fn(async () => ({ count: 1 }));
    const challenges = vi.fn(async () => ({ count: 0 }));
    const userUpdate = vi.fn(async () => ({}));
    const secretDelete = vi.fn(async () => ({}));
    const tx = {
      secret: { ...secret, delete: secretDelete },
      user: { update: userUpdate },
      session: { updateMany: async (q: unknown) => (sessionUpdates.push(q), { count: 2 }) },
      trustedDevice: { updateMany: devices },
      loginChallenge: { updateMany: challenges },
      activityLog: { create: async () => ({}) },
    };
    let inTransaction = 0;
    const db = {
      ...tx,
      user: {
        findUniqueOrThrow: async () => ({ id: "u1", totpSecretId, totpConfirmedAt: new Date(), totpLastUsedStep: null }),
        updateMany: async () => ({ count: 1 }),
      },
      $transaction: async (fn: (t: unknown) => unknown) => {
        inTransaction += 1;
        return fn(tx);
      },
    };
    await call(accountHandlers["me.2fa.disable"], {
      body: { code: totpAt("JBSWY3DPEHPK3PXP", Date.now()) }, actor: session(), req: fakeReq(), reply: { header() { return this; } }, ctx: ctxOf(db),
    });
    expect(inTransaction).toBe(1);
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: "u1" }, data: { totpSecretId: null, totpConfirmedAt: null, totpLastUsedStep: null } });
    expect(secretDelete).toHaveBeenCalledWith({ where: { id: totpSecretId } });
    expect(sessionUpdates[0]).toMatchObject({ where: { userId: "u1", revokedAt: null, id: { not: "s1" } } });
    expect(devices).toHaveBeenCalledTimes(1);
    expect(challenges).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------ 5

describe("item 5: a token's project scope is explicit", () => {
  it("requires a choice at creation: 'all' or at least one slug, never an empty or absent list", () => {
    const base = { name: "ci", scope: "deploy", expiresInDays: 30 };
    expect(auth.CreateTokenBody.safeParse(base).success).toBe(false);
    expect(auth.CreateTokenBody.safeParse({ ...base, projects: [] }).success).toBe(false);
    expect(auth.CreateTokenBody.safeParse({ ...base, projects: "all" }).success).toBe(true);
    expect(auth.CreateTokenBody.safeParse({ ...base, projects: ["shop"] }).success).toBe(true);
  });

  it("a token with no project rows reaches no project; only allProjects reaches every project", () => {
    expect(tokenProjectLimit(token())).toEqual([]);
    expect(() => assertProjectScope(token(), "p1")).toThrow(/limited/);
    expect(tokenProjectLimit(token({ projectIds: ["p1"] }))).toEqual(["p1"]);
    expect(() => assertProjectScope(token({ projectIds: ["p1"] }), "p2")).toThrow(/limited/);
    expect(() => assertProjectScope(token({ projectIds: ["p1"] }), "p1")).not.toThrow();
    expect(tokenProjectLimit(token({ allProjects: true }))).toBeNull();
    expect(() => assertProjectScope(token({ allProjects: true }), "p9")).not.toThrow();
    expect(tokenProjectLimit(session())).toBeNull();
  });

  it("stores the choice as a column and the grants, and refuses a grant without the admin scope", async () => {
    const created: Array<Record<string, unknown>> = [];
    const tx = {
      $executeRaw: async () => 0,
      apiToken: {
        count: async () => 0,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: "t1", name: data.name, scope: data.scope, prefix: data.prefix, createdAt: new Date(), expiresAt: null, lastUsedAt: null, allProjects: data.allProjects, grants: data.grants, projects: [] };
        },
      },
      project: { findMany: async ({ where }: { where: { slug: { in: string[] } } }) => where.slug.in.map((slug) => ({ id: `id-${slug}`, slug })) },
      activityLog: { create: async () => ({}) },
    };
    const db = { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) };
    const mint = (body: Record<string, unknown>) => call<{ token: { allProjects: boolean; grants: string[] } }>(tokenHandlers["tokens.create"], { body, actor: session(true), req: fakeReq(), ctx: ctxOf(db) });

    const all = await mint({ name: "ci", scope: "admin", expiresInDays: null, projects: "all", grants: ["env:write"] });
    expect(created[0]).toMatchObject({ allProjects: true, grants: ["env:write"], projects: { create: [] } });
    expect(all.token).toMatchObject({ allProjects: true, grants: ["env:write"] });

    await mint({ name: "ci2", scope: "deploy", expiresInDays: null, projects: ["shop", "shop"] });
    expect(created[1]).toMatchObject({ allProjects: false, grants: [], projects: { create: [{ projectId: "id-shop" }] } });

    const e = await rejects(mint({ name: "ci3", scope: "deploy", expiresInDays: null, projects: "all", grants: ["env:write"] }));
    expect(e.code).toBe("GRANT_NEEDS_ADMIN");
  });
});

// ------------------------------------------------------------------ 6

describe("item 6: env writes are elevated, tokens need admin plus env:write, hook keys need confirmation", () => {
  it("puts every env write behind step-up, with the token path gated by the grant", () => {
    for (const id of ["env.put", "env.apply", "env.rollback"] as const) {
      expect(POLICIES[id]).toEqual({ access: "elevated", role: "admin", token: "admin", grant: "env:write" });
    }
  });

  describe("through the enforcing hook", () => {
    let app: Awaited<ReturnType<typeof buildApp>>["app"];
    const tokens = new Map<string, Record<string, unknown>>();
    const handlers: Handlers = { "env.apply": (async () => ({ version: 2, deploymentIds: [] })) as never };
    beforeAll(async () => {
      const db = {
        apiToken: {
          findUnique: async ({ where }: { where: { tokenHash: string } }) => tokens.get(where.tokenHash) ?? null,
          update: async () => ({}),
          updateMany: async () => ({ count: 1 }),
        },
        activityLog: { create: async () => ({}) },
      };
      ({ app } = await buildApp({ db: db as unknown as Db, ring, config: testConfig(), logger: false, handlers, integrations: false }));
      await app.ready();
    });
    afterAll(() => app.close());

    const row = (scope: string, grants: string[]) => ({
      id: "t", userId: "u", name: "ci", scope, revokedAt: null, expiresAt: null, allProjects: true, grants,
      user: { disabledAt: null, member: { role: "admin" } }, projects: [],
    });
    const apply = async (raw: string) => {
      const res = await app.inject({
        method: "POST", url: "/api/v1/projects/shop/env/apply", headers: { authorization: `Bearer ${raw}` },
        payload: { baseVersion: 1, redeploy: false, changes: [{ environment: "production", key: "A", op: "add", value: "1" }] },
      });
      return { status: res.statusCode, code: (res.json() as { code?: string }).code };
    };

    it("refuses an admin token without the grant, a deploy token with it, and passes an admin token with it", async () => {
      tokens.set(hashToken("dk_admin"), row("admin", []));
      tokens.set(hashToken("dk_deploy"), row("deploy", ["env:write"]));
      tokens.set(hashToken("dk_granted"), row("admin", ["env:write"]));
      expect(await apply("dk_admin")).toEqual({ status: 403, code: "TOKEN_GRANT" });
      expect(await apply("dk_deploy")).toEqual({ status: 403, code: "TOKEN_SCOPE" });
      expect((await apply("dk_granted")).status).toBe(200);
    });

    it("answers step_up_required to a plain session", async () => {
      const db = {
        session: {
          findUnique: async () => ({
            id: "s1", userId: "u1", revokedAt: null, elevatedUntil: null, expiresAt: new Date(Date.now() + 3600_000), absoluteExpiresAt: new Date(Date.now() + 7200_000),
            lastSeenAt: new Date(), user: { name: "Owner", disabledAt: null, member: { role: "admin" } },
          }),
        },
      };
      const { app: plain } = await buildApp({ db: db as unknown as Db, ring, config: testConfig(), logger: false, handlers, integrations: false });
      for (const url of ["/api/v1/projects/shop/env", "/api/v1/projects/shop/env/apply", "/api/v1/projects/shop/env/rollback"]) {
        const res = await plain.inject({ method: url.endsWith("/env") ? "PUT" : "POST", url, headers: { origin: web.origin, cookie: `${cookieName(web, "session")}=x` }, payload: {} });
        expect(res.statusCode, url).toBe(403);
        expect(res.json()).toMatchObject({ code: "STEP_UP_REQUIRED" });
      }
      await plain.close();
    });
  });

  it("names the loader and interpreter hook keys, case-insensitively", () => {
    for (const k of ["NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV", "PYTHONSTARTUP", "PERL5OPT", "JAVA_TOOL_OPTIONS", "ld_preload"]) {
      expect(P.isDangerousEnvKey(k), k).toBe(true);
    }
    for (const k of ["DATABASE_URL", "NODE_ENV", "PORT", "ENVIRONMENT", "LD_X"]) expect(P.isDangerousEnvKey(k), k).toBe(false);
    expect(dangerousIn([{ key: "NODE_OPTIONS", op: "add" }, { key: "LD_PRELOAD", op: "remove" }, { key: "PORT", op: "change" }, { key: "NODE_OPTIONS", op: "change" }])).toEqual(["NODE_OPTIONS"]);
  });

  it("lets only an elevated session that confirms set a hook key, and never a token", () => {
    expect(dangerousGate(session(true), [], undefined)).toEqual([]);
    expect(() => dangerousGate(token({ allProjects: true, grants: ["env:write"] }), ["NODE_OPTIONS"], true)).toThrow(/API tokens cannot set NODE_OPTIONS/);
    expect(() => dangerousGate(session(false), ["NODE_OPTIONS"], true)).toThrow(/step_up_required/);
    const e = (() => { try { dangerousGate(session(true), ["NODE_OPTIONS", "LD_PRELOAD"], false); } catch (x) { return x as HttpError; } return null; })();
    expect(e?.code).toBe("DANGEROUS_KEY_CONFIRM");
    expect(e?.extra).toEqual({ keys: ["NODE_OPTIONS", "LD_PRELOAD"] });
    expect(dangerousGate(session(true), ["NODE_OPTIONS"], true)).toEqual(["NODE_OPTIONS"]);
  });

  it("refuses a hook key on app creation, pointing at the one door that confirms it", () => {
    const spec = P.AppSpec.parse({ name: "web", kind: "backend", target: "server", source: { type: "image", image: "nginx:1.27", registryId: null }, env: [{ key: "LD_PRELOAD", value: "/x.so" }] });
    expect(checkSpec(spec).map((r) => r.field)).toContain("env.0.key");
  });

  it("accepts the confirmation flag on each env write body", () => {
    expect(P.EnvApplyBody.safeParse({ baseVersion: 0, redeploy: false, confirmDangerous: true, changes: [{ environment: "production", key: "NODE_OPTIONS", op: "add", value: "--x" }] }).success).toBe(true);
    expect(P.EnvPutBody.safeParse({ environment: "production", confirmDangerous: true, vars: [{ key: "A", value: "1", secret: false }] }).success).toBe(true);
    expect(P.EnvRollbackBody.safeParse({ version: 1, baseVersion: 2, redeploy: false, confirmDangerous: true }).success).toBe(true);
  });
});

// ------------------------------------------------------------------ env reveal

describe("env reveal: no step-up, but Admin only, audited and rate limited", () => {
  it("is a session-only route for admins: tokens cannot reveal secrets", () => {
    expect(POLICIES["env.reveal"]).toEqual({ access: "session", role: "admin" });
  });

  describe("through the enforcing hook", () => {
    let app: Awaited<ReturnType<typeof buildApp>>["app"];
    const tokens = new Map<string, Record<string, unknown>>();
    let role: "viewer" | "admin" = "viewer";
    const handlers: Handlers = { "env.reveal": (async () => ({ value: "x" })) as never };
    beforeAll(async () => {
      const db = {
        apiToken: {
          findUnique: async ({ where }: { where: { tokenHash: string } }) => tokens.get(where.tokenHash) ?? null,
          update: async () => ({}),
        },
        session: {
          findUnique: async () => ({
            id: "s1", userId: "u1", revokedAt: null, elevatedUntil: null, expiresAt: new Date(Date.now() + 3600_000), absoluteExpiresAt: new Date(Date.now() + 7200_000),
            lastSeenAt: new Date(), user: { name: "Someone", disabledAt: null, member: { role } },
          }),
          update: async () => ({}),
          updateMany: async () => ({ count: 1 }),
        },
        activityLog: { create: async () => ({}) },
      };
      ({ app } = await buildApp({ db: db as unknown as Db, ring, config: testConfig(), logger: false, handlers, integrations: false }));
      await app.ready();
    });
    afterAll(() => app.close());

    const payload = { environment: "production", key: "DATABASE_URL", purpose: "copy" };
    const bySession = async () => {
      const res = await app.inject({ method: "POST", url: "/api/v1/projects/shop/env/reveal", headers: { origin: web.origin, cookie: `${cookieName(web, "session")}=x` }, payload });
      return { status: res.statusCode, code: (res.json() as { code?: string }).code };
    };
    const byToken = async (raw: string) => {
      const res = await app.inject({ method: "POST", url: "/api/v1/projects/shop/env/reveal", headers: { authorization: `Bearer ${raw}` }, payload });
      return { status: res.statusCode, code: (res.json() as { code?: string }).code };
    };
    const row = (scope: string, grants: string[]) => ({
      id: "t", userId: "u", name: "ci", scope, revokedAt: null, expiresAt: null, allProjects: true, grants,
      user: { disabledAt: null, member: { role: "admin" } }, projects: [],
    });

    it("refuses a Viewer session and lets an Admin session through without step-up", async () => {
      role = "viewer";
      expect(await bySession()).toEqual({ status: 403, code: "FORBIDDEN" });
      role = "admin";
      expect((await bySession()).status).toBe(200);
    });

    it("refuses every API token, even admin plus env:write: tokens never reach plaintext", async () => {
      tokens.set(hashToken("dk_read"), row("read", []));
      tokens.set(hashToken("dk_deploy"), row("deploy", ["env:write"]));
      tokens.set(hashToken("dk_admin"), row("admin", []));
      tokens.set(hashToken("dk_granted"), row("admin", ["env:write"]));
      for (const raw of ["dk_read", "dk_deploy", "dk_admin", "dk_granted"]) {
        expect(await byToken(raw)).toEqual({ status: 403, code: "FORBIDDEN" });
      }
    });
  });

  describe("the handler", () => {
    const PLAIN = "postgres://app:s3cret-pw@db/shop";
    const setup = async () => {
      const { secret } = secretsTable();
      const secretId = await storeSecret({ secret } as never, ring, { kind: "env_var", ownerType: "env_var", ownerId: "v1" }, PLAIN);
      const audits: Array<Record<string, unknown>> = [];
      const db = {
        secret,
        project: { findUnique: async () => ({ id: "p1", slug: "shop", archivedAt: null }) },
        environment: { findMany: async () => [{ id: "e1", name: "production" }] },
        app: { findMany: async () => [] },
        envVar: { findUnique: async () => ({ id: "v1", secretId, isSecret: true }) },
        activityLog: { create: async ({ data }: { data: Record<string, unknown> }) => (audits.push(data), data) },
      };
      return { audits, ctx: ctxOf(db) };
    };
    const reveal = (ctx: Ctx, body: Record<string, unknown>, actor: Actor = session(false, "admin")) =>
      call<{ value: string }>(projectsHandlers["env.reveal"], {
        params: { slug: "shop" }, body, actor, req: fakeReq(), reply: { header() { return this; } }, ctx,
      });

    it("returns the value to a plain session and writes an env.reveal audit row without the value", async () => {
      const { audits, ctx } = await setup();
      const r = await reveal(ctx, { environment: "production", key: "DATABASE_URL", purpose: "copy" });
      expect(r.value).toBe(PLAIN);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        category: "access", action: "env.reveal", actorType: "user", actorId: "u1", ip: "203.0.113.9",
        targetType: "env_var", targetId: "v1", targetLabel: "shop/production/DATABASE_URL", suffix: "for copy",
        changes: { key: "DATABASE_URL", project: "shop", environment: "production", purpose: "copy", linked: false },
      });
      expect(JSON.stringify(audits)).not.toContain("s3cret-pw");
    });

    it("rate limits reveals per session", async () => {
      const { ctx } = await setup();
      for (let i = 0; i < 60; i++) await reveal(ctx, { environment: "production", key: "DATABASE_URL" });
      const e = await rejects(reveal(ctx, { environment: "production", key: "DATABASE_URL" }));
      expect(e.status).toBe(429);
      expect(e.code).toBe("RATE_LIMITED");
      // Another session has its own bucket.
      const other: Actor = { kind: "session", userId: "u2", name: "Admin", role: "admin", sessionId: "s2", elevated: false };
      expect((await reveal(ctx, { environment: "production", key: "DATABASE_URL" }, other)).value).toBe(PLAIN);
    });
  });
});

// ------------------------------------------------------------------ 20

describe("item 20: the secret-opening routes", () => {
  const { rows, secret } = secretsTable();
  const audits: Array<Record<string, unknown>> = [];
  const jobs = new Map<string, Record<string, unknown>>();
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let envId = "";
  let totpId = "";
  let backupId = "";
  const internalToken = internalChannelToken(ring);
  const PEER = "172.30.2.20";

  beforeAll(async () => {
    envId = await storeSecret({ secret } as never, ring, { kind: "env_var", ownerType: "env_var", ownerId: "row1" }, "postgres://app:pw@db/x");
    totpId = await storeSecret({ secret } as never, ring, { kind: "totp", ownerType: "user", ownerId: "u1" }, "JBSWY3DPEHPK3PXP");
    backupId = await storeSecret({ secret } as never, ring, { kind: "backup_key", ownerType: "instance", ownerId: "1" }, Buffer.alloc(32, 7).toString("base64"));
    jobs.set("11111111-1111-4111-8111-111111111111", { kind: "deploy", lockedUntil: new Date(Date.now() + 60_000), completedAt: null, failedAt: null });
    jobs.set("22222222-2222-4222-8222-222222222222", { kind: "deploy", lockedUntil: new Date(Date.now() - 1), completedAt: null, failedAt: null });
    const db = {
      secret: {
        ...secret,
        findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => rows.get(id)).filter(Boolean),
      },
      job: { findUnique: async ({ where }: { where: { id: string } }) => jobs.get(where.id) ?? null },
      activityLog: { create: async ({ data }: { data: Record<string, unknown> }) => (audits.push(data), data) },
    };
    ({ app } = await buildApp({ db: db as unknown as Db, ring, config: testConfig({ internalPeers: [PEER] }), logger: false, handlers: {}, integrations: false }));
    await app.ready();
  });
  afterAll(() => app.close());

  const post = (url: string, payload: Record<string, unknown>, over: { token?: string; peer?: string } = {}) =>
    app.inject({ method: "POST", url, payload, remoteAddress: over.peer ?? PEER, headers: { authorization: `Bearer ${over.token ?? internalToken}` } });
  const ctx = { jobId: null, purpose: "timer:observe" };

  it("keeps the worker's reachable kinds to the ones it needs: never TOTP seeds, env versions or webhook secrets", () => {
    for (const k of ["totp", "env_version", "github_webhook_secret"]) expect(WORKER_OPEN_KINDS.has(k as never), k).toBe(false);
  });

  it("needs the internal token, from the pinned peer, and never a session or an API token", async () => {
    expect((await post("/internal/secrets/open", { ids: [envId], context: ctx }, { token: "dk_whatever" })).statusCode).toBe(401);
    expect((await post("/internal/secrets/open", { ids: [envId], context: ctx }, { peer: "172.30.1.20" })).statusCode).toBe(403);
    const noAuth = await app.inject({ method: "POST", url: "/internal/secrets/open", payload: { ids: [envId], context: ctx }, remoteAddress: PEER });
    expect(noAuth.statusCode).toBe(401);
    expect(audits.filter((a) => a.action === "secret.open")).toHaveLength(0);
  });

  it("opens only the rows named, of allowed kinds, and audits each call with its context", async () => {
    const res = await post("/internal/secrets/open", { ids: [envId], context: ctx });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ values: { [envId]: "postgres://app:pw@db/x" } });
    expect(audits.at(-1)).toMatchObject({ action: "secret.open", actorType: "system", actorName: "worker", targetType: "worker", targetLabel: "timer:observe", suffix: "1 value (env_var)" });

    const refused = await post("/internal/secrets/open", { ids: [envId, totpId], context: ctx });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "SECRET_KIND_REFUSED" });
    expect(audits.at(-1)).toMatchObject({ action: "secret.open.refused", failed: true });

    const missing = await post("/internal/secrets/open", { ids: ["33333333-3333-4333-8333-333333333333"], context: ctx });
    expect(missing.json()).toEqual({ values: { "33333333-3333-4333-8333-333333333333": null } });
  });

  it("binds an open to a live job of the named kind", async () => {
    const live = await post("/internal/secrets/open", { ids: [envId], context: { jobId: "11111111-1111-4111-8111-111111111111", purpose: "deploy" } });
    expect(live.statusCode).toBe(200);
    expect(audits.at(-1)).toMatchObject({ targetType: "job", targetId: "11111111-1111-4111-8111-111111111111", targetLabel: "deploy" });
    const expired = await post("/internal/secrets/open", { ids: [envId], context: { jobId: "22222222-2222-4222-8222-222222222222", purpose: "deploy" } });
    expect(expired.json()).toMatchObject({ code: "JOB_NOT_LIVE" });
    const wrongKind = await post("/internal/secrets/open", { ids: [envId], context: { jobId: "11111111-1111-4111-8111-111111111111", purpose: "backup" } });
    expect(wrongKind.json()).toMatchObject({ code: "JOB_KIND_MISMATCH" });
    const unknown = await post("/internal/secrets/open", { ids: [envId], context: { jobId: "44444444-4444-4444-8444-444444444444", purpose: "deploy" } });
    expect(unknown.statusCode).toBe(409);
  });

  it("seals only the kinds the worker creates, with the row id in the AAD so the api can open it later", async () => {
    const id = "55555555-5555-4555-8555-555555555555";
    const res = await post("/internal/secrets/seal", { id, kind: "env_snapshot", ownerType: "deployment", ownerId: "d1", value: "{\"v\":1}", context: ctx });
    expect(res.statusCode).toBe(200);
    const s = res.json() as Record<string, string>;
    const sealed = { kekId: s.kekId as string, wrappedDek: Buffer.from(s.wrappedDek as string, "base64"), dekNonce: Buffer.from(s.dekNonce as string, "base64"), ciphertext: Buffer.from(s.ciphertext as string, "base64"), ctNonce: Buffer.from(s.ctNonce as string, "base64") };
    expect(open(ring, { id, kind: "env_snapshot", scope: "deployment:d1" }, sealed)).toBe("{\"v\":1}");
    expect(() => open(ring, { id: "other", kind: "env_snapshot", scope: "deployment:d1" }, sealed)).toThrow();
    const bad = await post("/internal/secrets/seal", { id, kind: "totp", ownerType: "user", ownerId: "u1", value: "x", context: ctx });
    expect(bad.statusCode).toBe(400);
  });

  it("escrows the backup key row only", async () => {
    const ok = await post("/internal/secrets/escrow", { id: backupId, context: ctx });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { text: string }).text).toContain("dockify-backup-key");
    expect((ok.json() as { text: string }).text).not.toContain(Buffer.alloc(32, 7).toString("base64"));
    const no = await post("/internal/secrets/escrow", { id: envId, context: ctx });
    expect(no.statusCode).toBe(403);
    expect(audits.at(-1)).toMatchObject({ action: "secret.escrow.refused", failed: true });
  });

  it("is not rate limited per address like a browser, but still validates its body", async () => {
    for (let i = 0; i < 150; i++) expect((await post("/internal/secrets/open", { ids: [envId], context: ctx })).statusCode).toBe(200);
    expect((await post("/internal/secrets/open", { ids: [], context: ctx })).statusCode).toBe(400);
    expect((await post("/internal/secrets/open", { ids: [envId] })).statusCode).toBe(400);
  });
});

// ------------------------------------------------------------------ the api still holds the key

describe("the master key stays in the api", () => {
  it("builds with a keyring and the worker is not a dependency", async () => {
    const { app } = await buildApp({ db: noDb(), ring, config: testConfig(), logger: false, handlers: {}, integrations: false });
    expect(ring.keys.size).toBe(1);
    await app.close();
  });
});
