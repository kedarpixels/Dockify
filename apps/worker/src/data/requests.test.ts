import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { RequestError, requestBackup } from "./requests.ts";

type Row = Record<string, any>;

const APP = "0f0f0f0f-0000-4000-8000-000000000001";

function fakeDb(seed: { backups: Row[]; jobs: Row[] }) {
  const backups = [...seed.backups];
  const jobs = [...seed.jobs];
  const open = (j: Row) => j.completedAt == null && j.failedAt == null;
  const tx = {
    $executeRaw: async () => 0,
    app: {
      findUnique: async () => ({
        id: APP, name: "db", kind: "postgres", environmentId: "e1", backupDestinationId: null,
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
    backupDestination: { findFirst: async () => null },
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
    expect(await requestBackup(f.db, APP, "pre_deploy")).toEqual({ backupId: "live", jobId: "bj", existing: true });
  });
});
