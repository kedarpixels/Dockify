import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import type { DataDeps } from "./context.ts";
import type { DockerPort } from "./docker-port.ts";
import { applyRetention, failStaleRestoreTests, failStaleRuns, fireDueSchedules, LEGACY_UPGRADE_MESSAGE, STALE_TEST_ERROR, upgradeLegacyServices } from "./scheduler.ts";
import { STALE_RUN_ERROR, staleReason } from "./requests.ts";

type Row = Record<string, any>;

const APP = "0f0f0f0f-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-06T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

/** Matches the job filters the sweeps use: kind (or kind in), dedupeKey, payload backupId, open-ness and an OR of those. */
function matches(j: Row, where: Row): boolean {
  if (where.OR && !(where.OR as Row[]).some((w) => matches(j, w))) return false;
  if (typeof where.kind === "string" && j.kind !== where.kind) return false;
  if (where.kind?.in && !where.kind.in.includes(j.kind)) return false;
  if (where.dedupeKey !== undefined && j.dedupeKey !== where.dedupeKey) return false;
  if (where.payload && j.payload?.backupId !== where.payload.equals) return false;
  if ("completedAt" in where && (j.completedAt ?? null) !== where.completedAt) return false;
  if ("failedAt" in where && (j.failedAt ?? null) !== where.failedAt) return false;
  return true;
}

function fakeDb(backups: Row[], jobs: Row[]) {
  const db = {
    backup: {
      findMany: async ({ where }: Row) => backups.filter((b) => Object.entries(where).every(([k, v]) => b[k] === v)),
      update: async ({ where, data }: Row) => Object.assign(backups.find((b) => b.id === where.id)!, data),
    },
    job: {
      findFirst: async ({ where, orderBy }: Row) => {
        const hits = jobs.filter((j) => matches(j, where));
        if (orderBy?.createdAt === "desc") hits.sort((a, b) => b.createdAt - a.createdAt);
        return hits[0] ?? null;
      },
    },
  };
  return db as unknown as Db;
}

describe("a scheduled backup that meets a running restore", () => {
  const busyDb = (error: Error) => {
    const app = { id: APP, backupCron: "* * * * *", backupTimezone: "UTC", backupLastRunAt: ago(5), createdAt: ago(100) };
    const db = {
      app: {
        findMany: async () => [{ ...app }],
        updateMany: async ({ where, data }: Row) => {
          if (where.backupLastRunAt !== app.backupLastRunAt) return { count: 0 };
          Object.assign(app, data);
          return { count: 1 };
        },
      },
      $transaction: async () => { throw error; },
    };
    return { db: db as unknown as Db, app };
  };

  it("gives the slot back and says so, so the next tick tries again", async () => {
    const was = ago(5);
    const { db, app } = busyDb(Object.assign(new Error("A restore of this database is running"), { code: "BUSY" }));
    app.backupLastRunAt = was;
    const logged: string[] = [];
    expect(await fireDueSchedules(db, NOW, (m) => void logged.push(m))).toBe(0);
    expect(app.backupLastRunAt).toBe(was);
    expect(logged).toEqual(["a scheduled backup was not taken"]);
  });

  it("any other failure is logged and keeps the slot", async () => {
    const { db, app } = busyDb(new Error("database gone"));
    const logged: string[] = [];
    expect(await fireDueSchedules(db, NOW, (m) => void logged.push(m))).toBe(0);
    expect(app.backupLastRunAt).toBe(NOW);
    expect(logged).toHaveLength(1);
  });
});

describe("retention of the offsite copies of pre-update dumps", () => {
  it("expires them like any other backup, keeping the newest three", async () => {
    const rows: Row[] = [0, 1, 2, 3].map((i) => ({ id: `d${i}`, kind: "control_plane", status: "ready", trigger: "pre_update", objectKey: `k${i}`, expiredAt: null, destinationId: null, createdAt: new Date(NOW.getTime() - (40 + i) * 86_400_000) }));
    const removed: string[] = [];
    const db = {
      app: { findMany: async () => [] },
      backup: {
        findMany: async ({ where }: Row) => (where.kind === "control_plane" ? rows : []),
        update: async ({ where, data }: Row) => Object.assign(rows.find((r) => r.id === where.id)!, data),
        deleteMany: async () => ({ count: 0 }),
      },
    } as unknown as Db;
    const deps = { db, storeFor: async () => ({ store: { delete: async (k: string) => void removed.push(k) } }) } as never;
    expect(await applyRetention(deps, NOW)).toEqual({ expired: 1, deleted: 0 });
    expect(removed).toEqual(["k3"]);
    expect(rows[3]!.expiredAt).toBe(NOW);
  });
});

