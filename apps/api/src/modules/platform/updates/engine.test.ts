import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { LEASE_SECONDS, MAX_ATTEMPTS, processJob, schedulerTick, settleOrphans, settleSideEffects, startUpdateTx, beginApply, beginRollback, UpdateRefused, type Claimed } from "./engine.ts";
import type { Images, UpdateSteps } from "./runner.ts";
import { newJournal, rowOf, buildStatus } from "./state.ts";
import { testSigner } from "./test-sign.ts";
import { comment, feedBytes, release } from "./test-fixtures.ts";

const NEW: Images = { control: "r/control@sha256:" + "1".repeat(64), web: "r/web@sha256:" + "2".repeat(64) };
const OLD: Images = { control: "r/control@sha256:" + "3".repeat(64), web: "r/web@sha256:" + "4".repeat(64) };

// ------------------------------------------------------------------ a small in-memory Prisma

type Row = Record<string, unknown>;
const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(v);
      if ("gte" in c) return v instanceof Date && v >= (c.gte as Date);
      if ("gt" in c) return v instanceof Date && v > (c.gt as Date);
      if ("startsWith" in c) return typeof v === "string" && v.startsWith(c.startsWith as string);
      if ("not" in c) return v !== c.not;
      if ("path" in c) return (v as Row | null)?.[(c.path as string[])[0]!] === c.equals;
      return false;
    }
    return v === cond;
  });

function table(defaults: (data: Row) => Row = (d) => d) {
  const rows: Row[] = [];
  return {
    rows,
    findUnique: async ({ where }: { where: Row }) => rows.find((r) => match(r, where)) ?? null,
    findFirst: async ({ where }: { where?: Row } = {}) => rows.find((r) => match(r, where)) ?? null,
    findMany: async ({ where }: { where?: Row } = {}) => rows.filter((r) => match(r, where)).sort((a, b) => ((b.startedAt as Date)?.getTime?.() ?? 0) - ((a.startedAt as Date)?.getTime?.() ?? 0)),
    count: async ({ where }: { where?: Row } = {}) => rows.filter((r) => match(r, where)).length,
    create: async ({ data }: { data: Row }) => {
      const r = defaults({ id: crypto.randomUUID(), ...data });
      rows.push(r);
      return r;
    },
    createMany: async ({ data }: { data: Row[] }) => {
      for (const d of data) if (!rows.some((r) => r.id === d.id)) rows.push(d);
      return { count: data.length };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const r = rows.find((x) => match(x, where));
      if (!r) throw new Error("not found");
      Object.assign(r, data);
      return r;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((x) => match(x, where));
      for (const r of hit) {
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "decrement" in (v as Row)) r[k] = (r[k] as number) - ((v as Row).decrement as number);
          else r[k] = v;
        }
      }
      return { count: hit.length };
    },
    upsert: async ({ where, update, create }: { where: Row; update: Row; create: Row }) => {
      const r = rows.find((x) => match(x, where));
      if (r) return Object.assign(r, update);
      rows.push({ ...create });
      return create;
    },
  };
}

