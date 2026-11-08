import { describe, expect, it, vi } from "vitest";
import { apps as Ap, projects as P } from "@dockify/contracts";
import { refView, resolveValue, servicesOf } from "../projects/env-model.ts";
import { assertVersionChangeAllowsDelete, newServiceName, serviceVersionHandlers, versionOptions } from "./service-version.ts";

vi.mock("@dockify/db", async (orig) => ({ ...(await orig<typeof import("@dockify/db")>()), linkedApps: async () => [{ id: "a1", name: "web" }], sealServiceCredentials: async () => "secret-id" }));

describe("versionOptions", () => {
  it("offers a Postgres its own line in place and a newer major through a new service, never an older one", () => {
    expect(versionOptions("postgres", "16")).toEqual([
      { version: "16", path: "in_place" },
      { version: "17", path: "new_service" },
    ]);
    expect(versionOptions("postgres", "17")).toEqual([{ version: "17", path: "in_place" }]);
  });
  it("moves a newer Redis in place, and never offers an older one", () => {
    expect(versionOptions("redis", "7.4")).toEqual([
      { version: "7.4", path: "in_place" },
      { version: "8.2", path: "in_place" },
    ]);
    expect(versionOptions("redis", "8.2")).toEqual([{ version: "8.2", path: "in_place" }]);
  });
  it("compares versions as numbers, not text", () => {
    expect(versionOptions("redis", "10.0")).toEqual([]);
  });
  it("offers nothing for a tag it cannot read", () => {
    expect(versionOptions("postgres", null)).toEqual([]);
  });
});

describe("newServiceName", () => {
  it("adds the version, and stays a valid name", () => {
    expect(newServiceName("db", "17", new Set())).toBe("db-pg17");
    expect(newServiceName("db-pg16", "17", new Set())).toBe("db-pg17");
    const long = newServiceName("a".repeat(32), "17", new Set());
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.endsWith("-pg17")).toBe(true);
  });
  it("never takes a name in use", () => {
    expect(newServiceName("db", "17", new Set(["db-pg17"]))).toBe("db-pg17-2");
  });
});

describe("the contract", () => {
  it("takes nothing but a version and the typed name", () => {
    expect(Ap.ServiceVersionChange.safeParse({ version: "17", confirm: "db" }).success).toBe(true);
    expect(Ap.ServiceVersionChange.safeParse({ version: "17", confirm: "db", image: "evil:1" }).success).toBe(false);
    expect(Ap.ServiceVersionChange.safeParse({ version: "17;rm -rf /", confirm: "db" }).success).toBe(false);
    expect(Ap.ServiceVersionChange.safeParse({ version: "17" }).success).toBe(false);
  });
});

// ------------------------------------------------------------------ the routes

const ID = "11111111-1111-4111-8111-111111111111";
const session = { kind: "session", userId: "u1", sessionId: "s1", name: "Owner", role: "admin", elevated: true };

