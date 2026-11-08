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
  if (where.payload?.array_contains && !where.payload.array_contains.every((id: string) => (j.payload?.copies ?? []).includes(id))) return false;
  if (where.payload && !where.payload.array_contains && j.payload?.backupId !== where.payload.equals) return false;
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
    const tier = { id: "t1", appId: APP, tier: "offsite", cron: "* * * * *", timezone: "UTC", lastRunAt: ago(5) as Date | null };
    const db = {
      backupSchedule: {
        findMany: async () => [{ ...tier }],
        updateMany: async ({ where, data }: Row) => {
          if (where.lastRunAt !== tier.lastRunAt) return { count: 0 };
          Object.assign(tier, data);
          return { count: 1 };
        },
      },
      $transaction: async () => { throw error; },
    };
    return { db: db as unknown as Db, tier };
  };

  it("gives the slot back and says so, so the next tick tries again", async () => {
    const was = ago(5);
    const { db, tier } = busyDb(Object.assign(new Error("A restore of this database is running"), { code: "BUSY" }));
    tier.lastRunAt = was;
    const logged: string[] = [];
    expect(await fireDueSchedules(db, NOW, (m) => void logged.push(m))).toBe(0);
    expect(tier.lastRunAt).toBe(was);
    expect(logged).toEqual(["a scheduled backup was not taken"]);
  });

  it("any other failure is logged and keeps the slot", async () => {
    const { db, tier } = busyDb(new Error("database gone"));
    const logged: string[] = [];
    expect(await fireDueSchedules(db, NOW, (m) => void logged.push(m))).toBe(0);
    expect(tier.lastRunAt).toBe(NOW);
    expect(logged).toHaveLength(1);
  });
});

