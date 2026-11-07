import { describe, expect, it } from "vitest";
import { runUpdate, type Images, type Journal, type Preflight, type StepId, type UpdateRecorder, type UpdateSteps } from "./runner.ts";
import { newJournal } from "./state.ts";

const NEW: Images = { control: "r/control@sha256:" + "1".repeat(64), web: "r/web@sha256:" + "2".repeat(64) };
const OLD: Images = { control: "r/control@sha256:" + "3".repeat(64), web: "r/web@sha256:" + "4".repeat(64) };
const T0 = new Date("2026-11-01T03:00:00Z");

type Name = keyof UpdateSteps;

function journal(over: Partial<Journal> = {}): Journal {
  return { ...newJournal({ id: "u1", kind: "update", from: "1.0.0", version: "1.1.0", manifestSha256: "f".repeat(64), now: T0 }), ...over };
}

function harness(opts: { failAt?: Partial<Record<Name, number>>; healthy?: Array<string | null>; preflight?: Preflight[]; resolved?: Images; clock?: number[] } = {}) {
  const calls: string[] = [];
  const counts: Partial<Record<Name, number>> = {};
  const audits: string[] = [];
  let pinned = OLD;
  let finished: string | null = null;
  let saved: Journal | null = null;
  let restores = 0;
  const healthy = [...(opts.healthy ?? [null])];
  const pre = [...(opts.preflight ?? [{ ok: true } as Preflight])];
  let t = T0.getTime();
  const hit = (name: Name, arg?: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
    calls.push(arg ? `${name}:${arg}` : name);
    if (opts.failAt?.[name] === counts[name]) throw new Error(`${name} broke`);
  };
  const tag = (i: Images) => (i === NEW || i.control === NEW.control ? "new" : "old");
  const steps: UpdateSteps = {
    preflight: async () => (hit("preflight"), pre.shift() ?? { ok: true }),
    resolve: async () => (hit("resolve"), opts.resolved ?? NEW),
    currentImages: async () => (hit("currentImages"), pinned),
    pull: async (i) => hit("pull", tag(i)),
    quiesce: async () => hit("quiesce"),
    dump: async () => (hit("dump"), { id: "dump-1", sha256: "d".repeat(64), bytes: 4096 }),
    migrate: async (i) => hit("migrate", tag(i)),
    pin: async (i) => {
      hit("pin", tag(i));
      pinned = i;
    },
    swap: async (s) => hit("swap", `${s}@${tag(pinned)}`),
    healthy: async () => (hit("healthy"), healthy.length ? healthy.shift()! : null),
    restoreDump: async (d) => hit("restoreDump", d.id),
  };
  const rec: UpdateRecorder = {
    save: async (j) => void (saved = structuredClone(j)),
    audit: async (_j, step: StepId, status) => void audits.push(`${step}:${status}`),
    beforeRestore: async () => void calls.push("beforeRestore"),
    afterRestore: async () => {
      restores++;
      calls.push("afterRestore");
    },
    finish: async (v) => void (finished = v),
    log: () => undefined,
    now: () => new Date((t += 1000)),
  };
  return { steps, rec, calls, audits, finished: () => finished, saved: () => saved!, restores: () => restores, pinned: () => pinned, advance: (ms: number) => void (t += ms) };
}

/** A killed process: the call never returns. */
const dead = () => new Promise<never>(() => undefined);
const settleTicks = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
};

const status = (j: Journal, id: StepId) => j.steps.find((s) => s.id === id)?.status;

