import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { apps as Ap, backups as B } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import type { Actor } from "../../actor.ts";
import type { Ctx, Handler } from "../../app.ts";
import { testConfig, testRing } from "../../test-helpers.ts";
import { createDataHandlers, type DataChannel } from "../data/index.ts";
import { createBackupsHandlers, defaultBackupsOptions } from "./index.ts";
import { toRun, toSchedule, type BackupRowIn, type DestinationRow, type ScheduleAppIn, type ScheduleContext } from "./map.ts";
import type { TierRow } from "./shared.ts";

const run = toRun;

const APP = "0f0f0f0f-0000-4000-8000-000000000001";
const BK = "0f0f0f0f-0000-4000-8000-0000000000b1";

const s3: DestinationRow = { id: "d1", name: "R2", type: "s3", isDefault: true, integration: { name: "r2", config: { provider: "r2", bucket: "dk" }, lastCheckedAt: null, error: null } };

const row = (over: Partial<BackupRowIn> = {}): BackupRowIn => ({
  id: BK, appId: APP, sourceAppId: APP, appSnapshot: { name: "db", projectSlug: "acme", environment: "prod" }, trigger: "schedule", status: "ready",
  createdAt: new Date("2026-10-30T03:00:00Z"), finishedAt: new Date("2026-10-30T03:01:00Z"), sizeBytes: 1234n, encrypted: true, keyFingerprint: "abcd",
  error: null, restoreTestStatus: "not_tested", restoreTestedAt: null, restoreTestTables: null, restoreTestRows: null, restoreTestError: null, expiredAt: null,
  destination: s3, ...over,
});

const tierRow = (tier: "local" | "offsite", over: Partial<TierRow> = {}): TierRow => ({
  tier, enabled: true, cron: "0 3 * * *", timezone: "UTC", keep: 7, keepDays: null, destinationId: null, lastRunAt: null, ...over,
});
const scheduleApp = (tiers: TierRow[] = [tierRow("offsite", { keep: 3, keepDays: 14 })]): ScheduleAppIn => ({
  id: APP, name: "db", createdAt: new Date("2026-10-01T00:00:00Z"), environment: { name: "prod", project: { slug: "acme" } }, backupSchedules: tiers,
});
const sctx = (over: Partial<ScheduleContext> = {}): ScheduleContext => ({ fingerprint: "abcd", s3: [s3], defaultType: "s3", localAllowed: true, ...over });