describe("two tiers on their own crons", () => {
  /** Every 12 hours on this server, daily offsite: what the owner runs. */
  const setup = (localLast: Date, offsiteLast: Date) => {
    const tiers: Row[] = [
      { id: "tl", appId: APP, tier: "local", enabled: true, cron: "0 */12 * * *", timezone: "UTC", keep: 1, keepDays: null, destinationId: null, lastRunAt: localLast },
      { id: "to", appId: APP, tier: "offsite", enabled: true, cron: "0 3 * * *", timezone: "UTC", keep: 7, keepDays: null, destinationId: null, lastRunAt: offsiteLast },
    ];
    const backups: Row[] = [];
    const jobs: Row[] = [];
    const tx = {
      $executeRaw: async () => 0,
      app: { findUnique: async () => ({ id: APP, name: "db", kind: "postgres", environmentId: "e", serverId: "s", environment: { name: "production", project: { slug: "p" } } }) },
      job: {
        findFirst: async () => null,
        create: async ({ data }: Row) => {
          jobs.push(data);
          return { id: `j${jobs.length}` };
        },
      },
      backup: {
        findFirst: async () => null,
        create: async ({ data }: Row) => {
          backups.push(data);
          return { id: `b${backups.length}` };
        },
      },
      backupSchedule: { findMany: async () => tiers },
      backupDestination: {
        findFirst: async ({ where }: Row) => (where.type === "local" ? { id: "here", type: "local" } : { id: "b2", type: "s3" }),
        findUnique: async () => null,
      },
    };
    const db = {
      backupSchedule: {
        findMany: async () => tiers.map((t) => ({ ...t })),
        updateMany: async ({ where, data }: Row) => {
          const t = tiers.find((x) => x.id === where.id)!;
          if (t.lastRunAt?.getTime() !== where.lastRunAt?.getTime()) return { count: 0 };
          Object.assign(t, data);
          return { count: 1 };
        },
      },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as Db;
    return { db, tiers, backups, jobs };
  };

  it("fires only the tier that is due", async () => {
    // 12:00: the local tier (last at 00:00) is due, the offsite one (last at 03:00) is not.
    const f = setup(new Date("2026-11-06T00:00:00Z"), new Date("2026-11-06T03:00:00Z"));
    expect(await fireDueSchedules(f.db, NOW)).toBe(1);
    expect(f.backups.map((b) => b.destinationId)).toEqual(["here"]);
    expect(f.tiers.map((t) => t.lastRunAt)).toEqual([NOW, new Date("2026-11-06T03:00:00Z")]);
  });

  it("serves both tiers from one dump when both are due at once", async () => {
    const f = setup(new Date("2026-11-06T00:00:00Z"), new Date("2026-11-05T03:00:00Z"));
    expect(await fireDueSchedules(f.db, NOW)).toBe(1);
    expect(f.backups.map((b) => b.destinationId)).toEqual(["here", "b2"]);
    expect(f.jobs).toHaveLength(1);
    expect(f.jobs[0]!.payload).toEqual({ backupId: "b1", copies: ["b2"] });
  });
});

describe("retention by count, per tier", () => {
  const LOCAL = { type: "local" };
  const S3 = { type: "s3" };
  const bk = (id: string, hoursAgo: number, dest: { type: string } | null, over: Row = {}): Row => ({
    id, appId: APP, status: "ready", trigger: "schedule", objectKey: `k/${id}`, expiredAt: null, restoreTestStatus: "not_tested",
    destinationId: dest ? (dest.type === "s3" ? "b2" : "here") : null, destination: dest, createdAt: new Date(NOW.getTime() - hoursAgo * 3_600_000), ...over,
  });
  const run = async (rows: Row[], schedules: Row[], open: Row[] = []) => {
    const removed: Array<[string | null, string]> = [];
    const db = {
      app: { findMany: async () => [{ id: APP, backupSchedules: schedules }] },
      job: { findMany: async () => open },
      backup: {
        findMany: async ({ where }: Row) => (where.appId === APP ? rows : []),
        update: async ({ where, data }: Row) => Object.assign(rows.find((r) => r.id === where.id)!, data),
        deleteMany: async () => ({ count: 0 }),
      },
    } as unknown as Db;
    const deps = { db, storeFor: async (id: string | null) => ({ store: { delete: async (k: string) => void removed.push([id, k]) } }) } as never;
    const out = await applyRetention(deps, NOW);
    return { out, removed, expired: rows.filter((r) => r.expiredAt).map((r) => r.id) };
  };
  const tiers = [
    { tier: "local", enabled: true, cron: "0 */12 * * *", timezone: "UTC", keep: 1, keepDays: null, destinationId: null, lastRunAt: null },
    { tier: "offsite", enabled: true, cron: "0 3 * * *", timezone: "UTC", keep: 7, keepDays: null, destinationId: null, lastRunAt: null },
  ];

  it("keeps the latest 1 on this server and the latest 7 offsite, each counted apart", async () => {
    const rows = [bk("l1", 1, LOCAL), bk("l2", 13, LOCAL), bk("l3", 25, LOCAL), ...Array.from({ length: 9 }, (_, i) => bk(`o${i + 1}`, 2 + i * 24, S3))];
    const r = await run(rows, tiers);
    expect(r.expired.sort()).toEqual(["l2", "l3", "o8", "o9"]);
  });

  it("deletes the offsite object from its bucket, and the local file from this server", async () => {
    const r = await run([bk("o1", 1, S3), bk("o2", 30, S3), bk("l1", 1, LOCAL), bk("l2", 13, LOCAL)], [tiers[0]!, { ...tiers[1]!, keep: 1 }]);
    expect(r.removed).toEqual([["here", "k/l2"], ["b2", "k/o2"]]);
  });

  it("never counts a failed run: the one good backup stays", async () => {
    const r = await run([bk("f1", 1, LOCAL, { status: "failed", objectKey: null }), bk("f2", 2, LOCAL, { status: "failed", objectKey: null }), bk("good", 13, LOCAL)], tiers);
    expect(r.expired).toEqual([]);
  });

  it("never removes a backup a restore is reading", async () => {
    const r = await run([bk("l1", 1, LOCAL), bk("l2", 13, LOCAL), bk("l3", 25, LOCAL)], tiers, [{ payload: { backupId: "l3", mode: "new" } }]);
    expect(r.expired).toEqual(["l2"]);
  });

  it("a tier with no row keeps the default count", async () => {
    const r = await run(Array.from({ length: 9 }, (_, i) => bk(`l${i + 1}`, 1 + i, LOCAL)), []);
    expect(r.expired.sort()).toEqual(["l8", "l9"]);
  });
});

describe("retention of the offsite copies of pre-update dumps", () => {
  it("expires them like any other backup, keeping the newest three", async () => {
    const rows: Row[] = [0, 1, 2, 3].map((i) => ({ id: `d${i}`, kind: "control_plane", status: "ready", trigger: "pre_update", objectKey: `k${i}`, expiredAt: null, destinationId: null, createdAt: new Date(NOW.getTime() - (40 + i) * 86_400_000) }));
    const removed: string[] = [];
    const db = {
      job: { findMany: async () => [] },
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

  it("leaves the second tier's copy while the one run writing both is open, and settles it with that run", async () => {
    const rows = [{ id: "copy", appId: APP, trigger: "schedule", status: "running", error: null, createdAt: ago(60) }];
    const open = [{ kind: "backup", payload: { backupId: "first", copies: ["copy"] }, completedAt: null, failedAt: null, createdAt: ago(60) }];
    expect(await failStaleRuns(fakeDb(rows, open), NOW)).toBe(0);
    const over = [{ ...open[0]!, failedAt: ago(1), lastError: "pg_dump exited with code 1: out of memory" }];
    expect(await failStaleRuns(fakeDb(rows, over), NOW)).toBe(1);
    expect(rows[0]).toMatchObject({ status: "failed", error: "pg_dump exited with code 1: out of memory" });
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