describe("runUpdate: the happy path", () => {
  it("preflight, pull, backup, migrate, swaps one at a time, health, then marks the version", async () => {
    const h = harness();
    const j = journal();
    expect(await runUpdate(j, h.steps, h.rec)).toEqual({ outcome: "done" });
    expect(h.calls).toEqual([
      "preflight", "resolve", "currentImages", "pull:new", "quiesce", "dump", "migrate:new",
      "pin:new", "swap:api@new", "pin:new", "swap:worker@new", "pin:new", "swap:web@new", "healthy",
    ]);
    expect(h.finished()).toBe("1.1.0");
    const s = h.saved();
    expect(s.state).toBe("done");
    expect(s.fromImages).toEqual(OLD);
    expect(s.dumpSha256).toBe("d".repeat(64));
    expect(s.steps.every((r) => r.status === "done")).toBe(true);
    expect(h.audits).toEqual(["preflight:done", "pull:done", "backup:done", "migrate:done", "swap_api:done", "swap_worker:done", "swap_web:done", "health:done"]);
  });
});

describe("preflight", () => {
  it("blocks while a deploy or restore is in flight: waits, changing nothing", async () => {
    const h = harness({ preflight: [{ ok: false, wait: true, reason: "a deploy is in flight" }] });
    const r = await runUpdate(journal(), h.steps, h.rec);
    expect(r).toEqual({ outcome: "waiting", error: "a deploy is in flight" });
    expect(h.calls).toEqual(["preflight"]);
    expect(h.saved().state).toBe("waiting");
    expect(h.saved().steps.find((s) => s.id === "preflight")?.detail).toMatch(/waiting: a deploy/);
  });

  it("goes on once the server is free, keeping the first start time", async () => {
    const h = harness({ preflight: [{ ok: false, wait: true, reason: "a restore is in flight" }, { ok: true }] });
    const j = journal();
    await runUpdate(j, h.steps, h.rec);
    const first = h.saved().steps[0]!.startedAt;
    expect(await runUpdate(h.saved(), h.steps, h.rec)).toEqual({ outcome: "done" });
    expect(h.saved().steps[0]!.startedAt).toBe(first);
  });

  it("gives up after waiting too long, and refuses outright on low disk", async () => {
    const h = harness({ preflight: [{ ok: false, wait: true, reason: "a deploy is in flight" }, { ok: false, wait: true, reason: "a deploy is in flight" }] });
    await runUpdate(journal(), h.steps, h.rec, { maxWaitMs: 60_000 });
    h.advance(120_000);
    const r = await runUpdate(h.saved(), h.steps, h.rec, { maxWaitMs: 60_000 });
    expect(r.outcome).toBe("failed");
    expect(r.error).toMatch(/still busy after waiting.*Nothing was changed/);

    const d = harness({ preflight: [{ ok: false, wait: false, reason: "not enough free disk" }] });
    const r2 = await runUpdate(journal(), d.steps, d.rec);
    expect(r2.outcome).toBe("failed");
    expect(d.calls).toEqual(["preflight"]);
    expect(status(d.saved(), "pull")).toBe("skipped");
  });
});

describe("failures before anything durable changed", () => {
  it("a re-verified manifest naming other images stops the update before any pull", async () => {
    const h = harness({ resolved: OLD });
    const j = journal({ toImages: NEW });
    const r = await runUpdate(j, h.steps, h.rec);
    expect(r.outcome).toBe("failed");
    expect(r.error).toMatch(/no longer matches/);
    expect(h.calls).toEqual(["preflight", "resolve"]);
  });

  it("a failed pull changes nothing", async () => {
    const h = harness({ failAt: { pull: 1 } });
    const r = await runUpdate(journal(), h.steps, h.rec);
    expect(r.outcome).toBe("failed");
    expect(r.error).toMatch(/Nothing was changed/);
    expect(h.calls).not.toContain("quiesce");
  });

  it("a failed dump starts the previous version again, with no restore", async () => {
    const h = harness({ failAt: { dump: 1 } });
    const r = await runUpdate(journal(), h.steps, h.rec);
    expect(r.outcome).toBe("failed");
    expect(r.error).toMatch(/previous version is running again/);
    expect(h.calls).not.toContain("restoreDump");
    expect(h.calls.slice(-4)).toEqual(["pin:old", "swap:api@old", "swap:worker@old", "swap:web@old"]);
  });
});

