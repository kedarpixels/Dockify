import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { RequestError, requestBackup } from "./requests.ts";

type Row = Record<string, any>;

const APP = "0f0f0f0f-0000-4000-8000-000000000001";

function fakeDb(seed: { backups: Row[]; jobs: Row[]; schedules?: Row[]; destinations?: Row[] }) {
  const backups = [...seed.backups];
  const jobs = [...seed.jobs];
  const schedules = seed.schedules ?? [];
  const destinations = seed.destinations ?? [];
  const pick = (where: Row = {}) =>
    destinations
      .filter((d) => (where.type === undefined || d.type === where.type) && (where.isDefault === undefined || d.isDefault === where.isDefault))
      .sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault))[0] ?? null;
  const open = (j: Row) => j.completedAt == null && j.failedAt == null;
  const tx = {
    $executeRaw: async () => 0,
    app: {
      findUnique: async () => ({
        id: APP, name: "db", kind: "postgres", environmentId: "e1",
        image: "postgres:16-alpine", pinnedImage: `postgres:16-alpine@sha256:${"1".repeat(64)}`,
        environment: { name: "production", project: { slug: "p" } },
      }),
    },
    backup: {
      findFirst: async ({ where }: Row) => backups.find((b) => b.appId === where.appId && b.status === where.status) ?? null,
      update: async ({ where, data }: Row) => Object.assign(backups.find((b) => b.id === where.id)!, data),
      create: async ({ data }: Row) => {
        const row = { id: `b${backups.length}`, ...data };
        backups.push(row);
        return row;
      },
    },
    backupSchedule: { findMany: async ({ where }: Row) => schedules.filter((r) => r.appId === where.appId) },
    backupDestination: {
      findFirst: async ({ where }: Row) => pick(where),
      findUnique: async ({ where }: Row) => destinations.find((d) => d.id === where.id) ?? null,
      upsert: async ({ create }: Row) => {
        const row = { id: "local-dest", ...create };
        destinations.push(row);
        return row;
      },
    },
    job: {
      findFirst: async ({ where }: Row) =>
        where.payload
          ? jobs.find((j) => j.kind === where.kind && j.payload?.backupId === where.payload.equals) ?? null
          : jobs.find((j) => j.kind === where.kind && j.dedupeKey === where.dedupeKey && open(j)) ?? null,
      create: async ({ data }: Row) => {
        const row = { id: `j${jobs.length}`, ...data };
        jobs.push(row);
        return row;
      },
    },
  };
  const db = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as Db;
  return { db, backups, jobs };
}

describe("requestBackup during a restore", () => {
  it("refuses with BUSY and leaves the pre-restore safety dump running", async () => {
    const f = fakeDb({
      backups: [{ id: "pre", appId: APP, status: "running", trigger: "pre_restore" }],
      jobs: [{ id: "rj", kind: "restore", dedupeKey: `restore:${APP}`, completedAt: null, failedAt: null }],
    });
    const err = await requestBackup(f.db, APP, "schedule").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).status).toBe(409);
    expect((err as RequestError).code).toBe("BUSY");
    expect(f.backups.find((b) => b.id === "pre")!.status).toBe("running");
    expect(f.jobs.filter((j) => j.kind === "backup")).toHaveLength(0);
  });

  it("still settles a true crash leftover when no restore or backup job is open", async () => {
    const f = fakeDb({
      backups: [{ id: "old", appId: APP, status: "running", trigger: "schedule" }],
      jobs: [{ id: "rj", kind: "restore", dedupeKey: `restore:${APP}`, completedAt: new Date(), failedAt: null }],
    });
    const out = await requestBackup(f.db, APP, "manual");
    expect(out.existing).toBe(false);
    expect(f.backups.find((b) => b.id === "old")!.status).toBe("failed");
    expect(f.jobs.some((j) => j.kind === "backup" && j.dedupeKey === `backup:${APP}`)).toBe(true);
  });

  it("settles a leftover with the reason its last job failed with, not a generic line", async () => {
    const f = fakeDb({
      backups: [{ id: "old", appId: APP, status: "running", trigger: "manual", error: null }],
      jobs: [{ id: "bj", kind: "backup", dedupeKey: `backup:${APP}`, payload: { backupId: "old" }, completedAt: null, failedAt: new Date(), lastError: "EACCES: permission denied, mkdir '/var/lib/dockify/work/tmp'" }],
    });
    await requestBackup(f.db, APP, "manual");
    expect(f.backups.find((b) => b.id === "old")).toMatchObject({ status: "failed", error: "EACCES: permission denied, mkdir '/var/lib/dockify/work/tmp'" });
  });

  it("records the service's image and pinned digest in the snapshot, so a restore runs the same server", async () => {
    const f = fakeDb({ backups: [], jobs: [] });
    await requestBackup(f.db, APP, "manual");
    expect(f.backups[0]!.appSnapshot).toMatchObject({ name: "db", kind: "postgres", image: "postgres:16-alpine", pinnedImage: `postgres:16-alpine@sha256:${"1".repeat(64)}` });
  });

  it("reuses a running backup that has its own open job", async () => {
    const f = fakeDb({
      backups: [{ id: "live", appId: APP, status: "running", trigger: "schedule" }],
      jobs: [{ id: "bj", kind: "backup", dedupeKey: `backup:${APP}`, completedAt: null, failedAt: null }],
    });
    expect(await requestBackup(f.db, APP, "pre_deploy")).toEqual({ backupId: "live", backupIds: ["live"], jobId: "bj", existing: true });
  });
});

