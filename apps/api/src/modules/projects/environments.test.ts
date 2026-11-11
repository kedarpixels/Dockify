/**
 * Environments are optional: a new project starts with one, production, and the project's settings
 * add or remove more. Removing one deletes everything in it (its apps, databases, volumes, domains,
 * routes and variables) by queueing each app's remove_app job in the same transaction that drops the
 * rows, refuses while one of its apps deploys, and never removes the last one. Through the real app
 * and a really migrated Postgres: needs DATABASE_URL_TEST, like the other integration tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashToken, newToken } from "@dockify/crypto";
import { createDb, defaultServerId, type Db } from "@dockify/db";
import { projects as P } from "@dockify/contracts";
import { buildApp } from "../../app.ts";
import { ensureInstance } from "../../boot.ts";
import { testConfig, testRing } from "../../test-helpers.ts";
import { setRegistryResolver } from "./handlers.ts";

describe("placeLabel", () => {
  it("names the environment only in a project with several", () => {
    expect(P.placeLabel("shop", "production", 1, "web")).toBe("shop/web");
    expect(P.placeLabel("shop", "staging", 2, "web")).toBe("shop/staging/web");
    // A count nobody read keeps the environment, as labels always did.
    expect(P.placeLabel("shop", "production", undefined, "web")).toBe("shop/production/web");
  });
});

describe("a new project's body", () => {
  it("may leave the environments out, and older clients that send them still pass", () => {
    expect(P.NewProjectBody.safeParse({ repoUrl: "", name: "shop" }).success).toBe(true);
    expect(P.NewProjectBody.safeParse({ repoUrl: "", name: "shop", environments: ["production", "dev"] }).success).toBe(true);
    expect(P.NewProjectBody.safeParse({ repoUrl: "", name: "shop", environments: [] }).success).toBe(false);
  });
});

const url = process.env.DATABASE_URL_TEST;
const ring = testRing();
const ORIGIN = "https://dockify.test";

describe.skipIf(!url)("environments (postgres)", () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let serverId: string;
  let teamId: string;
  let n = 0;

  beforeAll(async () => {
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
    await app?.close();
    ({ app } = await buildApp({ db, ring, config: testConfig(), workerWatch: false, logger: false }));
    await app.ready();
  });

  /** A signed-in member; `elevated` is a session that stepped up in the last five minutes. */
  const member = async (role: "admin" | "viewer", elevated = true) => {
    const user = await db.user.create({ data: { email: `${role}-${++n}@x.test`, name: `${role}${n}`, passwordHash: "x", passwordChangedAt: new Date() } });
    await db.member.create({ data: { teamId, userId: user.id, role } });
    const tok = newToken();
    const now = Date.now();
    await db.session.create({
      data: {
        userId: user.id, tokenHash: hashToken(tok), lastSeenAt: new Date(), expiresAt: new Date(now + 3.6e6), absoluteExpiresAt: new Date(now + 3.6e6),
        elevatedUntil: elevated ? new Date(now + 3e5) : null,
      },
    });
    return { cookie: `__Host-dockify_sid=${tok}` };
  };
  const call = (who: { cookie: string }, method: "GET" | "POST" | "PUT" | "DELETE", path: string, payload?: unknown) =>
    app.inject({ method, url: path, headers: { origin: ORIGIN, cookie: who.cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });

  describe("a new project", () => {
    it("starts with one environment, production, when the body names none", async () => {
      const admin = await member("admin");
      const res = await call(admin, "POST", "/api/v1/projects", { repoUrl: "", name: "shop" });
      expect(res.statusCode).toBe(201);
      const p = await db.project.findUniqueOrThrow({ where: { slug: "shop" }, include: { environments: true } });
      expect(p.environments.map((e) => e.name)).toEqual(["production"]);
    });

    it("still takes the list an older client sends", async () => {
      const admin = await member("admin");
      const res = await call(admin, "POST", "/api/v1/projects", { repoUrl: "", name: "both", environments: ["production", "dev"] });
      expect(res.statusCode).toBe(201);
      const envs = await db.environment.findMany({ where: { project: { slug: "both" } }, orderBy: { name: "asc" } });
      expect(envs.map((e) => e.name)).toEqual(["dev", "production"]);
    });

    it("writes its apps to the activity log without an environment until it has a second one", async () => {
      const admin = await member("admin");
      await call(admin, "POST", "/api/v1/projects", { repoUrl: "", name: "solo" });
      const first = await call(admin, "POST", "/api/v1/projects/solo/apps", { name: "web", kind: "backend", environment: "production" });
      expect(first.statusCode).toBe(201);
      expect((await call(admin, "POST", "/api/v1/projects/solo/environments", { name: "staging", branch: "dev" })).statusCode).toBe(201);
      expect((await call(admin, "POST", "/api/v1/projects/solo/apps", { name: "api", kind: "backend", environment: "staging" })).statusCode).toBe(201);
      const labels = (await db.activityLog.findMany({ where: { action: "app.create" }, orderBy: { at: "asc" } })).map((r) => r.targetLabel);
      expect(labels).toEqual(["solo/web", "solo/staging/api"]);
    });
  });

  describe("removing an environment", () => {
    /** shop: production with one app, staging with a web app (a domain and a volume) and a Postgres, variables in both, a preview built from staging. */
    const seed = async () => {
      const admin = await member("admin");
      expect((await call(admin, "POST", "/api/v1/projects", { repoUrl: "", name: "shop", environments: ["production", "staging"] })).statusCode).toBe(201);
      const p = await db.project.findUniqueOrThrow({ where: { slug: "shop" }, include: { environments: true } });
      const prod = p.environments.find((e) => e.name === "production")!;
      const staging = p.environments.find((e) => e.name === "staging")!;
      const keep = await db.app.create({ data: { environmentId: prod.id, serverId, name: "web", kind: "frontend", image: "nginx:1", port: 80 } });
      const web = await db.app.create({ data: { environmentId: staging.id, serverId, name: "web", kind: "frontend", image: "nginx:1", port: 80, containerId: "c-web" } });
      await db.volume.create({ data: { appId: web.id, name: `dk-${web.id}-uploads`, mountPath: "/uploads" } });
      await db.domain.create({ data: { appId: web.id, hostname: "staging.shop.test", cfZoneId: "z1", cfRecordId: "r1" } });
      await db.domain.create({ data: { appId: web.id, hostname: "web-1-2-3-4.sslip.io", testDomain: true } });
      // A database, as New app makes one: its credentials sealed, its data volume recorded.
      expect((await call(admin, "POST", "/api/v1/projects/shop/apps", { name: "db", kind: "postgres", environment: "staging" })).statusCode).toBe(201);
      const pg = await db.app.findFirstOrThrow({ where: { environmentId: staging.id, name: "db" }, include: { volumes: true } });
      const applied = await call(admin, "POST", "/api/v1/projects/shop/env/apply", {
        baseVersion: 0,
        redeploy: false,
        changes: [
          { environment: "production", key: "KEEP", op: "add", value: "1", secret: true },
          { environment: "staging", key: "SHARED", op: "add", value: "s", secret: true },
          { environment: "staging", appId: web.id, key: "OWN", op: "add", value: "o", secret: true },
        ],
      });
      expect(applied.statusCode).toBe(200);
      await db.project.update({ where: { id: p.id }, data: { previewEnabled: true, previewBaseEnv: "staging" } });
      const preview = await db.previewEnv.create({ data: { projectId: p.id, baseEnvironmentId: staging.id, prNumber: 7, title: "t", branch: "feat", repo: "a/b", repoKey: "github.com/a/b", domain: "preview.shop.test" } });
      return { admin, p, prod, staging, keep, web, pg, preview };
    };

    it("deletes its apps, databases, volumes, domains and variables, and queues each app's teardown", async () => {
      const s = await seed();
      const secretsBefore = await db.secret.count();
      const res = await call(s.admin, "DELETE", "/api/v1/projects/shop/environments/staging", { confirm: "staging" });
      expect(res.statusCode).toBe(204);

      expect(await db.environment.findMany({ where: { projectId: s.p.id }, select: { name: true } })).toEqual([{ name: "production" }]);
      expect(await db.app.findMany({ where: { environment: { projectId: s.p.id } }, select: { id: true } })).toEqual([{ id: s.keep.id }]);
      expect(await db.volume.count({ where: { appId: { in: [s.web.id, s.pg.id] } } })).toBe(0);
      expect(await db.domain.count()).toBe(0);
      expect(await db.previewEnv.count({ where: { id: s.preview.id } })).toBe(0);
      // Only production's variable is left, and the secrets the others held went with them.
      expect((await db.envVar.findMany({ select: { key: true } })).map((v) => v.key)).toEqual(["KEEP"]);
      expect(await db.secret.count()).toBeLessThan(secretsBefore);
      expect(await db.secret.count({ where: { id: { in: [s.pg.passwordSecretId!] } } })).toBe(0);

      // The worker removes what ran: every container, named volume, route and recorded Cloudflare object.
      const jobs = await db.job.findMany({ where: { kind: "remove_app" } });
      const payloads = jobs.map((j) => j.payload as { appId: string; volumeNames: string[]; domains: Array<{ hostname: string; cfRecordId: string | null }> });
      expect(payloads.map((x) => x.appId).sort()).toEqual([s.web.id, s.pg.id].sort());
      const web = payloads.find((x) => x.appId === s.web.id)!;
      expect(web.volumeNames).toEqual([`dk-${s.web.id}-uploads`]);
      expect(web.domains.map((d) => d.hostname).sort()).toEqual(["staging.shop.test", "web-1-2-3-4.sslip.io"]);
      expect(payloads.find((x) => x.appId === s.pg.id)!.volumeNames).toEqual(s.pg.volumes.map((v) => v.name));

      // Previews move to what is left, and the log says what went.
      expect((await db.project.findUniqueOrThrow({ where: { id: s.p.id } })).previewBaseEnv).toBe("production");
      const row = await db.activityLog.findFirstOrThrow({ where: { action: "environment.delete" } });
      expect(row).toMatchObject({ targetLabel: "shop/staging", suffix: "and 2 apps" });
    });

    it("refuses a confirmation that is not its name, and changes nothing", async () => {
      const s = await seed();
      const res = await call(s.admin, "DELETE", "/api/v1/projects/shop/environments/staging", { confirm: "production" });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("CONFIRM_MISMATCH");
      expect(await db.environment.count({ where: { projectId: s.p.id } })).toBe(2);
      expect(await db.job.count({ where: { kind: "remove_app" } })).toBe(0);
    });

    it("asks a session to step up first, and a viewer cannot at all", async () => {
      const s = await seed();
      const stale = await member("admin", false);
      const res = await call(stale, "DELETE", "/api/v1/projects/shop/environments/staging", { confirm: "staging" });
      expect(res.statusCode).toBe(403);
      const viewer = await member("viewer");
      expect((await call(viewer, "DELETE", "/api/v1/projects/shop/environments/staging", { confirm: "staging" })).statusCode).toBe(403);
      expect(await db.environment.count({ where: { projectId: s.p.id } })).toBe(2);
      expect(await db.app.count({ where: { environmentId: s.staging.id } })).toBe(2);
    });

    it("holds while one of its apps deploys, and goes through once it settles", async () => {
      const s = await seed();
      const dep = await db.deployment.create({ data: { appId: s.web.id, serverId, trigger: "manual", status: "building", actorType: "user", steps: [] } });
      const res = await call(s.admin, "DELETE", "/api/v1/projects/shop/environments/staging", { confirm: "staging" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "DEPLOY_IN_FLIGHT", deploymentId: dep.id });
      expect(await db.app.count({ where: { environmentId: s.staging.id } })).toBe(2);
      expect(await db.job.count({ where: { kind: "remove_app" } })).toBe(0);
      await db.deployment.update({ where: { id: dep.id }, data: { status: "failed" } });
      expect((await call(s.admin, "DELETE", "/api/v1/projects/shop/environments/staging", { confirm: "staging" })).statusCode).toBe(204);
    });

    it("never removes the last one, production or not", async () => {
      const s = await seed();
      expect((await call(s.admin, "DELETE", "/api/v1/projects/shop/environments/production", { confirm: "production" })).statusCode).toBe(204);
      const last = await call(s.admin, "DELETE", "/api/v1/projects/shop/environments/staging", { confirm: "staging" });
      expect(last.statusCode).toBe(409);
      expect(last.json().code).toBe("LAST_ENVIRONMENT");
      expect(await db.environment.findMany({ where: { projectId: s.p.id }, select: { name: true } })).toEqual([{ name: "staging" }]);
      expect(await db.app.count({ where: { environmentId: s.staging.id } })).toBe(2);
    });

    it("two removals at once leave one environment, never none", async () => {
      const s = await seed();
      const [a, b] = await Promise.all([
        call(s.admin, "DELETE", "/api/v1/projects/shop/environments/staging", { confirm: "staging" }),
        call(s.admin, "DELETE", "/api/v1/projects/shop/environments/production", { confirm: "production" }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([204, 409]);
      expect(await db.environment.count({ where: { projectId: s.p.id } })).toBe(1);
    });
  });
});