describe("automatic rollback", () => {
  it("on a failed migration: restores the dump, then the previous digests, then checks health", async () => {
    const h = harness({ failAt: { migrate: 1 } });
    const r = await runUpdate(journal(), h.steps, h.rec);
    expect(r).toEqual({ outcome: "rolled_back", error: "migrate failed: migrate broke" });
    const tail = h.calls.slice(h.calls.indexOf("migrate:new") + 1);
    expect(tail).toEqual(["quiesce", "beforeRestore", "restoreDump:dump-1", "afterRestore", "pin:old", "swap:api@old", "swap:worker@old", "swap:web@old", "healthy"]);
    expect(h.restores()).toBe(1);
    expect(h.finished()).toBeNull();
    expect(h.pinned()).toEqual(OLD);
    expect(status(h.saved(), "rollback")).toBe("done");
    expect(status(h.saved(), "swap_api")).toBe("skipped");
  });

  it("on a failed health check: restores the dump (the migration ran) and the previous digests", async () => {
    const h = harness({ healthy: ["the worker has not sent a heartbeat since the swap", null] });
    const r = await runUpdate(journal(), h.steps, h.rec);
    expect(r.outcome).toBe("rolled_back");
    expect(r.error).toMatch(/health check failed: the worker/);
    expect(h.calls).toContain("restoreDump:dump-1");
    expect(h.pinned()).toEqual(OLD);
    expect(h.finished()).toBeNull();
    expect(h.audits).toContain("health:failed");
    expect(h.audits.at(-1)).toBe("rollback:done");
  });

  it("on a failed swap of the web: the api and worker come back on the previous digests too", async () => {
    const h = harness({ failAt: { swap: 3 } });
    const r = await runUpdate(journal(), h.steps, h.rec);
    expect(r.outcome).toBe("rolled_back");
    expect(h.calls.slice(-5)).toEqual(["pin:old", "swap:api@old", "swap:worker@old", "swap:web@old", "healthy"]);
  });

  it("a rollback that itself fails names the dump to restore by hand", async () => {
    const h = harness({ failAt: { migrate: 1, restoreDump: 1 } });
    const r = await runUpdate(journal(), h.steps, h.rec);
    expect(r.outcome).toBe("failed");
    expect(r.error).toMatch(/ROLLBACK FAILED: restoreDump broke\. Restore dump dump-1 by hand/);
    expect(status(h.saved(), "rollback")).toBe("failed");
  });
});

