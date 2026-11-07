import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projects as P, resources as R } from "@dockify/contracts";
import { parseServiceCredentials, readSecretValue, sealServiceCredentials, storeSecret, type Db } from "@dockify/db";
import type { Actor } from "../../actor.ts";
import type { Ctx, Handler } from "../../app.ts";
import { testConfig, testRing } from "../../test-helpers.ts";
import { resolveValue, servicesOf } from "../projects/env-model.ts";
import { openRefTarget } from "../projects/env-store.ts";
import { projectsHandlers } from "../projects/handlers.ts";
import { resourcesHandlers, serviceVersionOf, toResourceRow } from "./index.ts";

type Row = Record<string, any>;

const PROJECT = "0f0f0f0f-0000-4000-8000-0000000000f1";
const ENV = "0f0f0f0f-0000-4000-8000-0000000000e1";
const STAGING = "0f0f0f0f-0000-4000-8000-0000000000e2";
const ENVS = [{ id: ENV, name: "production", projectId: PROJECT }, { id: STAGING, name: "staging", projectId: PROJECT }];

/**
 * Rows in memory, enough for createApps, a variable apply, the deploy enqueue and the resource row
 * read. A transaction puts back the rows it created when it throws, as Postgres would.
 */
function fakeDb(apps: Row[] = []) {
  const t = {
    apps: apps.map((a) => ({ status: "unknown", cpuLimit: null, memoryLimitMb: null, ...a })) as Row[],
    secrets: [] as Row[], volumes: [] as Row[], deployments: [] as Row[], jobs: [] as Row[], activity: [] as Row[], envVars: [] as Row[], versions: [] as Row[],
  };
  const project = { id: PROJECT, slug: "acme", name: "Acme", archivedAt: null, envVersion: 0 };
  const db: Row = {
    project: {
      findUnique: async ({ where }: Row) => (where.id === PROJECT || where.slug === "acme" ? project : null),
      findUniqueOrThrow: async () => ({ envVersion: project.envVersion }),
      updateMany: async ({ where }: Row) => {
        if (where.envVersion !== project.envVersion) return { count: 0 };
        project.envVersion += 1;
        return { count: 1 };
      },
    },
    environment: {
      findUnique: async ({ where }: Row) => ENVS.find((e) => e.name === where.projectId_name?.name) ?? null,
      findMany: async () => ENVS.map((e) => ({ id: e.id, name: e.name })),
    },
    integration: { count: async () => 0 },
    secret: {
      create: async ({ data }: Row) => (t.secrets.push(data), data),
      findUnique: async ({ where }: Row) => t.secrets.find((s) => s.id === where.id) ?? null,
      findMany: async ({ where }: Row) => t.secrets.filter((s) => where.id.in.includes(s.id)),
      delete: async ({ where }: Row) => t.secrets.splice(t.secrets.findIndex((s) => s.id === where.id), 1)[0],
    },
    app: {
      create: async ({ data }: Row) => (t.apps.push({ status: "unknown", cpuLimit: null, memoryLimitMb: null, ...data }), data),
      findMany: async ({ where }: Row) => t.apps.filter((a) => where.environmentId.in.includes(a.environmentId)),
      findUnique: async ({ where }: Row) => t.apps.find((a) => a.id === where.id) ?? null,
      // New apps are checked against the display names of their environment (no two apps look alike).
      findFirst: async ({ where }: Row) =>
        t.apps.find((a) => a.environmentId === where.environmentId && where.OR.some((o: Row) => a.displayName && a.displayName.toLowerCase() === o.displayName.equals.toLowerCase())) ?? null,
      update: async ({ where, data }: Row) => Object.assign(t.apps.find((a) => a.id === where.id)!, data),
      updateMany: async ({ where, data }: Row) => {
        const a = t.apps.find((x) => x.id === where.id);
        if (a) Object.assign(a, data);
        return { count: a ? 1 : 0 };
      },
      findUniqueOrThrow: async ({ where }: Row) => {
        const a = t.apps.find((x) => x.id === where.id)!;
        return {
          ...a,
          environment: { name: "production", project: { id: PROJECT, slug: "acme" } },
          volumes: t.volumes.filter((v) => v.appId === a.id).map((v) => ({ name: v.name, sizeBytes: null })),
          currentDeployment: null,
        };
      },
    },
    volume: { create: async ({ data }: Row) => (t.volumes.push(data), data) },
    envVar: {
      findMany: async () => t.envVars,
      create: async ({ data }: Row) => (t.envVars.push({ updatedAt: new Date(), ...data }), data),
      update: async ({ where, data }: Row) => Object.assign(t.envVars.find((v) => v.id === where.id)!, data),
    },
    envVersion: { create: async ({ data }: Row) => (t.versions.push(data), data) },
    deployment: {
      findFirst: async () => null,
      create: async ({ data }: Row) => {
        const row = { id: `dep-${t.deployments.length + 1}`, ...data };
        t.deployments.push(row);
        return row;
      },
    },
    job: {
      findFirst: async () => null,
      create: async ({ data }: Row) => {
        const row = { id: `job-${t.jobs.length + 1}`, ...data };
        t.jobs.push(row);
        return row;
      },
    },
    activityLog: { create: async ({ data }: Row) => (t.activity.push(data), data) },
    server: { findFirst: async () => ({ id: "primary" }) },
    $executeRaw: async () => 0,
  };
  db.$transaction = async (fn: (tx: unknown) => unknown) => {
    const before = Object.fromEntries(Object.entries(t).map(([k, rows]) => [k, [...rows]]));
    try {
      return await fn(db);
    } catch (e) {
      for (const [k, rows] of Object.entries(before)) (t as Record<string, Row[]>)[k]!.splice(0, Infinity, ...rows);
      throw e;
    }
  };
  return { db: db as unknown as Db, t };
}