function fakeDb(instance: Row = {}) {
  const inst = table();
  inst.rows.push({
    id: 1, releaseVersion: "1.0.0", setupCompletedAt: new Date("2026-10-01T00:00:00Z"), latestRelease: null, updateCheckedAt: null,
    updateNextCheckAt: null, updateCheckError: null, updateFeedSeenAt: null, updateMode: "all", updateChannel: "stable",
    updateWindow: { days: [0, 1, 2, 3, 4, 5, 6], start: "03:00", end: "05:00" }, updateTimeZone: "Etc/UTC",
    updateSkipVersion: null, updatePausedUntil: null, updateNotifiedVersion: null, workerSeenAt: null, ...instance,
  });
  const db = {
    instance: inst,
    releaseUpdate: table((d) => ({ trigger: "manual", actorName: null, ...d })),
    job: table((d) => ({ completedAt: null, failedAt: null, lockedUntil: null, lockedBy: null, attempts: 0, ...d })),
    activityLog: table(),
    backup: table(),
    backupDestination: table(),
    server: { findFirst: async () => ({ id: "primary" }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    $executeRaw: async () => 0,
    $queryRaw: async () => [],
    $disconnect: async () => undefined,
  };
  return db;
}
const asDb = (d: ReturnType<typeof fakeDb>) => d as unknown as Db;

function okSteps(calls: string[], over: Partial<UpdateSteps> = {}): UpdateSteps {
  let pinned = OLD;
  return {
    preflight: async () => (calls.push("preflight"), { ok: true }),
    resolve: async () => (calls.push("resolve"), NEW),
    currentImages: async () => (calls.push("currentImages"), pinned),
    pull: async () => void calls.push("pull"),
    quiesce: async () => void calls.push("quiesce"),
    dump: async () => (calls.push("dump"), { id: "11111111-1111-4111-8111-111111111111", sha256: "d".repeat(64), bytes: 9000 }),
    migrate: async () => void calls.push("migrate"),
    pin: async (i) => void (pinned = i),
    swap: async (s) => void calls.push(`swap:${s}`),
    healthy: async () => (calls.push("healthy"), null),
    restoreDump: async (d) => void calls.push(`restore:${d.id}`),
    ...over,
  };
}

const jobOf = (db: ReturnType<typeof fakeDb>, updateId: string, attempts: number): Claimed => {
  const j = db.job.rows.find((r) => (r.payload as Row).updateId === updateId)!;
  j.attempts = attempts;
  j.lockedBy = "h";
  return { id: j.id as string, payload: j.payload, attempts, maxAttempts: j.maxAttempts as number };
};

describe("processJob: one leased job", () => {
  it("runs an update to done, settles the job, audits each step, and notifies", async () => {
    const db = fakeDb();
    const row = await startUpdateTx(asDb(db) as never, { kind: "update", trigger: "manual", actorName: "Ana", from: "1.0.0", version: "1.1.0", manifestSha256: "f".repeat(64) });
    const calls: string[] = [];
    const res = await processJob({ db: asDb(db), steps: okSteps(calls), holder: "h", afterSettle: (u, r) => settleSideEffects(asDb(db), u, r) }, jobOf(db, row.id, 1));
    expect(res.outcome).toBe("done");
    const job = db.job.rows.find((r) => r.kind === "self_update")!;
    expect(job.completedAt).toBeInstanceOf(Date);
    expect(db.instance.rows[0]!.releaseVersion).toBe("1.1.0");
    expect(db.activityLog.rows.map((a) => a.action)).toEqual(expect.arrayContaining(["update.preflight", "update.backup", "update.health", "update.finish"]));
    // The dump goes offsite once the stack is back, and Discord and email are queued.
    expect(db.backup.rows[0]).toMatchObject({ id: "11111111-1111-4111-8111-111111111111", kind: "control_plane", trigger: "pre_update" });
    expect(db.job.rows.map((r) => r.kind)).toEqual(expect.arrayContaining(["backup", "update_notify"]));
    expect(db.job.rows.find((r) => r.kind === "update_notify")!.payload).toMatchObject({ event: "updated", version: "1.1.0", from: "1.0.0" });
  });

  it("a busy server puts the job back without spending an attempt", async () => {
    const db = fakeDb();
    const row = await startUpdateTx(asDb(db) as never, { kind: "update", trigger: "auto", actorName: null, from: "1.0.0", version: "1.1.0", manifestSha256: "f".repeat(64) });
    const calls: string[] = [];
    const res = await processJob({ db: asDb(db), steps: okSteps(calls, { preflight: async () => ({ ok: false, wait: true, reason: "a deploy" }) }), holder: "h" }, jobOf(db, row.id, 1));
    expect(res.outcome).toBe("waiting");
    const job = db.job.rows.find((r) => r.kind === "self_update")!;
    expect(job).toMatchObject({ attempts: 0, lockedUntil: null, completedAt: null, failedAt: null });
    expect((job.runAfter as Date).getTime()).toBeGreaterThan(Date.now());
    expect(db.releaseUpdate.rows[0]!.state).toBe("waiting");
  });

  it("an idempotent retry after a crash: the takeover resumes the journal at the swap", async () => {
    const db = fakeDb();
    const row = await startUpdateTx(asDb(db) as never, { kind: "update", trigger: "manual", actorName: "Ana", from: "1.0.0", version: "1.1.0", manifestSha256: "f".repeat(64) });
    // What the first holder journaled before it died during the worker swap.
    const j = newJournal({ id: row.id, kind: "update", from: "1.0.0", version: "1.1.0", manifestSha256: "f".repeat(64), now: row.startedAt as Date });
    Object.assign(j, { phase: "swap_worker", fromImages: OLD, toImages: NEW, dumpBackupId: "11111111-1111-4111-8111-111111111111", dumpSha256: "d".repeat(64), dumpBytes: 9000, migrationStarted: true });
    for (const s of j.steps) s.status = ["preflight", "pull", "backup", "migrate", "swap_api"].includes(s.id) ? "done" : s.id === "swap_worker" ? "running" : "pending";
    Object.assign(db.releaseUpdate.rows[0]!, rowOf(j, { trigger: "manual", actorName: "Ana" }));

    const calls: string[] = [];
    const res = await processJob({ db: asDb(db), steps: okSteps(calls), holder: "h2" }, jobOf(db, row.id, 2));
    expect(res.outcome).toBe("done");
    expect(calls).toEqual(["swap:worker", "swap:web", "healthy"]);
    expect(db.releaseUpdate.rows[0]).toMatchObject({ state: "done", attempt: 2 });
  });

  it("past the attempt cap a takeover does not run blind: it rolls back with the dump", async () => {
    const db = fakeDb();
    const row = await startUpdateTx(asDb(db) as never, { kind: "update", trigger: "manual", actorName: "Ana", from: "1.0.0", version: "1.1.0", manifestSha256: "f".repeat(64) });
    Object.assign(db.releaseUpdate.rows[0]!, { phase: "migrate", migrationStarted: true, fromImages: OLD, toImages: NEW, dumpBackupId: "11111111-1111-4111-8111-111111111111", dumpSha256: "d".repeat(64) });
    const calls: string[] = [];
    const res = await processJob({ db: asDb(db), steps: okSteps(calls), holder: "h4" }, jobOf(db, row.id, MAX_ATTEMPTS + 1));
    expect(res.outcome).toBe("rolled_back");
    expect(res.error).toMatch(/stopped 3 times during migrate/);
    expect(calls).toContain("restore:11111111-1111-4111-8111-111111111111");
    expect(calls).not.toContain("migrate");
  });

  it("past the attempt cap with no dump it settles the row, so later updates are not blocked for good", async () => {
    const db = fakeDb();
    const row = await startUpdateTx(asDb(db) as never, { kind: "update", trigger: "manual", actorName: "Ana", from: "1.0.0", version: "1.1.0", manifestSha256: "f".repeat(64) });
    Object.assign(db.releaseUpdate.rows[0]!, { phase: "pull" });
    const calls: string[] = [];
    const settledRows: unknown[] = [];
    const res = await processJob({ db: asDb(db), steps: okSteps(calls), holder: "h4", afterSettle: async (u) => void settledRows.push(u) }, jobOf(db, row.id, MAX_ATTEMPTS + 1));
    expect(res).toMatchObject({ outcome: "failed", error: expect.stringMatching(/stopped 3 times during pull\. Nothing was changed/) });
    expect(db.releaseUpdate.rows[0]).toMatchObject({ state: "failed", phase: "pull" });
    expect(db.releaseUpdate.rows[0]!.finishedAt).toBeInstanceOf(Date);
    expect(db.job.rows.find((r) => r.kind === "self_update")!.failedAt).toBeInstanceOf(Date);
    expect(calls).toEqual([]);
    expect(settledRows).toHaveLength(1);
    await expect(startUpdateTx(asDb(db) as never, { kind: "update", trigger: "manual", actorName: "Ana", from: "1.0.0", version: "1.1.0", manifestSha256: "f".repeat(64) })).resolves.toBeTruthy();
  });

  it("past the attempt cap during the backup step, api and worker come back even with no dump", async () => {
    const db = fakeDb();
    const row = await startUpdateTx(asDb(db) as never, { kind: "update", trigger: "manual", actorName: "Ana", from: "1.0.0", version: "1.1.0", manifestSha256: "f".repeat(64) });
    Object.assign(db.releaseUpdate.rows[0]!, { phase: "backup", fromImages: OLD, toImages: NEW });
    const calls: string[] = [];
    const res = await processJob({ db: asDb(db), steps: okSteps(calls), holder: "h4" }, jobOf(db, row.id, MAX_ATTEMPTS + 1));
    expect(res.outcome).toBe("rolled_back");
    expect(calls).toEqual(["quiesce", "swap:api", "swap:worker", "swap:web", "healthy"]);
  });

  it("a restore keeps the job open and leased, and a crash during the swaps after it resumes (updates.mdx)", async () => {
    const db = fakeDb();
    const row = await startUpdateTx(asDb(db) as never, { kind: "update", trigger: "manual", actorName: "Ana", from: "1.0.0", version: "1.1.0", manifestSha256: "f".repeat(64) });
    Object.assign(db.releaseUpdate.rows[0]!, { phase: "rollback", migrationStarted: true, fromImages: OLD, toImages: NEW, dumpBackupId: "11111111-1111-4111-8111-111111111111", dumpSha256: "d".repeat(64), error: "migrate failed" });
    const claimed = jobOf(db, row.id, 2);
    let hung!: () => void;
    const reached = new Promise<void>((r) => (hung = r));
    // RESTORE_SCRIPT, on the fake: the dump's copy of the job is closed.
    const restoreDump = async () => {
      db.job.rows.find((r) => r.id === claimed.id)!.completedAt = new Date();
    };
    void processJob({ db: asDb(db), steps: okSteps([], { restoreDump, swap: () => (hung(), new Promise(() => undefined)) }), holder: "h2" }, claimed);
    await reached;
    const job = db.job.rows.find((r) => r.id === claimed.id)!;
    expect(job).toMatchObject({ completedAt: null, failedAt: null, lockedBy: "h2", attempts: 2 });
    expect((job.lockedUntil as Date).getTime()).toBeGreaterThan(Date.now());

    // The updater died there. The lease lapses, and the next holder finishes the same rollback.
    const calls: string[] = [];
    const res = await processJob({ db: asDb(db), steps: okSteps(calls), holder: "h3" }, { ...claimed, attempts: 3 });
    expect(res.outcome).toBe("rolled_back");
    expect(calls).toEqual(expect.arrayContaining(["swap:api", "swap:worker", "swap:web", "healthy"]));
    expect(db.releaseUpdate.rows[0]!.state).toBe("rolled_back");
    expect(job.failedAt).toBeInstanceOf(Date);
  });

  it("a rollback job newer than the dump comes back too", async () => {
    const db = fakeDb();
    const row = await startUpdateTx(asDb(db) as never, { kind: "rollback", trigger: "manual", actorName: "Ana", from: "1.1.0", version: "1.0.0", manifestSha256: null, toImages: OLD, rollbackOfId: null });
    Object.assign(db.releaseUpdate.rows[0]!, { phase: "rollback", migrationStarted: true, fromImages: NEW, dumpBackupId: "d", dumpSha256: "d".repeat(64), error: "x" });
    const claimed = jobOf(db, row.id, 1);
    let hung!: () => void;
    const reached = new Promise<void>((r) => (hung = r));
    const restoreDump = async () => void (db.job.rows.length = 0);
    void processJob({ db: asDb(db), steps: okSteps([], { restoreDump, swap: () => (hung(), new Promise(() => undefined)) }), holder: "h" }, claimed);
    await reached;
    expect(db.job.rows[0]).toMatchObject({ id: claimed.id, kind: "self_update", lane: "update", dedupeKey: "self_update", lockedBy: "h", completedAt: null, failedAt: null });
  });

  it("a finished rollback marks the version it left as skipped", async () => {
    const db = fakeDb({ releaseVersion: "1.1.0" });
    const row = await startUpdateTx(asDb(db) as never, { kind: "rollback", trigger: "manual", actorName: "Ana", from: "1.1.0", version: "1.0.0", manifestSha256: null, toImages: OLD, rollbackOfId: null });
    Object.assign(db.releaseUpdate.rows[0]!, { dumpBackupId: "d", dumpSha256: "d".repeat(64) });
    db.releaseUpdate.rows.push({ id: "u0", dumpBackupId: "d0", dumpSha256: "0".repeat(64), state: "done", kind: "update", version: "1.1.0", fromVersion: "1.0.0", startedAt: new Date(0), steps: [] });
    db.releaseUpdate.rows[0]!.rollbackOfId = "u0";
    const res = await processJob({ db: asDb(db), steps: okSteps([]), holder: "h" }, jobOf(db, row.id, 1));
    expect(res.outcome).toBe("done");
    expect(db.instance.rows[0]).toMatchObject({ releaseVersion: "1.0.0", updateSkipVersion: "1.1.0" });
  });

  it("refuses a second update while one is live", async () => {
    const db = fakeDb();
    await startUpdateTx(asDb(db) as never, { kind: "update", trigger: "manual", actorName: "Ana", from: "1.0.0", version: "1.1.0", manifestSha256: "f".repeat(64) });
    await expect(startUpdateTx(asDb(db) as never, { kind: "update", trigger: "auto", actorName: null, from: "1.0.0", version: "1.1.0", manifestSha256: "f".repeat(64) })).rejects.toBeInstanceOf(UpdateRefused);
  });
});

describe("beginApply and beginRollback: refusals", () => {
  const env = { version: "1.0.0", feedBase: "https://feed.test", publicKey: "k" };
  const stored = (releases: ReturnType<typeof release>[]) => ({ schema: 2, channel: "stable", generatedAt: "2026-10-01T00:00:00Z", releases, sha256: "f".repeat(64) });

  it("refuses a downgrade, an unsupported path and an unverified version", async () => {
    const db = fakeDb({ releaseVersion: "1.5.0", latestRelease: stored([release("2.0.0", { minFrom: "1.8.0" }), release("1.5.0"), release("1.2.0")]) });
    await expect(beginApply(asDb(db) as never, env, { version: "1.2.0", trigger: "manual", actorName: "a" })).rejects.toMatchObject({ code: "UPDATE_NOT_NEWER" });
    await expect(beginApply(asDb(db) as never, env, { version: "2.0.0", trigger: "manual", actorName: "a" })).rejects.toMatchObject({ code: "UPDATE_UNSUPPORTED_PATH" });
    await expect(beginApply(asDb(db) as never, env, { version: "9.0.0", trigger: "manual", actorName: "a" })).rejects.toMatchObject({ code: "UPDATE_NOT_VERIFIED" });
    expect(db.job.rows).toHaveLength(0);
  });

  it("rolls back only the last good update, within 7 days", async () => {
    // The feed must still list the target version; beginRollback pins the feed's own digests.
    const prevRel = { ...release("1.0.0"), images: { control: { amd64: OLD.control, arm64: OLD.control }, web: { amd64: OLD.web, arm64: OLD.web } } };
    const db = fakeDb({ releaseVersion: "1.1.0", latestRelease: stored([release("1.1.0"), prevRel]) });
    const finishedAt = new Date(Date.now() - 86_400_000);
    db.releaseUpdate.rows.push({ id: "u0", kind: "update", trigger: "auto", state: "done", fromVersion: "1.0.0", version: "1.1.0", fromImages: OLD, toImages: NEW, dumpBackupId: "d0", dumpSha256: "0".repeat(64), startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt, steps: [] });
    await expect(beginRollback(asDb(db) as never, env, { updateId: "nope", trigger: "manual", actorName: "a" })).rejects.toMatchObject({ code: "ROLLBACK_UNAVAILABLE" });
    const r = await beginRollback(asDb(db) as never, env, { updateId: "u0", trigger: "manual", actorName: "a" });
    expect(r).toMatchObject({ kind: "rollback", version: "1.0.0", fromVersion: "1.1.0", rollbackOfId: "u0" });
    expect((await buildStatus(asDb(db), env)).job?.kind).toBe("rollback");

    const late = fakeDb({ releaseVersion: "1.1.0" });
    late.releaseUpdate.rows.push({ ...db.releaseUpdate.rows[0]!, finishedAt: new Date(Date.now() - 8 * 86_400_000) });
    await expect(beginRollback(asDb(late) as never, env, { updateId: "u0", trigger: "manual", actorName: "a" })).rejects.toBeInstanceOf(UpdateRefused);
  });

  const doneUpdate = (fromImages: Images) => {
    const finishedAt = new Date(Date.now() - 86_400_000);
    return { id: "u0", kind: "update" as const, trigger: "auto" as const, state: "done", fromVersion: "1.0.0", version: "1.1.0", fromImages, toImages: NEW, dumpBackupId: "d0", dumpSha256: "0".repeat(64), startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt, steps: [] };
  };

  it("refuses a rollback whose recorded images do not match the signed feed", async () => {
    const prevRel = { ...release("1.0.0"), images: { control: { amd64: OLD.control, arm64: OLD.control }, web: { amd64: OLD.web, arm64: OLD.web } } };
    const db = fakeDb({ releaseVersion: "1.1.0", latestRelease: stored([release("1.1.0"), prevRel]) });
    db.releaseUpdate.rows.push(doneUpdate({ control: "evil/control@sha256:" + "9".repeat(64), web: OLD.web }));
    await expect(beginRollback(asDb(db) as never, env, { updateId: "u0", trigger: "manual", actorName: "a" })).rejects.toMatchObject({ code: "ROLLBACK_IMAGE_MISMATCH" });
  });

  it("refuses a rollback to a version no longer in the verified feed", async () => {
    const db = fakeDb({ releaseVersion: "1.1.0", latestRelease: stored([release("1.1.0")]) });
    db.releaseUpdate.rows.push(doneUpdate(OLD));
    await expect(beginRollback(asDb(db) as never, env, { updateId: "u0", trigger: "manual", actorName: "a" })).rejects.toMatchObject({ code: "ROLLBACK_UNVERIFIED" });
  });
});

describe("settleOrphans: a row that says running with no job behind it", () => {
  const T0 = new Date("2026-11-02T04:00:00Z");
  const later = new Date(T0.getTime() + LEASE_SECONDS * 1000);
  const stuck = async (db: ReturnType<typeof fakeDb>) => {
    const row = await startUpdateTx(asDb(db) as never, { kind: "update", trigger: "manual", actorName: "Ana", from: "1.0.0", version: "1.1.0", manifestSha256: "f".repeat(64) });
    db.job.rows.find((r) => r.kind === "self_update")!.failedAt = new Date();
    return row;
  };

  it("clears the row after a grace, with no SQL, and later updates and the watchdog's check are free", async () => {
    const db = fakeDb();
    await stuck(db);
    const seen = new Map<string, number>();
    expect(await settleOrphans({ db: asDb(db), now: T0 }, seen)).toBe(0);
    expect(db.releaseUpdate.rows[0]!.state).toBe("running");
    expect(await settleOrphans({ db: asDb(db), now: later }, seen)).toBe(1);
    expect(db.releaseUpdate.rows[0]).toMatchObject({ state: "failed", finishedAt: later });
    expect(db.releaseUpdate.rows[0]!.error).toMatch(/cannot resume it\. Run: sudo dockify redeploy/);
    expect(db.job.rows.find((r) => r.kind === "update_notify")!.payload).toMatchObject({ event: "failed", version: "1.1.0" });
    await expect(startUpdateTx(asDb(db) as never, { kind: "update", trigger: "manual", actorName: "Ana", from: "1.0.0", version: "1.1.0", manifestSha256: "f".repeat(64) })).resolves.toBeTruthy();
  });

  it("leaves a row whose job is open, leased or waiting", async () => {
    const db = fakeDb();
    await startUpdateTx(asDb(db) as never, { kind: "update", trigger: "manual", actorName: "Ana", from: "1.0.0", version: "1.1.0", manifestSha256: "f".repeat(64) });
    const seen = new Map([[db.releaseUpdate.rows[0]!.id as string, T0.getTime()]]);
    expect(await settleOrphans({ db: asDb(db), now: later }, seen)).toBe(0);
    expect(db.releaseUpdate.rows[0]!.state).toBe("running");
    expect(seen.size).toBe(0);
  });

  it("a job that comes back during the grace resets it", async () => {
    const db = fakeDb();
    await stuck(db);
    const seen = new Map<string, number>();
    await settleOrphans({ db: asDb(db), now: T0 }, seen);
    db.job.rows.find((r) => r.kind === "self_update")!.failedAt = null;
    await settleOrphans({ db: asDb(db), now: new Date(T0.getTime() + 1000) }, seen);
    db.job.rows.find((r) => r.kind === "self_update")!.failedAt = new Date();
    expect(await settleOrphans({ db: asDb(db), now: later }, seen)).toBe(0);
    expect(db.releaseUpdate.rows[0]!.state).toBe("running");
  });
});

describe("schedulerTick: check, notify once, install by policy", () => {
  const s = testSigner();
  const files = (rels: ReturnType<typeof release>[], generatedAt = "2026-10-01T00:00:00Z") => {
    const bytes = feedBytes(rels, { generatedAt });
    const sig = s.signMessage(bytes, comment(rels[0]!.version).replace("2026-10-01T00:00:00Z", generatedAt));
    return async (u: string) => (u.endsWith(".minisig") ? Buffer.from(sig) : bytes);
  };
  const env = { version: "1.0.0", feedBase: "https://feed.test", publicKey: s.pub };
  const MON_0400 = new Date("2026-11-02T04:00:00Z");
  const MON_1200 = new Date("2026-11-02T12:00:00Z");

  it("all releases, in the window: verifies, notifies once and enqueues an automatic install", async () => {
    const db = fakeDb();
    expect(await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.1.0")]), now: MON_0400 })).toBe("installing");
    expect(db.releaseUpdate.rows[0]).toMatchObject({ trigger: "auto", version: "1.1.0", state: "running" });
    expect(db.job.rows.filter((r) => r.kind === "update_notify")).toHaveLength(1);
    expect(db.instance.rows[0]!.updateNextCheckAt).toBeInstanceOf(Date);
    // The next tick neither notifies again nor starts a second update.
    db.instance.rows[0]!.updateNextCheckAt = new Date(MON_0400.getTime() + 6 * 3_600_000);
    expect(await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.1.0")]), now: new Date(MON_0400.getTime() + 60_000) })).toBe("idle");
    expect(db.job.rows.filter((r) => r.kind === "update_notify")).toHaveLength(1);
    expect(db.releaseUpdate.rows).toHaveLength(1);
  });

  it("outside the window it waits", async () => {
    const db = fakeDb();
    expect(await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.1.0")]), now: MON_1200 })).toBe("waiting");
    expect(db.releaseUpdate.rows).toHaveLength(0);
  });

  it("security only: a regular release only notifies; a critical one installs in the window", async () => {
    const db = fakeDb({ updateMode: "security" });
    expect(await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.1.0")]), now: MON_0400 })).toBe("notified");
    expect(db.releaseUpdate.rows).toHaveLength(0);
    const crit = fakeDb({ updateMode: "security" });
    expect(await schedulerTick({ db: asDb(crit), env, fetcher: files([release("1.1.0", { critical: true })]), now: MON_0400 })).toBe("installing");
    expect(await schedulerTick({ db: asDb(fakeDb({ updateMode: "security" })), env, fetcher: files([release("1.1.0", { critical: true })]), now: MON_1200 })).toBe("waiting");
  });

  it("refuses a replayed older feed and a tampered one, storing nothing new", async () => {
    const db = fakeDb();
    await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.1.0")], "2026-10-05T00:00:00Z"), now: MON_1200 });
    const stored = db.instance.rows[0]!.latestRelease;
    db.instance.rows[0]!.updateNextCheckAt = null;
    expect(await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.1.0")], "2026-10-01T00:00:00Z"), now: MON_1200 })).toBe("check-failed");
    expect(db.instance.rows[0]!.updateCheckError).toMatch(/replay/);
    expect(db.instance.rows[0]!.latestRelease).toBe(stored);

    const bytes = feedBytes([release("1.2.0")]);
    const sig = s.signMessage(feedBytes([release("1.1.0")]), comment("1.1.0"));
    db.instance.rows[0]!.updateNextCheckAt = null;
    expect(await schedulerTick({ db: asDb(db), env, fetcher: async (u) => (u.endsWith(".minisig") ? Buffer.from(sig) : bytes), now: MON_1200 })).toBe("check-failed");
    expect(db.instance.rows[0]!.updateCheckError).toMatch(/signature did not verify/);
  });

  it("emails every admin once per security release, the first time it is seen", async () => {
    const block = { level: "critical" as const, summary: "Sessions survive a password change.", cves: ["CVE-2026-3001"] };
    const db = fakeDb({ updateMode: "manual" });
    const sec = () => db.job.rows.filter((r) => r.kind === "security_notify");
    expect(await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.1.0", { critical: true, security: block })]), now: MON_1200 })).toBe("notified");
    expect(sec()).toHaveLength(1);
    expect(sec()[0]).toMatchObject({ lane: "maintenance", dedupeKey: "security_notify:1.1.0", payload: { version: "1.1.0", level: "critical", summary: block.summary, cves: block.cves, current: "1.0.0" } });
    expect(db.instance.rows[0]!.securityNoticeVersion).toBe("1.1.0");

    // The next ticks, and a feed that adds a release without a block, send nothing more.
    expect(await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.1.0", { critical: true, security: block })]), now: new Date(MON_1200.getTime() + 60_000) })).toBe("idle");
    db.instance.rows[0]!.updateNextCheckAt = null;
    await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.2.0"), release("1.1.0", { critical: true, security: block })], "2026-10-02T00:00:00Z"), now: MON_1200 });
    expect(sec()).toHaveLength(1);

    // A newer security release is new news.
    db.instance.rows[0]!.updateNextCheckAt = null;
    await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.2.1", { critical: true, security: { ...block, level: "important" } }), release("1.2.0"), release("1.1.0", { critical: true, security: block })], "2026-10-03T00:00:00Z"), now: MON_1200 });
    expect(sec().map((j) => (j.payload as { version: string }).version)).toEqual(["1.1.0", "1.2.1"]);
    // The older critical fix is still pending, so the alert stays critical.
    expect(sec()[1]!.payload).toMatchObject({ level: "critical" });
  });

  it("tells the admins about a security release even when no release can be installed yet", async () => {
    const db = fakeDb();
    const feed = files([release("2.0.1", { minFrom: "2.0.0", critical: true, security: { level: "important", summary: "Fix." } })]);
    expect(await schedulerTick({ db: asDb(db), env, fetcher: feed, now: MON_1200 })).toBe("notified");
    expect(db.job.rows.filter((r) => r.kind === "security_notify")).toHaveLength(1);
    expect(db.releaseUpdate.rows).toHaveLength(0);
  });

  it("does not retry on its own a version that already rolled back here", async () => {
    const db = fakeDb();
    db.releaseUpdate.rows.push({ id: "x", kind: "update", trigger: "auto", version: "1.1.0", state: "rolled_back", fromVersion: "1.0.0", startedAt: new Date(), steps: [] });
    expect(await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.1.0")]), now: MON_0400 })).toBe("notified");
    expect(db.releaseUpdate.rows).toHaveLength(1);
  });
});

describe("schedulerTick: after a rollback or a failure", () => {
  const s = testSigner();
  const files = (rels: ReturnType<typeof release>[], generatedAt = "2026-10-01T00:00:00Z") => {
    const bytes = feedBytes(rels, { generatedAt });
    const sig = s.signMessage(bytes, comment(rels[0]!.version).replace("2026-10-01T00:00:00Z", generatedAt));
    return async (u: string) => (u.endsWith(".minisig") ? Buffer.from(sig) : bytes);
  };
  const env = { version: "1.0.0", feedBase: "https://feed.test", publicKey: s.pub };
  const MON_0400 = new Date("2026-11-02T04:00:00Z");

  it("does not reinstall the version the admin rolled back from, until a newer one appears", async () => {
    const db = fakeDb({ updateSkipVersion: "1.1.0" });
    db.releaseUpdate.rows.push({ id: "x", kind: "update", trigger: "manual", version: "1.1.0", state: "done", fromVersion: "1.0.0", startedAt: new Date(), steps: [] });
    expect(await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.1.0")]), now: MON_0400 })).toBe("notified");
    expect(db.releaseUpdate.rows).toHaveLength(1);
    db.instance.rows[0]!.updateNextCheckAt = null;
    expect(await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.2.0"), release("1.1.0")], "2026-10-02T00:00:00Z"), now: MON_0400 })).toBe("installing");
    expect(db.releaseUpdate.rows.find((r) => r.state === "running")).toMatchObject({ version: "1.2.0", trigger: "auto" });
  });

  it("the admin can still pick the skipped version", async () => {
    const db = fakeDb({ updateSkipVersion: "1.1.0", latestRelease: { schema: 2, channel: "stable", generatedAt: "2026-10-01T00:00:00Z", releases: [release("1.1.0")], sha256: "f".repeat(64) } });
    await expect(beginApply(asDb(db) as never, env, { version: "1.1.0", trigger: "manual", actorName: "a" })).resolves.toMatchObject({ version: "1.1.0", trigger: "manual" });
  });

  it("does not retry on its own a version a manual update already rolled back", async () => {
    const db = fakeDb();
    db.releaseUpdate.rows.push({ id: "x", kind: "update", trigger: "manual", version: "1.1.0", state: "rolled_back", fromVersion: "1.0.0", startedAt: new Date(), steps: [] });
    await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.1.0")]), now: MON_0400 });
    expect(db.releaseUpdate.rows).toHaveLength(1);
  });

  it("checks the feed again right before an automatic install, so a re-signed feed cannot fail it", async () => {
    const db = fakeDb();
    await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.1.0")]), now: new Date("2026-11-02T01:00:00Z") });
    const stale = (db.instance.rows[0]!.latestRelease as { sha256: string }).sha256;
    db.instance.rows[0]!.updateNextCheckAt = new Date(MON_0400.getTime() + 3_600_000);
    const fresh = files([release("1.1.0")], "2026-10-02T00:00:00Z");
    expect(await schedulerTick({ db: asDb(db), env, fetcher: fresh, now: MON_0400 })).toBe("installing");
    const row = db.releaseUpdate.rows[0]!;
    expect(row.manifestSha256).not.toBe(stale);
    expect(row.manifestSha256).toBe((db.instance.rows[0]!.latestRelease as { sha256: string }).sha256);
  });

  it("a feed that fails that last check starts nothing", async () => {
    const db = fakeDb();
    await schedulerTick({ db: asDb(db), env, fetcher: files([release("1.1.0")]), now: new Date("2026-11-02T01:00:00Z") });
    db.instance.rows[0]!.updateNextCheckAt = new Date(MON_0400.getTime() + 3_600_000);
    expect(await schedulerTick({ db: asDb(db), env, fetcher: async () => { throw new Error("down"); }, now: MON_0400 })).toBe("check-failed");
    expect(db.releaseUpdate.rows).toHaveLength(0);
  });
});

describe("the host CLI", () => {
  it("awaits the update it runs: returned bare, the finally below disconnected Prisma under it", () => {
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(main).toContain("return await runHere(db, cfg, row)");
    expect(main).not.toMatch(/return runHere\(/);
  });
});