describe("contract shapes", () => {
  it("a run matches the BackupRun contract", () => {
    const r = toRun(row());
    expect(B.BackupRun.parse(r)).toEqual(r);
    expect(r).toMatchObject({ kind: "scheduled", destination: "s3", storage: { provider: "r2", bucket: "dk" }, encryption: { enabled: true, fingerprint: "abcd" }, restoreTest: { status: "notTested" }, sizeBytes: 1234 });
  });
  it("maps every trigger and test status", () => {
    expect(toRun(row({ trigger: "pre_deploy" })).kind).toBe("preDeploy");
    expect(toRun(row({ trigger: "pre_update" })).kind).toBe("preUpdate");
    expect(toRun(row({ restoreTestStatus: "passed", restoreTestRows: 5n, restoreTestTables: 2 })).restoreTest).toMatchObject({ status: "passed", rows: 5, tables: 2 });
  });
  it("an orphan outlives its app and says so", () => {
    const r = toRun(row({ appId: null, appSnapshot: { name: "db", projectSlug: "acme", environment: "prod", deletedAt: "2026-10-29T00:00:00.000Z" } }));
    expect(r.database.deletedAt).toBe("2026-10-29T00:00:00.000Z");
    expect(toRun(row({ appId: null })).database.deletedAt).toBe("2026-10-30T03:01:00.000Z");
    expect(toRun(row()).database.deletedAt).toBeNull();
  });
  it("local backups have no storage ref, and carry the same-disk warning", () => {
    const r = toRun(row({ destination: { id: "l", name: "This server", type: "local", isDefault: false, integration: null } }));
    expect(r.destination).toBe("local");
    expect(r.storage).toBeNull();
    expect(r.warning).toMatch(/not off the server/);
    expect(B.BackupRun.parse(r)).toEqual(r);
    // A run with no destination row went to the default, this server's disk.
    expect(toRun(row({ destination: null })).warning).toMatch(/not off the server/);
    expect(toRun(row()).warning).toBeUndefined();
  });
  it("a schedule matches the contract and computes the next run", () => {
    const s = toSchedule(scheduleApp(), sctx(), new Date("2026-10-30T01:00:00Z"));
    expect(B.BackupSchedule.parse(s)).toEqual(s);
    expect(s.nextRunAt).toBe("2026-10-30T03:00:00.000Z");
    expect(s.storage?.id).toBe("d1");
    expect(toSchedule(scheduleApp([tierRow("offsite", { enabled: false })]), sctx()).nextRunAt).toBeNull();
    expect(run(row()).tier).toBe("offsite");
  });

  it("shows both tiers, each with its own cron, count, next run and destination", () => {
    const now = new Date("2026-11-06T13:00:00Z");
    const s = toSchedule(scheduleApp([tierRow("local", { cron: "0 */12 * * *", keep: 1 }), tierRow("offsite", { keep: 7 })]), sctx(), now);
    expect(B.BackupSchedule.parse(s)).toEqual(s);
    expect(s.tiers.local).toMatchObject({ tier: "local", enabled: true, cron: "0 */12 * * *", keep: 1, keepDays: null, destination: "local", storage: null, available: true, nextRunAt: "2026-11-07T00:00:00.000Z" });
    expect(s.tiers.local.warning).toMatch(/not off the server/);
    expect(s.tiers.offsite).toMatchObject({ tier: "offsite", keep: 7, destination: "s3", storage: { id: "d1", bucket: "dk" }, available: true, nextRunAt: "2026-11-07T03:00:00.000Z" });
    // The flat fields an older client reads: offsite, on, the soonest next run of the two.
    expect(s).toMatchObject({ destination: "s3", cron: "0 3 * * *", enabled: true, nextRunAt: "2026-11-07T00:00:00.000Z", retentionDays: 7 });
  });

  it("a tier with no row is off with the defaults, and offsite without storage cannot run", () => {
    const s = toSchedule(scheduleApp([]), sctx({ s3: [], defaultType: null }));
    expect(s.tiers.local).toMatchObject({ enabled: false, keep: 7, keepDays: null, available: true, nextRunAt: null });
    expect(s.tiers.offsite).toMatchObject({ enabled: false, storage: null, available: false });
    expect(s).toMatchObject({ enabled: false, destination: "local" });
  });

  it("an old schedule reads as it did: keep 3 plus its days, in days for older clients", () => {
    const s = toSchedule(scheduleApp([tierRow("local", { enabled: false, cron: null, keep: 3, keepDays: 14 }), tierRow("offsite", { keep: 3, keepDays: 14 })]), sctx());
    expect(s).toMatchObject({ retentionDays: 14, destination: "s3", enabled: true });
    expect(s.tiers.offsite).toMatchObject({ keep: 3, keepDays: 14 });
  });
});

// ------------------------------------------------------------------------------- handlers

type AnyRow = Record<string, any>;
function ctxWith(db: AnyRow): Ctx {
  return { db: db as unknown as Db, ring: testRing(), config: testConfig(), web: { origin: "https://dockify.test", secure: true }, limits: {} as never };
}
const session: Actor = { kind: "session", userId: "u1", name: "Owner", role: "admin", sessionId: "s1", elevated: true };
const req = { clientIp: "203.0.113.9", headers: { "user-agent": "vitest" } };
async function call(h: unknown, input: AnyRow): Promise<any> {
  return (h as Handler<never>)({ body: undefined as never, query: undefined as never, params: undefined as never, actor: session, req: req as never, reply: {} as never, ctx: input.ctx, ...input } as never);
}