describe("stale backup rows", () => {
  it("settles a row as soon as its job is over, with the error its job recorded, not a generic line", async () => {
    const rows = [{ id: "b1", appId: APP, trigger: "manual", status: "running", error: null, createdAt: ago(2) }];
    const jobs = [{ kind: "backup", payload: { backupId: "b1" }, dedupeKey: `backup:${APP}`, failedAt: ago(1), completedAt: null, lastError: "EACCES: permission denied, mkdir '/var/lib/dockify/work/tmp'", createdAt: ago(2) }];
    expect(await failStaleRuns(fakeDb(rows, jobs), NOW)).toBe(1);
    expect(rows[0]).toMatchObject({ status: "failed", error: "EACCES: permission denied, mkdir '/var/lib/dockify/work/tmp'", finishedAt: NOW });
  });

  it("keeps the reason an earlier attempt wrote on the row over the job's exhausted note", async () => {
    const rows = [{ id: "b1", appId: APP, trigger: "schedule", status: "running", error: "pg_dump exited with code 1: connection refused", createdAt: ago(30) }];
    const jobs = [{ kind: "backup", payload: { backupId: "b1" }, failedAt: ago(1), lastError: "The worker stopped before this job finished, on every attempt", createdAt: ago(30) }];
    await failStaleRuns(fakeDb(rows, jobs), NOW);
    expect(rows[0]!.error).toBe("pg_dump exited with code 1: connection refused");
  });

  it("leaves the dump a version change took while that job is open, however long it runs", async () => {
    const rows = [{ id: "b1", appId: APP, trigger: "pre_update", status: "running", error: null, createdAt: ago(45) }];
    const jobs = [{ kind: "service_upgrade", dedupeKey: `service-upgrade:${APP}`, payload: { action: "in_place" }, failedAt: null, completedAt: null, createdAt: ago(46) }];
    expect(await failStaleRuns(fakeDb(rows, jobs), NOW)).toBe(0);
    expect(rows[0]!.status).toBe("running");
  });

  it("leaves a row whose job is still open, and a pre-restore dump while its restore runs", async () => {
    const rows = [
      { id: "b1", appId: APP, trigger: "manual", status: "running", error: null, createdAt: ago(60) },
      { id: "pre", appId: APP, trigger: "pre_restore", status: "running", error: null, createdAt: ago(60) },
    ];
    const jobs = [
      { kind: "backup", payload: { backupId: "b1" }, completedAt: null, failedAt: null, createdAt: ago(60) },
      { kind: "restore", dedupeKey: `restore:${APP}`, completedAt: null, failedAt: null, createdAt: ago(60) },
    ];
    expect(await failStaleRuns(fakeDb(rows, jobs), NOW)).toBe(0);
    expect(rows.map((r) => r.status)).toEqual(["running", "running"]);
  });

  it("gives a pre-restore dump the reason its restore failed with", async () => {
    const rows = [{ id: "pre", appId: APP, trigger: "pre_restore", status: "running", error: null, createdAt: ago(5) }];
    const jobs = [{ kind: "restore", dedupeKey: `restore:${APP}`, failedAt: ago(1), lastError: "The backup failed verification: tampered", createdAt: ago(5) }];
    await failStaleRuns(fakeDb(rows, jobs), NOW);
    expect(rows[0]).toMatchObject({ status: "failed", error: "The backup failed verification: tampered" });
  });

  it("settles a row with no job at all only once it is old, with the plain reason", async () => {
    const young = [{ id: "b1", appId: APP, trigger: "manual", status: "running", error: null, createdAt: ago(2) }];
    expect(await failStaleRuns(fakeDb(young, []), NOW)).toBe(0);
    const old = [{ id: "b1", appId: APP, trigger: "manual", status: "running", error: null, createdAt: ago(11) }];
    expect(await failStaleRuns(fakeDb(old, []), NOW)).toBe(1);
    expect(old[0]!.error).toBe(STALE_RUN_ERROR);
  });

  it("staleReason prefers the row's own error, then the job's, then the plain line", () => {
    expect(staleReason("row error", "job error")).toBe("row error");
    expect(staleReason(null, "job error")).toBe("job error");
    expect(staleReason("  ", undefined)).toBe(STALE_RUN_ERROR);
  });
});