const ring = testRing();
const ctxOf = (db: Db): Ctx => ({ db, ring, config: testConfig(), web: { origin: "https://dockify.test", secure: true }, limits: {} as never });
const admin: Actor = { kind: "session", userId: "u1", name: "Owner", role: "admin", sessionId: "s1", elevated: true };
const req = { clientIp: "203.0.113.9", headers: { "user-agent": "vitest" } };
const call = (h: unknown, ctx: Ctx, body: Row, params: Row = {}, actor: Actor = admin) =>
  (h as Handler<never>)({ body: body as never, query: undefined as never, params: params as never, actor, req: req as never, reply: {} as never, ctx } as never) as Promise<any>;

describe("resources.create (managed services)", () => {
  it("creates a Redis with sealed JSON credentials and its named volume, queues its deploy, and answers a resource row", async () => {
    const { db, t } = fakeDb();
    const out = await call(resourcesHandlers["resources.create"], ctxOf(db), { kind: "redis", name: "cache", projectId: PROJECT, environment: "production" });

    expect(R.ResourceRow.parse(out)).toEqual(out);
    expect(out).toMatchObject({ name: "cache", kind: "redis", projectSlug: "acme", environment: "production", image: "redis:8.2-alpine", version: "8.2" });
    const app = t.apps[0]!;
    expect(out.volume).toEqual({ name: `dockify-data-${app.id}`, sizeBytes: 0 });
    expect(t.volumes).toEqual([{ appId: app.id, name: `dockify-data-${app.id}`, mountPath: "/data" }]);
    // The credentials are the shared JSON shape the worker reads, never a bare string.
    const raw = (await readSecretValue(db, ring, app.passwordSecretId))!;
    expect(parseServiceCredentials(raw, { kind: "redis", name: "cache" })).toMatchObject({ legacy: false, credentials: { user: "default" } });
    expect(JSON.parse(raw)).toEqual({ user: "default", password: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/) });
    // Provisioning is its first deploy, through the worker's managed path.
    expect(t.jobs).toEqual([expect.objectContaining({ kind: "deploy", lane: "deploy", dedupeKey: `deploy:${app.id}` })]);
    expect(t.deployments[0]).toMatchObject({ appId: app.id, trigger: "manual", status: "queued" });
    // A new app goes on the primary server, and its deployment and job follow it.
    expect(app.serverId).toBe("primary");
    expect(t.deployments[0]!.serverId).toBe("primary");
    expect(t.jobs[0]!.serverId).toBe("primary");
    // No variable is written anywhere for a service.
    expect(t.envVars).toEqual([]);
    expect(t.activity.map((a) => a.action)).toEqual(["app.create", "app.deploy"]);
  });

  it("creates a Postgres with its database in the credentials and its volume at the data path", async () => {
    const { db, t } = fakeDb();
    const out = await call(resourcesHandlers["resources.create"], ctxOf(db), { kind: "postgres", name: "main-db", projectId: PROJECT, environment: "production" });
    expect(out).toMatchObject({ image: "postgres:17-alpine", version: "17" });
    expect(t.volumes[0]).toMatchObject({ mountPath: "/var/lib/postgresql/data" });
    expect(JSON.parse((await readSecretValue(db, ring, t.apps[0]!.passwordSecretId))!)).toMatchObject({ user: "dockify", database: "main_db" });
  });

  it("refuses Storage and an unknown project, creating nothing", async () => {
    const { db, t } = fakeDb();
    await expect(call(resourcesHandlers["resources.create"], ctxOf(db), { kind: "s3", name: "files", projectId: PROJECT, environment: "production" })).rejects.toMatchObject({ status: 400, code: "KIND_UNAVAILABLE" });
    await expect(call(resourcesHandlers["resources.create"], ctxOf(db), { kind: "redis", name: "cache", projectId: ENV, environment: "production" })).rejects.toMatchObject({ status: 404 });
    expect(t.apps).toEqual([]);
  });
});