const serviceApp = { id: APP, name: "db", kind: "postgres", createdAt: new Date("2026-10-01T00:00:00Z"), backupSchedules: [] as AnyRow[], environment: { projectId: "p1", name: "prod", project: { slug: "acme" } } };

describe("backup handlers", () => {
  const audits: AnyRow[] = [];
  /** The schedule rows of the one app, as the patch handler writes them. */
  let tiers: AnyRow[] = [];
  let dests: AnyRow[] = [];
  const baseDb = (over: AnyRow = {}): AnyRow => ({
    activityLog: { create: async ({ data }: AnyRow) => audits.push(data) },
    app: {
      findUnique: async () => ({ ...serviceApp, backupSchedules: tiers.map((t) => ({ ...t })) }),
      findUniqueOrThrow: async () => ({ ...serviceApp, backupSchedules: tiers.map((t) => ({ ...t })) }),
      ...over.app,
    },
    backup: { findUnique: async () => ({ ...row(), objectKey: "k", kind: "postgres", app: { environment: { projectId: "p1" } } }), ...over.backup },
    backupSchedule: {
      findMany: async () => tiers.map((t) => ({ ...t })),
      upsert: async ({ where, update, create }: AnyRow) => {
        const hit = tiers.find((t) => t.tier === where.appId_tier.tier);
        if (hit) Object.assign(hit, update);
        else tiers.push({ enabled: false, cron: null, timezone: "UTC", keep: 7, keepDays: null, destinationId: null, lastRunAt: null, ...create });
        return {};
      },
    },
    backupDestination: {
      findMany: async ({ where }: AnyRow) => dests.filter((d) => d.type === where.type),
      findFirst: async ({ where }: AnyRow) => dests.find((d) => (where.isDefault === undefined || d.isDefault === where.isDefault) && (where.type === undefined || d.type === where.type)) ?? null,
      findUnique: async ({ where }: AnyRow) => dests.find((d) => d.id === where.id) ?? null,
      upsert: async () => ({ id: "local" }),
      ...over.backupDestination,
    },
    job: over.job ?? {},
    instance: { findUnique: async () => null },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(baseDb(over)),
    $executeRaw: async () => 0,
    ...over.root,
  });
  const h = createBackupsHandlers({ ...defaultBackupsOptions({}), restoreWaitMs: 50, pollMs: 5 });
  const patch = (body: AnyRow, handlers = h) => call(handlers["backups.schedules.patch"], { ctx: ctxWith(baseDb()), params: { id: APP }, body });
  const B2 = { id: "d1", name: "Backblaze B2", type: "s3", isDefault: true, createdAt: new Date(), integration: { name: "b2", config: { provider: "custom", bucket: "dk" }, lastCheckedAt: null, error: null } };
  const reset = (t: AnyRow[] = [], d: AnyRow[] = []) => {
    tiers = t;
    dests = d;
    audits.length = 0;
  };

  it("sets up the owner's two tiers: every 12 hours here keeping 1, daily offsite keeping 7", async () => {
    reset([], [B2]);
    await patch({ tier: "local", enabled: true, cron: "0 */12 * * *", keep: 1 });
    const s = await patch({ tier: "offsite", enabled: true, cron: "0 3 * * *", keep: 7, destination: "d1" });
    expect(B.BackupSchedule.parse(s)).toEqual(s);
    expect(s.tiers.local).toMatchObject({ enabled: true, cron: "0 */12 * * *", keep: 1, keepDays: null, destination: "local" });
    expect(s.tiers.offsite).toMatchObject({ enabled: true, cron: "0 3 * * *", keep: 7, storage: { id: "d1", name: "Backblaze B2" } });
    expect(tiers.find((t) => t.tier === "offsite")!.destinationId).toBe("d1");
    expect(tiers.find((t) => t.tier === "local")!.destinationId).toBeNull();
  });

  it("lets a schedule use this server's disk by default, the same rule as a manual run, and says it is not off the server", async () => {
    reset();
    const s = await patch({ destination: "local" });
    expect(s).toMatchObject({ destination: "local", storage: null });
    expect(s.warning).toMatch(/this server's own disk, not off the server/);
    expect(B.BackupSchedule.parse(s)).toEqual(s);
  });

  it("an older client that points its one schedule elsewhere moves it, cron, switch and retention", async () => {
    reset([{ tier: "local", enabled: true, cron: "0 4 * * *", timezone: "UTC", keep: 3, keepDays: 14, destinationId: null, lastRunAt: null }], [B2]);
    const s = await patch({ destination: "s3" });
    expect(s.tiers.offsite).toMatchObject({ enabled: true, cron: "0 4 * * *", keep: 3, keepDays: 14 });
    expect(s.tiers.local).toMatchObject({ enabled: false });
    expect(s).toMatchObject({ destination: "s3", enabled: true, cron: "0 4 * * *" });
  });

  it("an older client's change without a destination goes to the tier it reads", async () => {
    reset([{ tier: "offsite", enabled: true, cron: "0 3 * * *", timezone: "UTC", keep: 3, keepDays: 14, destinationId: null, lastRunAt: null }], [B2]);
    const s = await patch({ cron: "0 5 * * *", retentionDays: 30 });
    expect(s.tiers.offsite).toMatchObject({ cron: "0 5 * * *", keep: 3, keepDays: 30 });
    expect(s.tiers.local.enabled).toBe(false);
  });

  it("refuses offsite with no S3 storage, and a destination that is not the tier's kind", async () => {
    reset();
    await expect(patch({ tier: "offsite", enabled: true })).rejects.toMatchObject({ status: 409, code: "NO_DESTINATION" });
    reset([], [B2]);
    await expect(patch({ tier: "local", destination: "d1" })).rejects.toMatchObject({ status: 400, code: "WRONG_DESTINATION" });
  });

  it("refuses local backups only when the owner turned them off", async () => {
    reset();
    const off = createBackupsHandlers({ ...defaultBackupsOptions({ DOCKIFY_ALLOW_LOCAL_BACKUPS: "0" }), restoreWaitMs: 50, pollMs: 5 });
    await expect(patch({ destination: "local" }, off)).rejects.toMatchObject({ status: 409, code: "LOCAL_DISABLED" });
    await expect(patch({ tier: "local", enabled: true }, off)).rejects.toMatchObject({ status: 409, code: "LOCAL_DISABLED" });
  });

  it("refuses an invalid cron with a field error", async () => {
    reset();
    await expect(patch({ cron: "99 * * * *" })).rejects.toMatchObject({ status: 400, code: "INVALID_CRON" });
  });

  it("audits a retention decrease as such", async () => {
    reset([{ tier: "offsite", enabled: true, cron: "0 3 * * *", timezone: "UTC", keep: 7, keepDays: null, destinationId: null, lastRunAt: null }], [B2]);
    await patch({ tier: "offsite", keep: 1 });
    expect(audits[0]).toMatchObject({ action: "backup.schedule.update", verb: "reduced backup retention for", suffix: "offsite tier" });
    expect(audits[0]!.changes).toEqual([{ key: "keep", before: 7, after: 1 }]);
  });

  it("Back up now writes one dump to every tier that is on, or to the tier asked for", async () => {
    const created: AnyRow[] = [];
    const queued: AnyRow[] = [];
    const db = (t: AnyRow[]) => {
      tiers = t;
      dests = [B2, { id: "here", name: "This server", type: "local", isDefault: false, createdAt: new Date() }];
      const d = baseDb({
        app: { findUnique: async () => ({ ...serviceApp, serverId: "s1", environmentId: "e1", environment: { ...serviceApp.environment, project: { slug: "acme" } }, backupSchedules: tiers }) },
        backup: { findFirst: async () => null, create: async ({ data }: AnyRow) => (created.push(data), { id: `b${created.length}` }), findMany: async () => [] },
        job: { findFirst: async () => null, create: async ({ data }: AnyRow) => (queued.push(data), { id: "j" }) },
      });
      return ctxWith({ ...d, $transaction: async (fn: (tx: unknown) => unknown) => fn(d) });
    };
    const on = { timezone: "UTC", keep: 7, keepDays: null, destinationId: null, lastRunAt: null, cron: "0 3 * * *", enabled: true };
    await call(h["backups.run"], { ctx: db([{ ...on, tier: "local" }, { ...on, tier: "offsite" }]), body: { resourceId: APP } });
    expect(created.map((c) => c.destinationId)).toEqual(["here", "d1"]);
    expect(queued[0]).toMatchObject({ kind: "backup", payload: { backupId: "b1", copies: ["b2"] } });
    created.length = 0;
    await call(h["backups.run"], { ctx: db([{ ...on, tier: "local" }, { ...on, tier: "offsite" }]), body: { resourceId: APP, tier: "local" } });
    expect(created.map((c) => c.destinationId)).toEqual(["here"]);
  });

  it("replace needs the project and name typed exactly, as the dialog asks", async () => {
    for (const confirm of ["DB", "db", "acme/DB"]) {
      await expect(call(h["backups.restore"], { ctx: ctxWith(baseDb()), params: { id: BK }, body: { mode: "replace", confirm } })).rejects.toMatchObject({ status: 400, code: "CONFIRM_MISMATCH", message: "Type acme/db to confirm replacing its data" });
    }
  });

  it("what the dashboard's restore dialog asks for is what this accepts", async () => {
    // The dialog's own definition, read from its source: the api's build does not reach into the web.
    const util = await readFile(new URL("../../../../web/components/server-backups/util.ts", import.meta.url), "utf8");
    expect(util).toContain("export const dbRef = (db: BackupDatabase) => `${db.projectSlug}/${db.name}`;");
    const asked = `${serviceApp.environment.project.slug}/${serviceApp.name}`;
    // Past the confirm, the fake has nothing to run: anything but a mismatch means it passed.
    const out = await call(h["backups.restore"], { ctx: ctxWith(baseDb()), params: { id: BK }, body: { mode: "replace", confirm: asked } }).then(() => null, (e: { code?: string }) => e);
    expect(out?.code).not.toBe("CONFIRM_MISMATCH");
  });

  it("replace is refused for an orphan; restore into new is the way", async () => {
    const db = baseDb({ backup: { findUnique: async () => ({ ...row({ appId: null }), objectKey: "k", kind: "postgres", app: null }) } });
    await expect(call(h["backups.restore"], { ctx: ctxWith(db), params: { id: BK }, body: { mode: "replace", confirm: "db" } })).rejects.toMatchObject({ code: "ORPHANED" });
  });

  it("refuses expired and unfinished backups", async () => {
    const expired = baseDb({ backup: { findUnique: async () => ({ ...row({ expiredAt: new Date() }), objectKey: "k", app: null }) } });
    await expect(call(h["backups.test"], { ctx: ctxWith(expired), params: { id: BK } })).rejects.toMatchObject({ code: "EXPIRED" });
    const running = baseDb({ backup: { findUnique: async () => ({ ...row({ status: "running" }), objectKey: null, app: null }) } });
    await expect(call(h["backups.download"], { ctx: ctxWith(running), params: { id: BK } })).rejects.toMatchObject({ code: "NOT_READY" });
  });

  it("orphan delete refuses while the app exists", async () => {
    await expect(call(h["backups.orphans.delete"], { ctx: ctxWith(baseDb()), params: { resourceId: APP } })).rejects.toMatchObject({ status: 409, code: "NOT_ORPHANED" });
  });

  describe("orphan delete goes through the worker, which alone can write the volume", () => {
    const orphanDb = (job: AnyRow, over: AnyRow = {}) => {
      const queued: AnyRow[] = [];
      const db = baseDb({
        app: { findUnique: async () => null },
        backup: { count: async () => 2 },
        job: { findFirst: async () => null, create: async ({ data }: AnyRow) => (queued.push(data), { id: "j1" }), findUnique: async () => job },
        root: { $transaction: async (fn: (tx: unknown) => unknown) => fn(db), $executeRaw: async () => 0, instance: { findUnique: async () => ({ workerSeenAt: over.seenAt ?? new Date() }) } },
      });
      return { db, queued };
    };

    it("names only the app in the job, and answers what the worker really removed", async () => {
      const { db, queued } = orphanDb({ completedAt: new Date(), failedAt: null, lastError: null, payload: { sourceAppId: APP, result: { deleted: 2, freedBytes: 700, failed: 0 } } });
      const out = await call(h["backups.orphans.delete"], { ctx: ctxWith(db), params: { resourceId: APP } });
      expect(B.OrphanDeleteResult.parse(out)).toEqual({ deleted: 2, freedBytes: 700 });
      expect(queued[0]).toMatchObject({ kind: "backup_delete", lane: "maintenance", payload: { sourceAppId: APP }, maxAttempts: 1 });
    });

    it("says so when no file could be deleted, and when the worker failed or is down", async () => {
      const none = orphanDb({ completedAt: new Date(), failedAt: null, lastError: null, payload: { result: { deleted: 0, freedBytes: 0, failed: 2 } } });
      await expect(call(h["backups.orphans.delete"], { ctx: ctxWith(none.db), params: { resourceId: APP } })).rejects.toMatchObject({ status: 502, code: "DELETE_FAILED" });
      const failed = orphanDb({ completedAt: null, failedAt: new Date(), lastError: "disk error", payload: {} });
      await expect(call(h["backups.orphans.delete"], { ctx: ctxWith(failed.db), params: { resourceId: APP } })).rejects.toMatchObject({ status: 502, message: expect.stringContaining("disk error") });
      const down = orphanDb({}, { seenAt: new Date(Date.now() - 600_000) });
      await expect(call(h["backups.orphans.delete"], { ctx: ctxWith(down.db), params: { resourceId: APP } })).rejects.toMatchObject({ status: 503, code: "WORKER_DOWN" });
      expect(down.queued).toEqual([]);
    });

    it("answers 504 while the worker is still at it", async () => {
      const slow = orphanDb({ completedAt: null, failedAt: null, lastError: null, payload: {} });
      await expect(call(h["backups.orphans.delete"], { ctx: ctxWith(slow.db), params: { resourceId: APP } })).rejects.toMatchObject({ status: 504, code: "DELETE_PENDING" });
    });
  });

  it("a failed restore job answers 422 with the reason", async () => {
    const db = baseDb({
      job: { findFirst: async () => null, create: async () => ({ id: "j1" }), findUnique: async () => ({ completedAt: null, failedAt: new Date(), lastError: "psql exited with code 3" }) },
      root: { $transaction: async (fn: (tx: unknown) => unknown) => fn(db) },
    });
    await expect(call(h["backups.restore"], { ctx: ctxWith(db), params: { id: BK }, body: { mode: "replace", confirm: "acme/db" } })).rejects.toMatchObject({ status: 422, message: "psql exited with code 3" });
  });

  it("a slow restore answers 202 with the job instead of hanging", async () => {
    const db = baseDb({
      job: { findFirst: async () => null, create: async () => ({ id: "j1" }), findUnique: async () => ({ completedAt: null, failedAt: null, lastError: null }) },
      root: { $transaction: async (fn: (tx: unknown) => unknown) => fn(db) },
    });
    let code = 0;
    const reply = { code: (c: number) => { code = c; return reply; } };
    const out = await call(h["backups.restore"], { ctx: ctxWith(db), params: { id: BK }, body: { mode: "replace", confirm: "acme/db" }, reply });
    expect(code).toBe(202);
    expect(B.RestoreAccepted.parse(out)).toEqual({ jobId: "j1", resourceId: APP, status: "queued" });
  });

  describe("following a restore that outlasted its request", () => {
    const J = "0f0e0d0c-0000-4000-8000-00000000000f";
    const statusOf = async (row: AnyRow | null) => {
      let seen: AnyRow = {};
      const db = baseDb({ job: { findFirst: async ({ where }: AnyRow) => ((seen = where), row) } });
      const out = await call(h["backups.restoreStatus"], { ctx: ctxWith(db), params: { id: BK, jobId: J } });
      return { out, where: seen };
    };

    it("says running while the worker replaces the database", async () => {
      const { out, where } = await statusOf({ completedAt: null, failedAt: null, lastError: null, payload: {} });
      expect(out).toEqual({ status: "running", error: null });
      // A job of another backup, or not a restore at all, is not found through this id.
      expect(where).toMatchObject({ id: J, kind: "restore", payload: { path: ["backupId"], equals: BK } });
    });
    it("gives the worker's reason when it failed", async () => {
      expect((await statusOf({ completedAt: null, failedAt: new Date(), lastError: "psql exited with code 3", payload: {} })).out).toEqual({ status: "failed", error: "psql exited with code 3" });
    });
    it("gives the same outcome as a quick restore when it finished", async () => {
      const finished = new Date("2026-11-07T01:00:00Z");
      const { out } = await statusOf({ completedAt: finished, failedAt: null, lastError: null, payload: { targetAppId: APP } });
      expect(B.RestoreStatus.parse(out)).toMatchObject({ ok: true, finishedAt: finished.toISOString(), database: { resourceId: APP } });
    });
    it("answers 404 for a job that is not there", async () => {
      await expect(statusOf(null)).rejects.toMatchObject({ status: 404 });
    });
  });

  it("a project limited token cannot reach another project's backup", async () => {
    const token: Actor = { kind: "token", userId: "u", name: "ci", role: "admin", tokenId: "t", scope: "admin", allProjects: false, projectIds: ["other"], grants: [], elevated: false };
    await expect(call(h["backups.test"], { ctx: ctxWith(baseDb()), params: { id: BK }, actor: token })).rejects.toMatchObject({ status: 403 });
  });
});

describe("data browser handlers", () => {
  const pgApp = { id: APP, name: "db", kind: "postgres", environment: { projectId: "p1" } };
  const mk = (channel: DataChannel, audits: AnyRow[] = [], app: AnyRow = pgApp) =>
    ({ h: createDataHandlers(channel), ctx: ctxWith({ app: { findUnique: async () => app }, activityLog: { create: async ({ data }: AnyRow) => audits.push(data) } }) });

  it("relays to the worker and returns its answer", async () => {
    const answer = { database: "app", tables: [] };
    const { h, ctx } = mk({ call: async (op, body) => (expect(op).toBe("tables"), expect(body).toEqual({ appId: APP }), answer) });
    const out = await call(h["apps.data.tables"], { ctx, params: { id: APP } });
    expect(Ap.PgTables.parse(out)).toEqual(answer);
  });

  it("refuses the wrong kind before calling the worker", async () => {
    const { h, ctx } = mk({ call: async () => { throw new Error("must not be called"); } }, [], { ...pgApp, kind: "redis" });
    await expect(call(h["apps.data.query"], { ctx, params: { id: APP }, body: { sql: "select 1" } })).rejects.toMatchObject({ status: 400, code: "WRONG_KIND" });
  });

  it("audits every SQL run, failed ones included", async () => {
    const audits: AnyRow[] = [];
    const { h, ctx } = mk({ call: async () => { throw Object.assign(new Error("syntax error"), { status: 400 }); } }, audits);
    await expect(call(h["apps.data.query"], { ctx, params: { id: APP }, body: { sql: "selec 1" } })).rejects.toThrow(/syntax/);
    expect(audits[0]).toMatchObject({ action: "data.query", failed: true, suffix: "selec 1", ip: "203.0.113.9" });
  });

  it("says plainly when the worker channel is not configured", async () => {
    const { httpDataChannel } = await import("../data/index.ts");
    const { h, ctx } = mk(httpDataChannel(undefined));
    await expect(call(h["apps.data.tables"], { ctx, params: { id: APP } })).rejects.toMatchObject({ status: 503, code: "CHANNEL_UNAVAILABLE" });
  });
});