function fake(over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: ID, name: "db", kind: "postgres", image: "postgres:16-alpine", pinnedImage: "postgres:16-alpine@sha256:abc", environmentId: "e1", serviceRedirectId: null, serviceUpgrade: null, memoryLimitMb: null, cpuLimit: null, pidsLimit: null,
    environment: { projectId: "p1", name: "production", project: { id: "p1", slug: "demo" } }, ...over,
  };
  const jobs: any[] = [];
  const created: any[] = [];
  const updates: any[] = [];
  const tiers: any[] = [
    { appId: ID, tier: "local", enabled: true, cron: "0 */12 * * *", timezone: "UTC", keep: 1, keepDays: null, destinationId: null, lastRunAt: new Date() },
    { appId: ID, tier: "offsite", enabled: true, cron: "0 3 * * *", timezone: "UTC", keep: 7, keepDays: null, destinationId: "b2", lastRunAt: new Date() },
  ];
  const db: any = {
    backupSchedule: {
      findMany: vi.fn(async ({ where }: any) => tiers.filter((t) => t.appId === where.appId)),
      createMany: vi.fn(async ({ data }: any) => { tiers.push(...data); return { count: data.length }; }),
    },
    app: {
      findUnique: vi.fn(async ({ where }: any) => (where.id === ID ? { ...row } : created.find((c) => c.id === where.id) ?? null)),
      findMany: vi.fn(async () => [{ name: "db" }]),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => { created.push(data); return data; }),
      update: vi.fn(async ({ data }: any) => { updates.push(data); Object.assign(row, data); return row; }),
    },
    job: { findFirst: vi.fn(async () => null), create: vi.fn(async ({ data }: any) => { jobs.push(data); return { id: "j1" }; }) },
    secret: { create: vi.fn(async () => ({ id: "s" })) },
    volume: { create: vi.fn(async () => ({})) },
    activityLog: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (fn: any) => fn(db)),
  };
  const ctx: any = { db, ring: { keys: new Map(), activeVersion: 1 } };
  const req: any = { clientIp: "1.1.1.1", headers: {} };
  return { db, ctx, req, jobs, created, updates, row, tiers };
}

const call = (id: "apps.version.change" | "apps.version.switch" | "apps.version.back", f: ReturnType<typeof fake>, body: unknown) =>
  (serviceVersionHandlers[id] as any)({ params: { id: ID }, body, actor: session, ctx: f.ctx, req: f.req });

describe("apps.version.change", () => {
  it("refuses a wrong name, and queues nothing", async () => {
    const f = fake();
    await expect(call("apps.version.change", f, { version: "17", confirm: "nope" })).rejects.toMatchObject({ code: "CONFIRM_MISMATCH" });
    expect(f.jobs).toEqual([]);
  });
  it("refuses a downgrade, and says what to do instead", async () => {
    const f = fake();
    await expect(call("apps.version.change", f, { version: "15", confirm: "db" })).rejects.toMatchObject({ code: "DOWNGRADE_REFUSED", status: 409 });
    expect(f.jobs).toEqual([]);
    expect(f.created).toEqual([]);
  });
  it("refuses a version it does not offer, which also keeps any image out of the body", async () => {
    const f = fake();
    await expect(call("apps.version.change", f, { version: "99", confirm: "db" })).rejects.toMatchObject({ code: "VERSION_UNKNOWN" });
  });
  it("refuses a Redis downgrade too", async () => {
    const f = fake({ kind: "redis", image: "redis:8.2-alpine" });
    await expect(call("apps.version.change", f, { version: "7.4", confirm: "db" })).rejects.toMatchObject({ code: "DOWNGRADE_REFUSED" });
  });
  it("refuses a non service", async () => {
    const f = fake({ kind: "backend", image: "ghcr.io/x/y:1" });
    await expect(call("apps.version.change", f, { version: "17", confirm: "db" })).rejects.toMatchObject({ code: "NOT_A_SERVICE" });
  });
  it("the same line queues an in place job on the data lane, one attempt", async () => {
    const f = fake();
    await call("apps.version.change", f, { version: "16", confirm: "db" });
    expect(f.jobs).toEqual([expect.objectContaining({ kind: "service_upgrade", lane: "data", maxAttempts: 1, dedupeKey: `service-upgrade:${ID}`, payload: { action: "in_place", sourceId: ID, toImage: "postgres:16-alpine", toVersion: "16" } })]);
    expect(f.created).toEqual([]);
  });
  it("a new major creates a new service with both of the source's backup tiers, and prepares only", async () => {
    const f = fake();
    await call("apps.version.change", f, { version: "17", confirm: "db" });
    expect(f.created).toEqual([expect.objectContaining({ name: "db-pg17", image: "postgres:17-alpine" })]);
    const copied = f.tiers.filter((t) => t.appId === f.created[0].id);
    expect(copied).toEqual([
      { appId: f.created[0].id, tier: "local", enabled: true, cron: "0 */12 * * *", timezone: "UTC", keep: 1, keepDays: null, destinationId: null },
      { appId: f.created[0].id, tier: "offsite", enabled: true, cron: "0 3 * * *", timezone: "UTC", keep: 7, keepDays: null, destinationId: "b2" },
    ]);
    expect(f.jobs[0].payload).toMatchObject({ action: "prepare", sourceId: ID, toVersion: "17" });
    expect(f.row.serviceRedirectId).toBeNull();
  });
  it("one change at a time", async () => {
    const f = fake();
    f.db.job.findFirst = vi.fn(async () => ({ id: "open", kind: "service_upgrade" }));
    await expect(call("apps.version.change", f, { version: "17", confirm: "db" })).rejects.toMatchObject({ code: "BUSY" });
    expect(f.created).toEqual([]);
  });
  it("waits out a backup or a restore", async () => {
    const f = fake();
    let n = 0;
    f.db.job.findFirst = vi.fn(async () => (n++ === 0 ? null : { kind: "restore" }));
    await expect(call("apps.version.change", f, { version: "17", confirm: "db" })).rejects.toMatchObject({ code: "BUSY" });
  });
  it("a service whose links moved on is changed from its new copy", async () => {
    const f = fake({ serviceRedirectId: "22222222-2222-4222-8222-222222222222" });
    await expect(call("apps.version.change", f, { version: "17", confirm: "db" })).rejects.toMatchObject({ code: "ALREADY_SWITCHED" });
  });
  it("a new service whose old copy still exists cannot move through another new service: one step of redirect only", async () => {
    const f = fake();
    f.db.app.findFirst = vi.fn(async () => ({ name: "old-db" }));
    await expect(call("apps.version.change", f, { version: "17", confirm: "db" })).rejects.toMatchObject({ code: "OLD_SERVICE_EXISTS" });
  });
});