describe("stale restore tests", () => {
  it("fails a test whose job is over with that job's error, and leaves one still running", async () => {
    const rows = [
      { id: "b1", restoreTestStatus: "running" },
      { id: "b2", restoreTestStatus: "running" },
      { id: "b3", restoreTestStatus: "running" },
    ];
    const jobs = [
      { kind: "restore_test", dedupeKey: "restore-test:b1", failedAt: ago(1), lastError: "the service did not become ready in time", createdAt: ago(3) },
      { kind: "restore_test", dedupeKey: "restore-test:b2", completedAt: null, failedAt: null, createdAt: ago(1) },
    ];
    expect(await failStaleRestoreTests(fakeDb(rows, jobs), NOW)).toBe(2);
    expect(rows[0]).toMatchObject({ restoreTestStatus: "failed", restoreTestError: "the service did not become ready in time", restoreTestedAt: NOW });
    expect(rows[1]!.restoreTestStatus).toBe("running");
    expect(rows[2]).toMatchObject({ restoreTestStatus: "failed", restoreTestError: STALE_TEST_ERROR });
  });
});

describe("one-time upgrade of an older install's services", () => {
  const LEGACY = "0f0f0f0f-0000-4000-8000-0000000000a1";
  const MANAGED = "0f0f0f0f-0000-4000-8000-0000000000a2";
  const BUSY = "0f0f0f0f-0000-4000-8000-0000000000a3";
  const DONE = "0f0f0f0f-0000-4000-8000-0000000000a4";

  function setup() {
    const apps: Row[] = [LEGACY, MANAGED, BUSY, DONE].map((id) => ({ id, kind: "redis", desiredState: "running", status: "running" }));
    const deployments: Row[] = [
      { appId: BUSY, status: "building" },
      { appId: DONE, status: "failed", message: LEGACY_UPGRADE_MESSAGE },
    ];
    const jobs: Row[] = [];
    const roles: Record<string, string> = { [LEGACY]: "app", [MANAGED]: "service-redis", [BUSY]: "app", [DONE]: "app" };
    const tx = {
      $executeRaw: async () => 0,
      deployment: {
        findFirst: async ({ where }: Row) => deployments.find((d) => d.appId === where.appId && where.status.in.includes(d.status)) ?? null,
        create: async ({ data }: Row) => {
          const row = { id: `dep-${deployments.length}`, status: "queued", ...data };
          deployments.push(row);
          return row;
        },
      },
      job: {
        findFirst: async ({ where }: Row) => jobs.find((j) => j.dedupeKey === where.dedupeKey && !j.completedAt && !j.failedAt) ?? null,
        create: async ({ data }: Row) => (jobs.push(data), data),
      },
      app: { update: async ({ where, data }: Row) => Object.assign(apps.find((a) => a.id === where.id)!, data) },
    };
    const db = {
      app: {
        findMany: async ({ where }: Row) =>
          apps.filter((a) => where.kind.in.includes(a.kind) && a.desiredState === where.desiredState && !deployments.some((d) => d.appId === a.id && d.message === where.deployments.none.message)),
      },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    };
    const docker = {
      inspect: async (name: string) => {
        const id = name.replace(/^dk-/, "");
        return roles[id] ? { id: name, running: true, health: "none", labels: { "dockify.app": id, "dockify.role": roles[id] }, addresses: {} } : null;
      },
    } as unknown as DockerPort;
    return { deps: { db: db as unknown as Db, docker } as unknown as DataDeps, apps, deployments, jobs };
  }

  it("queues one managed deploy for a service still on a generic container, and no other", async () => {
    const s = setup();
    expect(await upgradeLegacyServices(s.deps, "s1")).toBe(1);
    const queued = s.deployments.filter((d) => d.message === LEGACY_UPGRADE_MESSAGE && d.appId === LEGACY);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ trigger: "redeploy", actorType: "system", actorName: "Dockify" });
    expect(s.jobs).toEqual([expect.objectContaining({ kind: "deploy", lane: "deploy", dedupeKey: `deploy:${LEGACY}` })]);
    expect(s.apps.find((a) => a.id === LEGACY)!.status).toBe("deploying");
    // Never twice: the marker deployment is there now, and a failed one is left for the owner.
    expect(await upgradeLegacyServices(s.deps, "s1")).toBe(0);
    expect(s.jobs).toHaveLength(1);
  });
});