describe("idempotent retry after a crash (lease takeover)", () => {
  it("resumes from the journaled phase with the journaled previous digests, never re-dumping or re-migrating", async () => {
    // The first holder is killed right after it journals the start of the worker swap: the api
    // already runs the new digests and release.env names them.
    const first = harness();
    let persisted: Journal | null = null;
    const rec: UpdateRecorder = {
      ...first.rec,
      save: async (j) => {
        persisted = structuredClone(j);
        if (j.steps.find((s) => s.id === "swap_worker")?.status === "running") await dead();
      },
    };
    void runUpdate(journal(), first.steps, rec);
    await settleTicks();
    expect(first.calls).toContain("swap:api@new");
    expect(first.pinned()).toEqual(NEW);
    expect(persisted!.phase).toBe("swap_worker");
    expect(persisted!.state).toBe("running");

    // The lease lapses; the next holder claims the job (attempt 2) and resumes the journal.
    const next = harness();
    const j = { ...persisted!, attempt: 2 };
    const r = await runUpdate(j, next.steps, next.rec);
    expect(r).toEqual({ outcome: "done" });
    expect(next.calls).toEqual(["pin:new", "swap:worker@new", "pin:new", "swap:web@new", "healthy"]);
    // The previous digests come from the journal, not from release.env (which names the new ones).
    expect(next.calls).not.toContain("currentImages");
    expect(next.saved().fromImages).toEqual(OLD);
    expect(next.saved().dumpBackupId).toBe("dump-1");
    expect(next.saved().attempt).toBe(2);
  });

  it("a takeover after a crash mid-migration re-runs the migration, then rolls back with the dump on failure", async () => {
    const first = harness();
    let persisted: Journal | null = null;
    const rec: UpdateRecorder = {
      ...first.rec,
      save: async (j) => {
        persisted = structuredClone(j);
        if (j.migrationStarted && j.steps.find((s) => s.id === "migrate")?.status === "running") await dead();
      },
    };
    void runUpdate(journal(), first.steps, rec);
    await settleTicks();
    expect(first.calls).not.toContain("migrate:new");
    expect(persisted!.migrationStarted).toBe(true);

    const next = harness({ failAt: { migrate: 1 } });
    const r = await runUpdate({ ...persisted!, attempt: 2 }, next.steps, next.rec);
    expect(r.outcome).toBe("rolled_back");
    expect(next.calls[0]).toBe("migrate:new");
    expect(next.calls).toContain("restoreDump:dump-1");
    expect(next.calls).not.toContain("dump");
  });

  it("a takeover during the rollback finishes the rollback", async () => {
    const h = harness();
    const j = journal({ phase: "rollback", state: "running", migrationStarted: true, dumpBackupId: "dump-1", dumpSha256: "d".repeat(64), fromImages: OLD, toImages: NEW, error: "health check failed: x" });
    const r = await runUpdate(j, h.steps, h.rec);
    expect(r).toEqual({ outcome: "rolled_back", error: "health check failed: x" });
    expect(h.calls).toEqual(["quiesce", "beforeRestore", "restoreDump:dump-1", "afterRestore", "pin:old", "swap:api@old", "swap:worker@old", "swap:web@old", "healthy"]);
  });

  it("a settled journal is a no-op on a duplicate claim", async () => {
    const h = harness();
    const r = await runUpdate(journal({ state: "done" }), h.steps, h.rec);
    expect(r.outcome).toBe("done");
    expect(h.calls).toEqual([]);
  });
});

describe("a rollback job (Roll back to vX)", () => {
  it("takes a fresh dump, restores the target update's dump, and swaps to its previous digests", async () => {
    const h = harness();
    const j = journal({ kind: "rollback", fromVersion: "1.1.0", version: "1.0.0", manifestSha256: null, toImages: OLD, rollbackOfId: "u0" });
    // Running the new images now; going back to OLD.
    h.steps.currentImages = async () => (h.calls.push("currentImages"), NEW);
    const r = await runUpdate(j, h.steps, h.rec, { restoreTarget: { id: "dump-0", sha256: "0".repeat(64) } });
    expect(r).toEqual({ outcome: "done" });
    expect(h.calls).not.toContain("resolve");
    expect(h.calls).toContain("dump");
    expect(h.calls).toContain("restoreDump:dump-0");
    expect(h.calls).not.toContain("migrate:old");
    expect(h.pinned()).toEqual(OLD);
    expect(h.saved().fromImages).toEqual(NEW);
  });

  it("a failed rollback job returns to where it started, restoring the fresh dump", async () => {
    const h = harness({ healthy: ["the api is not ready (/readyz)", null] });
    h.steps.currentImages = async () => NEW;
    const j = journal({ kind: "rollback", fromVersion: "1.1.0", version: "1.0.0", manifestSha256: null, toImages: OLD, rollbackOfId: "u0" });
    const r = await runUpdate(j, h.steps, h.rec, { restoreTarget: { id: "dump-0", sha256: "0".repeat(64) } });
    expect(r.outcome).toBe("rolled_back");
    expect(h.calls.filter((c) => c.startsWith("restoreDump"))).toEqual(["restoreDump:dump-0", "restoreDump:dump-1"]);
    expect(h.pinned()).toEqual(NEW);
  });
});