describe("apps.version.switch", () => {
  const TARGET = "22222222-2222-4222-8222-222222222222";
  it("needs the copy to be ready", async () => {
    await expect(call("apps.version.switch", fake(), { confirm: "db" })).rejects.toMatchObject({ code: "NOT_READY" });
    await expect(call("apps.version.switch", fake({ serviceUpgrade: { phase: "copying", targetId: TARGET } }), { confirm: "db" })).rejects.toMatchObject({ code: "NOT_READY" });
  });
  it("a failed prepare cannot be switched to, only a failed switch retried", async () => {
    await expect(call("apps.version.switch", fake({ serviceUpgrade: { phase: "failed", failedAt: "prepare", targetId: TARGET } }), { confirm: "db" })).rejects.toMatchObject({ code: "NOT_READY" });
  });
  it("sets nothing itself: the worker switches after the fresh copy matches", async () => {
    const f = fake({ serviceUpgrade: { phase: "ready", targetId: TARGET } });
    f.db.app.findUnique = vi.fn(async ({ where }: any) => (where.id === ID ? { ...f.row } : { id: TARGET, name: "db-pg17" }));
    await call("apps.version.switch", f, { confirm: "db" });
    expect(f.jobs[0].payload).toEqual({ action: "switch", sourceId: ID, targetId: TARGET });
    expect(f.row.serviceRedirectId).toBeNull();
  });
});

describe("apps.version.back", () => {
  const TARGET = "22222222-2222-4222-8222-222222222222";
  it("refuses when there is nothing to go back from", async () => {
    await expect(call("apps.version.back", fake(), { confirm: "db" })).rejects.toMatchObject({ code: "NOT_SWITCHED" });
  });
  it("needs the typed name", async () => {
    const f = fake({ serviceRedirectId: TARGET });
    await expect(call("apps.version.back", f, { confirm: "x" })).rejects.toMatchObject({ code: "CONFIRM_MISMATCH" });
    expect(f.row.serviceRedirectId).toBe(TARGET);
  });
  it("clears the one column, deletes nothing", async () => {
    const f = fake({ serviceRedirectId: TARGET, serviceUpgrade: { phase: "switched", targetId: TARGET } });
    f.db.app.findUnique = vi.fn(async ({ where }: any) => (where.id === ID ? { ...f.row } : where.id === "a1" ? { desiredState: "running", gitBranch: null, currentDeployment: null } : { id: TARGET, name: "db-pg17" }));
    await call("apps.version.back", f, { confirm: "db" });
    expect(f.row.serviceRedirectId).toBeNull();
    expect(f.db.app.delete).toBeUndefined();
  });
});

