/**
 * App.status said "running" for a stopped
 * container and for a crash loop, and an app whose first deploy failed said "unknown".
 */
import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { CRASH_LOOP, observedStatus, reconcileAppStatus, startedAtOf, writeObservedStatus, type StatusInput } from "./app-status.ts";
import { newSamplerState, type AppLatest } from "./sampler.ts";

const base: StatusInput = { desiredState: "running", deployed: true, lastDeployment: "ready", inFlight: false, container: { state: "running", health: null }, recentRestarts: 0 };
const s = (over: Partial<StatusInput>) => observedStatus({ ...base, ...over });

describe("observedStatus", () => {
  it("reads a running container as running, and an unhealthy one as degraded", () => {
    expect(s({})).toBe("running");
    expect(s({ container: { state: "running", health: "healthy" } })).toBe("running");
    expect(s({ container: { state: "running", health: "unhealthy" } })).toBe("degraded");
  });

  it("reads Docker restarting it, or a crash loop that is up between restarts, as restarting", () => {
    expect(s({ container: { state: "restarting", health: null } })).toBe("restarting");
    expect(s({ recentRestarts: CRASH_LOOP.restarts })).toBe("restarting");
    expect(s({ recentRestarts: CRASH_LOOP.restarts - 1 })).toBe("running");
  });

  it("tells an operator's stop from a container that exited on its own", () => {
    expect(s({ desiredState: "stopped", container: { state: "exited", health: null } })).toBe("stopped");
    expect(s({ container: { state: "exited", health: null } })).toBe("exited");
    expect(s({ container: { state: "dead", health: null } })).toBe("exited");
    expect(s({ container: { state: "created", health: null } })).toBe("exited");
  });

  it("reads no container as missing once it went live, failed after a failed first deploy, else unknown", () => {
    expect(s({ container: null })).toBe("missing");
    expect(s({ container: null, deployed: false, lastDeployment: "failed" })).toBe("failed");
    expect(s({ container: null, deployed: false, lastDeployment: null })).toBe("unknown");
    expect(s({ container: null, deployed: false, lastDeployment: "cancelled" })).toBe("unknown");
    expect(s({ container: null, desiredState: "stopped" })).toBe("stopped");
  });

  it("leaves an app with a deploy in flight as deploying", () => {
    expect(s({ inFlight: true, container: { state: "exited", health: null } })).toBe("deploying");
    expect(s({ inFlight: true, container: null, deployed: false })).toBe("deploying");
  });

  it("parses Docker's start time and its year-one never-started value", () => {
    expect(startedAtOf("2026-11-06T09:00:00.123456789Z")?.toISOString()).toBe("2026-11-06T09:00:00.123Z");
    expect(startedAtOf("0001-01-01T00:00:00Z")).toBeNull();
    expect(startedAtOf(null)).toBeNull();
    expect(startedAtOf("garbage")).toBeNull();
  });
});

interface Row {
  id: string;
  status: string;
  desiredState: "running" | "stopped";
  currentDeploymentId: string | null;
  containerStartedAt: Date | null;
  deployments: Array<{ status: string; finishedAt?: Date | null }>;
}

function fakeDb(rows: Row[], inFlight: string[] = []) {
  const writes: Array<{ id: string; from: string; data: Record<string, unknown> }> = [];
  const db = {
    app: {
      findMany: async () => rows,
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      updateMany: async ({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        const r = rows.find((x) => x.id === where.id && x.status === where.status);
        if (!r) return { count: 0 };
        writes.push({ id: where.id, from: where.status, data });
        Object.assign(r, data);
        return { count: 1 };
      },
    },
    deployment: {
      findMany: async () => inFlight.map((appId) => ({ appId })),
      findFirst: async ({ where }: { where: { appId: string } }) => (inFlight.includes(where.appId) ? { id: "d" } : null),
    },
  } as unknown as Db;
  return { db, writes };
}

const latest = (over: Partial<AppLatest>): AppLatest => ({
  at: new Date(), containerId: "c", state: "running", health: null, startedAt: "2026-11-06T08:00:00Z", restartCount: 0, cpuPct: 1, memBytes: 1, memLimitBytes: 0, ...over,
});
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id, status: "running", desiredState: "running", currentDeploymentId: "d1", containerStartedAt: new Date("2026-11-06T08:00:00Z"), deployments: [{ status: "ready" }], ...over,
});