describe("New app, Database or service", () => {
  it("stores the same credential shape and volume row as resources.create", async () => {
    const { db, t } = fakeDb();
    const out = await call(projectsHandlers["projects.apps.create"], ctxOf(db), { name: "cache", kind: "redis", environment: "production", target: "server", source: { type: "service", service: "redis", version: "7.4" } }, { slug: "acme" });
    const app = t.apps[0]!;
    expect(out).toEqual({ id: app.id });
    expect(app).toMatchObject({ kind: "redis", image: "redis:7.4-alpine", port: 6379 });
    expect(t.volumes).toEqual([{ appId: app.id, name: `dockify-data-${app.id}`, mountPath: "/data" }]);
    expect(JSON.parse((await readSecretValue(db, ring, app.passwordSecretId))!)).toMatchObject({ user: "default" });
  });

  it("gives the old bare shape of a database kind the same: newest version, credentials and volume", async () => {
    const { db, t } = fakeDb();
    await call(projectsHandlers["projects.apps.create"], ctxOf(db), { name: "db", kind: "postgres", environment: "production" }, { slug: "acme" });
    expect(t.apps[0]).toMatchObject({ kind: "postgres", image: "postgres:17-alpine", port: 5432 });
    expect(t.volumes[0]).toMatchObject({ name: `dockify-data-${t.apps[0]!.id}`, mountPath: "/var/lib/postgresql/data" });
    expect(t.apps[0]!.passwordSecretId).toBeTruthy();
  });

  it("refuses Storage, and variables or volumes on a service", async () => {
    const { db, t } = fakeDb();
    await expect(call(projectsHandlers["projects.apps.create"], ctxOf(db), { name: "files", kind: "s3", environment: "production", target: "server", source: { type: "service", service: "minio", version: "latest" } }, { slug: "acme" }))
      .rejects.toMatchObject({ status: 400, code: "REFUSED", extra: { field: "source.service" } });
    await expect(call(projectsHandlers["projects.apps.create"], ctxOf(db), { name: "files", kind: "s3", environment: "production" }, { slug: "acme" })).rejects.toMatchObject({ status: 400 });
    await expect(call(projectsHandlers["projects.apps.create"], ctxOf(db), {
      name: "cache", kind: "redis", environment: "production", target: "server", source: { type: "service", service: "redis", version: "7.4" }, env: [{ key: "REDIS_ARGS", value: "--save ''" }],
    }, { slug: "acme" })).rejects.toMatchObject({ status: 400 });
    expect(t.apps).toEqual([]);
  });
});