describe("requestBackup for tiers", () => {
  const tier = (t: string, over: Row = {}): Row => ({ appId: APP, tier: t, enabled: true, cron: "0 3 * * *", timezone: "UTC", keep: 7, keepDays: null, destinationId: null, lastRunAt: null, ...over });
  const B2 = { id: "b2", type: "s3", isDefault: true };
  const LOCAL = { id: "here", type: "local", isDefault: false };

  it("takes one dump for both tiers: a row per tier, each to its own destination, one job", async () => {
    const f = fakeDb({ backups: [], jobs: [], schedules: [tier("local"), tier("offsite")], destinations: [B2, LOCAL] });
    const out = await requestBackup(f.db, APP, "schedule", { tiers: ["local", "offsite"] });
    expect(out.backupIds).toHaveLength(2);
    expect(f.backups.map((b) => b.destinationId)).toEqual(["here", "b2"]);
    const jobs = f.jobs.filter((j) => j.kind === "backup");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ backupId: out.backupIds[0], copies: [out.backupIds[1]] });
  });

  it("sends offsite to the tier's own S3 destination over the default", async () => {
    const f = fakeDb({ backups: [], jobs: [], schedules: [tier("offsite", { destinationId: "own" })], destinations: [B2, { id: "own", type: "s3", isDefault: false }] });
    await requestBackup(f.db, APP, "manual", { tiers: ["offsite"] });
    expect(f.backups.map((b) => b.destinationId)).toEqual(["own"]);
  });

  it("a scheduled run that meets another run in flight is BUSY, so its slot is given back", async () => {
    const f = fakeDb({
      backups: [{ id: "live", appId: APP, status: "running", trigger: "manual" }],
      jobs: [{ id: "bj", kind: "backup", dedupeKey: `backup:${APP}`, completedAt: null, failedAt: null }],
      schedules: [tier("offsite")],
      destinations: [B2],
    });
    const err = await requestBackup(f.db, APP, "schedule", { tiers: ["offsite"] }).catch((e: unknown) => e);
    expect((err as RequestError).code).toBe("BUSY");
  });

  it("a schedule still takes the local copy when offsite has no storage; by hand the refusal is the answer", async () => {
    const f = fakeDb({ backups: [], jobs: [], schedules: [tier("local"), tier("offsite")], destinations: [LOCAL] });
    const out = await requestBackup(f.db, APP, "schedule", { tiers: ["local", "offsite"] });
    expect(out.backupIds).toHaveLength(1);
    expect(f.backups.map((b) => b.destinationId)).toEqual(["here"]);
    const err = await requestBackup(fakeDb({ backups: [], jobs: [], destinations: [LOCAL] }).db, APP, "manual", { tiers: ["offsite"] }).catch((e: unknown) => e);
    expect((err as RequestError).code).toBe("NO_DESTINATION");
  });

  it("without tiers goes where the schedule points: the tier that is on", async () => {
    const f = fakeDb({ backups: [], jobs: [], schedules: [tier("local", { enabled: false }), tier("offsite")], destinations: [LOCAL, { ...B2, isDefault: false }] });
    await requestBackup(f.db, APP, "pre_update");
    expect(f.backups.map((b) => b.destinationId)).toEqual(["b2"]);
  });
});