describe("deleting either side", () => {
  const tx = (over: Record<string, unknown>) => ({ job: { findFirst: async () => null }, app: { findFirst: async () => null }, ...over }) as never;
  it("a service links lead to cannot be deleted", async () => {
    await expect(assertVersionChangeAllowsDelete(tx({ app: { findFirst: async () => ({ name: "db" }) } }), ID)).rejects.toMatchObject({ code: "IN_USE_BY_SWITCH" });
  });
  it("nor one in the middle of a change", async () => {
    await expect(assertVersionChangeAllowsDelete(tx({ job: { findFirst: async () => ({ id: "j" }) } }), ID)).rejects.toMatchObject({ code: "BUSY" });
  });
  it("anything else may", async () => {
    await expect(assertVersionChangeAllowsDelete(tx({}), ID)).resolves.toBeUndefined();
  });
});

describe("a switched link", () => {
  const OLD = "11111111-1111-4111-8111-111111111111";
  const NEW = "22222222-2222-4222-8222-222222222222";
  const OTHER = "33333333-3333-4333-8333-333333333333";
  const services = servicesOf([
    { id: OLD, name: "db", kind: "postgres", environmentId: "e", serviceRedirectId: NEW },
    { id: NEW, name: "db-pg17", kind: "postgres", environmentId: "e", serviceRedirectId: null },
  ]);
  const stored = P.encodeEnvRef({ resourceId: OLD, field: "url" });

  it("reveals what a deploy would get: the new service's credential", async () => {
    const opened: string[] = [];
    const value = await resolveValue(stored, services, async (svc) => {
      opened.push(svc.name);
      return { kind: "postgres", host: svc.name, port: 5432, user: "u", password: "p", database: "d" };
    });
    expect(opened).toEqual(["db-pg17"]);
    expect(value).toContain("@db-pg17:5432/");
  });
  it("lists the service it leads to now, and keeps its stored id", () => {
    expect(refView(stored, services, () => "production")).toMatchObject({ resourceId: OLD, resourceName: "db-pg17" });
  });
  it("still refuses a link outside the project, redirect or not", async () => {
    const foreign = P.encodeEnvRef({ resourceId: OTHER, field: "url" });
    await expect(resolveValue(foreign, services, async () => { throw new Error("must not open"); })).rejects.toMatchObject({ code: "REF_OUTSIDE_PROJECT" });
  });
  it("follows one step only", async () => {
    const chain = servicesOf([
      { id: OLD, name: "a", kind: "postgres", environmentId: "e", serviceRedirectId: NEW },
      { id: NEW, name: "b", kind: "postgres", environmentId: "e", serviceRedirectId: OTHER },
      { id: OTHER, name: "c", kind: "postgres", environmentId: "e", serviceRedirectId: null },
    ]);
    const hit = await resolveValue(stored, chain, async (svc) => ({ kind: "postgres", host: svc.name, port: 5432, user: "u", password: "p" }));
    expect(hit).toContain("@b:5432");
  });
  it("the no TLS url says so, for clients that want TLS unless told", () => {
    expect(P.refValue({ kind: "postgres", host: "h", port: 5432, user: "u", password: "p", database: "d" }, "urlNoTls")).toBe("postgresql://u:p@h:5432/d?sslmode=disable");
    expect(P.refFieldAllowed("redis", "urlNoTls")).toBe(false);
  });
});