describe("New app, linking a new service to apps", () => {
  const API = "0f0f0f0f-0000-4000-8000-0000000000a1";
  const WEB = "0f0f0f0f-0000-4000-8000-0000000000a2";
  const STAGE_API = "0f0f0f0f-0000-4000-8000-0000000000a3";
  const CACHE = "0f0f0f0f-0000-4000-8000-0000000000a4";
  const seeded = () => [
    { id: API, name: "api", kind: "backend", environmentId: ENV },
    { id: WEB, name: "web", kind: "frontend", environmentId: ENV },
    { id: STAGE_API, name: "api", kind: "backend", environmentId: STAGING },
    { id: CACHE, name: "cache", kind: "redis", environmentId: ENV },
  ];
  const postgres = (link?: Row) => ({ name: "db", kind: "postgres", environment: "production", target: "server", source: { type: "service", service: "postgres", version: "17" }, ...(link ? { link } : {}) });
  const redis = (link?: Row) => ({ name: "queue", kind: "redis", environment: "production", target: "server", source: { type: "service", service: "redis", version: "8.2" }, ...(link ? { link } : {}) });
  const create = (db: Db, body: Row, actor?: Actor) => call(projectsHandlers["projects.apps.create"], ctxOf(db), body, { slug: "acme" }, actor);

  /** A variable as the Variables page stores one: sealed, secret. */
  async function seedVar(db: Db, t: { envVars: Row[] }, v: { scope: "app" | "environment"; scopeId: string; key: string; value: string }) {
    const id = randomUUID();
    const secretId = await storeSecret(db, ring, { kind: "env_var", ownerType: "env_var", ownerId: id }, v.value);
    t.envVars.push({ id, scopeType: v.scope, scopeId: v.scopeId, key: v.key, secretId, isSecret: true, target: "both", updatedAt: new Date(), updatedBy: "Owner" });
  }

  it("gives each picked app DATABASE_URL as a reference to the new Postgres, which follows a changed credential", async () => {
    const { db, t } = fakeDb(seeded());
    const out = await create(db, postgres({ apps: [API, WEB] }));
    const vars = t.envVars.filter((v) => v.key === "DATABASE_URL");
    expect(vars.map((v) => [v.scopeType, v.scopeId, v.isSecret, v.target])).toEqual([["app", API, false, "runtime"], ["app", WEB, false, "runtime"]]);
    // The stored value is the reference itself, never a copy of the credential.
    const ref = P.encodeEnvRef({ resourceId: out.id, field: "url" });
    for (const v of vars) expect(await readSecretValue(db, ring, v.secretId)).toBe(ref);
    // It resolves to the service's credentials at deploy time, so a rotated password follows.
    const svc = t.apps.find((a) => a.id === out.id)!;
    const resolve = () => resolveValue(ref, servicesOf(t.apps as never), (s) => openRefTarget(db, ring, s));
    const creds = JSON.parse((await readSecretValue(db, ring, svc.passwordSecretId))!);
    expect(await resolve()).toBe(`postgresql://dockify:${creds.password}@db:5432/${creds.database}`);
    svc.passwordSecretId = await sealServiceCredentials(db, ring, svc.id, { ...creds, password: "N".repeat(32) });
    expect(await resolve()).toBe(`postgresql://dockify:${"N".repeat(32)}@db:5432/${creds.database}`);
    // One variable version, audited as an apply, next to the app's own row.
    expect(t.versions).toHaveLength(1);
    expect(t.versions[0]!.changes).toEqual([
      expect.objectContaining({ appName: "api", key: "DATABASE_URL", op: "add" }),
      expect.objectContaining({ appName: "web", key: "DATABASE_URL", op: "add" }),
    ]);
    expect(t.activity.map((a) => a.action)).toEqual(["env.apply", "app.create"]);
  });

  it("gives a new Redis REDIS_URL, and links nothing when no app is picked", async () => {
    const { db, t } = fakeDb(seeded());
    await create(db, redis({ apps: [WEB] }));
    expect(t.envVars.map((v) => [v.scopeId, v.key])).toEqual([[WEB, "REDIS_URL"]]);
    const { db: db2, t: t2 } = fakeDb(seeded());
    await create(db2, redis({ apps: [] }));
    expect(t2.envVars).toEqual([]);
    expect(t2.versions).toEqual([]);
  });

  it("never replaces a variable silently: an app that has the name, its own or a shared one, is answered with 409 and nothing is created", async () => {
    const { db, t } = fakeDb(seeded());
    await seedVar(db, t, { scope: "app", scopeId: API, key: "DATABASE_URL", value: "postgresql://old" });
    const secrets = t.secrets.length;
    await expect(create(db, postgres({ apps: [API, WEB] }))).rejects.toMatchObject({
      status: 409, code: "LINK_CONFLICT", message: "api already has DATABASE_URL. Confirm to replace it.",
      extra: { field: "link", key: "DATABASE_URL", apps: [{ id: API, name: "api", shared: false }] },
    });
    expect(t.apps).toHaveLength(4);
    expect(t.volumes).toEqual([]);
    expect(t.secrets).toHaveLength(secrets);
    expect(await readSecretValue(db, ring, t.envVars[0]!.secretId)).toBe("postgresql://old");

    await seedVar(db, t, { scope: "environment", scopeId: ENV, key: "REDIS_URL", value: "redis://shared" });
    await expect(create(db, redis({ apps: [API, WEB] }))).rejects.toMatchObject({
      status: 409, message: "api and web already have REDIS_URL. Confirm to replace it.",
      extra: { apps: [{ id: API, name: "api", shared: true }, { id: WEB, name: "web", shared: true }] },
    });
  });

  it("replaces only what the caller agreed to: an app's own variable keeps where it is used, a shared one stays for the others", async () => {
    const { db, t } = fakeDb(seeded());
    await seedVar(db, t, { scope: "app", scopeId: API, key: "DATABASE_URL", value: "postgresql://old" });
    await seedVar(db, t, { scope: "environment", scopeId: ENV, key: "DATABASE_URL", value: "postgresql://shared" });
    await expect(create(db, postgres({ apps: [API, WEB], replace: [API] }))).rejects.toMatchObject({ status: 409, extra: { apps: [{ id: WEB, shared: true }] } });
    const out = await create(db, postgres({ apps: [API, WEB], replace: [API, WEB] }));
    const ref = P.encodeEnvRef({ resourceId: out.id, field: "url" });
    const api = t.envVars.find((v) => v.scopeType === "app" && v.scopeId === API)!;
    expect([api.isSecret, api.target, await readSecretValue(db, ring, api.secretId)]).toEqual([false, "both", ref]);
    const web = t.envVars.find((v) => v.scopeType === "app" && v.scopeId === WEB)!;
    expect([web.target, await readSecretValue(db, ring, web.secretId)]).toEqual(["runtime", ref]);
    const shared = t.envVars.find((v) => v.scopeType === "environment")!;
    expect(await readSecretValue(db, ring, shared.secretId)).toBe("postgresql://shared");
    expect(t.versions[0]!.changes.map((c: Row) => [c.appName, c.op])).toEqual([["api", "change"], ["web", "add"]]);
  });

  it("links only apps that run code in the same environment, only from one new Postgres or Redis, and never for a token", async () => {
    const { db, t } = fakeDb(seeded());
    await expect(create(db, postgres({ apps: [STAGE_API] }))).rejects.toMatchObject({ status: 400, code: "LINK_TARGET", extra: { field: "link" } });
    await expect(create(db, postgres({ apps: [CACHE] }))).rejects.toMatchObject({ status: 400, code: "LINK_TARGET" });
    await expect(create(db, postgres({ apps: ["0f0f0f0f-0000-4000-8000-0000000000ff"] }))).rejects.toMatchObject({ status: 400, code: "LINK_TARGET" });
    await expect(create(db, { name: "site", kind: "backend", environment: "production", target: "server", source: { type: "image", image: "nginx:1.27", registryId: null }, link: { apps: [API] } }))
      .rejects.toMatchObject({ status: 400, code: "REFUSED", extra: { field: "link" } });
    const token: Actor = { kind: "token", userId: "u1", name: "ci", role: "admin", tokenId: "t1", scope: "admin" as never, allProjects: true, projectIds: [], grants: [], elevated: false };
    await expect(create(db, postgres({ apps: [API] }), token)).rejects.toMatchObject({ status: 403 });
    expect(t.apps).toHaveLength(4);
    expect(t.envVars).toEqual([]);
  });
});