describe("reconcileAppStatus (the observe pass)", () => {
  const now = Date.parse("2026-11-06T10:00:00Z");

  it("writes what the daemon reports: a stopped, a crash looping, a vanished and a never-started app", async () => {
    const state = newSamplerState();
    state.dockerSeen = true;
    state.listedAt = now;
    state.listed = new Set(["stopped", "looping", "ok"]);
    state.apps.set("stopped", latest({ state: "exited" }));
    state.apps.set("looping", latest({ state: "running" }));
    state.restarts.set("looping", [now - 60_000, now - 30_000]);
    state.apps.set("ok", latest({}));
    const rows = [row("stopped"), row("looping"), row("ok"), row("gone"), row("first", { status: "unknown", currentDeploymentId: null, deployments: [{ status: "failed" }] })];
    const { db, writes } = fakeDb(rows);
    expect(await reconcileAppStatus(db, "s1", state, { maxAgeMs: 60_000, now })).toBe(4);
    const by = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(by).toEqual({ stopped: "exited", looping: "restarting", ok: "running", gone: "missing", first: "failed" });
    // Each write is a compare-and-set over the status it read.
    expect(writes.every((w) => w.from === "running" || w.from === "unknown")).toBe(true);
  });

  it("records the container's start time, and writes nothing when nothing changed", async () => {
    const state = newSamplerState();
    state.dockerSeen = true;
    state.listedAt = now;
    state.listed = new Set(["a"]);
    state.apps.set("a", latest({ startedAt: "2026-11-06T09:30:00Z" }));
    const rows = [row("a")];
    const { db, writes } = fakeDb(rows);
    expect(await reconcileAppStatus(db, "s1", state, { maxAgeMs: 60_000, now })).toBe(1);
    expect(writes[0]?.data).toEqual({ status: "running", containerStartedAt: new Date("2026-11-06T09:30:00Z") });
    expect(await reconcileAppStatus(db, "s1", state, { maxAgeMs: 60_000, now })).toBe(0);
  });

  it("never judges blind: no listing yet, a stale listing, or an app whose inspect failed this tick", async () => {
    const rows = [row("a"), row("b")];
    const { db, writes } = fakeDb(rows);
    const blind = newSamplerState();
    expect(await reconcileAppStatus(db, "s1", blind, { maxAgeMs: 60_000, now })).toBe(0);
    const stale = newSamplerState();
    stale.dockerSeen = true;
    stale.listedAt = now - 120_000;
    expect(await reconcileAppStatus(db, "s1", stale, { maxAgeMs: 60_000, now })).toBe(0);
    const partial = newSamplerState();
    partial.dockerSeen = true;
    partial.listedAt = now;
    partial.listed = new Set(["a", "b"]);
    partial.apps.set("b", latest({ startedAt: "2026-11-06T08:00:00Z" }));
    expect(await reconcileAppStatus(db, "s1", partial, { maxAgeMs: 60_000, now })).toBe(0);
    expect(writes).toEqual([]);
  });

  it("does not judge an app by a listing older than the deploy that just settled it", async () => {
    const state = newSamplerState();
    state.dockerSeen = true;
    state.listedAt = now - 5_000;
    // The listing, taken mid-deploy, shows no container: the new one came after it.
    const rows = [row("adoptpg", { status: "running", currentDeploymentId: "d", deployments: [{ status: "ready", finishedAt: new Date(now - 2_000) }] })];
    const { db, writes } = fakeDb(rows);
    expect(await reconcileAppStatus(db, "s1", state, { maxAgeMs: 60_000, now })).toBe(0);
    expect(writes).toEqual([]);
    // The next listing is newer than the deploy, and counts.
    state.listedAt = now;
    expect(await reconcileAppStatus(db, "s1", state, { maxAgeMs: 60_000, now })).toBe(1);
    expect(rows[0]!.status).toBe("missing");
  });

  it("does not overwrite a deploy that set deploying after the pass read the row", async () => {
    const state = newSamplerState();
    state.dockerSeen = true;
    state.listedAt = now;
    const rows = [row("a")];
    const { db, writes } = fakeDb(rows);
    // The pass reads "running"; a deploy flips it to "deploying" before the write lands.
    const findMany = db.app.findMany.bind(db.app);
    (db.app as unknown as { findMany: () => Promise<Row[]> }).findMany = async () => {
      const out = (await findMany({} as never)) as unknown as Row[];
      const copy = out.map((r) => ({ ...r }));
      rows[0]!.status = "deploying";
      return copy;
    };
    expect(await reconcileAppStatus(db, "s1", state, { maxAgeMs: 60_000, now })).toBe(0);
    expect(writes).toEqual([]);
    expect(rows[0]!.status).toBe("deploying");
  });
});

describe("writeObservedStatus (right after a deploy or a power action)", () => {
  it("marks an app whose first deploy failed with no container as failed, not unknown", async () => {
    const rows = [row("first", { status: "deploying", currentDeploymentId: null, deployments: [{ status: "failed" }] })];
    const { db } = fakeDb(rows);
    expect(await writeObservedStatus(db, "first", null)).toBe("failed");
    expect(rows[0]).toMatchObject({ status: "failed", containerId: null });
  });

  it("keeps a deploy in flight as deploying", async () => {
    const rows = [row("a", { status: "deploying" })];
    const { db } = fakeDb(rows, ["a"]);
    await writeObservedStatus(db, "a", { id: "c9", state: "running", health: null });
    expect(rows[0]).toMatchObject({ status: "deploying", containerId: "c9" });
  });
});