describe("resource rows", () => {
  it("reads a service's version from its tag", () => {
    expect(serviceVersionOf("postgres:16-alpine")).toBe("16");
    expect(serviceVersionOf("redis:7.4-alpine")).toBe("7.4");
    expect(serviceVersionOf(`redis:8.2-alpine@sha256:${"a".repeat(64)}`)).toBe("8.2");
    expect(serviceVersionOf("minio/minio:latest")).toBeUndefined();
    expect(serviceVersionOf(null)).toBeUndefined();
  });

  it("counts uptime from when the container itself started, and only while it is up", () => {
    const at = new Date("2026-11-06T08:00:00.000Z");
    const row = (status: string, containerStartedAt: Date | null) =>
      toResourceRow({
        id: "a1", name: "db", kind: "postgres", status, image: "postgres:17-alpine", cpuLimit: null, memoryLimitMb: null, containerStartedAt,
        environment: { name: "production", project: { id: PROJECT, slug: "acme" } }, volumes: [],
      } as never, undefined).startedAt;
    expect(row("running", at)).toBe(at.toISOString());
    expect(row("degraded", at)).toBe(at.toISOString());
    for (const s of ["stopped", "exited", "restarting", "missing", "failed", "deploying", "unknown"]) expect(row(s, at)).toBeNull();
    expect(row("running", null)).toBeNull();
  });
});
