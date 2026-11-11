import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { deleteOrphanedBackups } from "./orphans.ts";
import { LocalStore, StoreError } from "./store.ts";

const APP = "0f0e0d0c-0000-4000-8000-0000000000aa";

function fakeDb(rows: Array<Record<string, unknown>>, appExists = false) {
  const left = [...rows];
  const jobs: unknown[] = [];
  const db = {
    app: { findUnique: async () => (appExists ? { id: APP } : null) },
    backup: {
      findMany: async () => left,
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        const before = left.length;
        for (const id of where.id.in) left.splice(left.findIndex((r) => r.id === id), 1);
        return { count: before - left.length };
      },
    },
    job: { update: async (a: { data: unknown }) => void jobs.push(a.data) },
  } as unknown as Db;
  return { db, left, jobs };
}

const row = (id: string, objectKey: string | null, over: Record<string, unknown> = {}) => ({ id, objectKey, expiredAt: null, sizeBytes: 999n, destinationId: null, status: "ready", ...over });

describe("deleteOrphanedBackups", () => {
  it("deletes the real files and reports the bytes on disk, not the row's", async () => {
    const root = await mkdtemp(join(tmpdir(), "dk-orphans-"));
    try {
      await mkdir(join(root, "apps", APP), { recursive: true });
      await writeFile(join(root, "apps", APP, "a.dkbk"), "x".repeat(700));
      const store = new LocalStore(root);
      const { db, left, jobs } = fakeDb([row("a", `apps/${APP}/a.dkbk`), row("gone", `apps/${APP}/never-there.dkbk`)]);
      const r = await deleteOrphanedBackups({ db, storeFor: async () => ({ store, prefix: "", destinationId: null, type: "local" }) }, "job", { sourceAppId: APP });
      expect(r).toEqual({ deleted: 2, freedBytes: 700, failed: 0 });
      expect(await readdir(join(root, "apps", APP))).toEqual([]);
      expect(left).toEqual([]);
      expect(jobs[0]).toEqual({ payload: { sourceAppId: APP, result: { deleted: 2, freedBytes: 700, failed: 0 } } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a row whose file could not be deleted: it is the only record of where it is", async () => {
    const store = { kind: "s3", delete: async () => { throw new StoreError("denied", 403); } };
    const { db, left } = fakeDb([row("a", "k")]);
    const r = await deleteOrphanedBackups({ db, storeFor: async () => ({ store, prefix: "", destinationId: "d", type: "s3" }) as never }, "job", { sourceAppId: APP });
    expect(r).toEqual({ deleted: 0, freedBytes: 0, failed: 1 });
    expect(left).toHaveLength(1);
  });

  it("counts a store that cannot size a file by its row, skips a running row and needs no store for a file already expired", async () => {
    const deleted: string[] = [];
    const store = { kind: "s3", delete: async (k: string) => void deleted.push(k) };
    const { db, left } = fakeDb([row("a", "k1"), row("b", "k2", { status: "running" }), row("c", "k3", { expiredAt: new Date() })]);
    const r = await deleteOrphanedBackups({ db, storeFor: async () => ({ store, prefix: "", destinationId: "d", type: "s3" }) as never }, "job", { sourceAppId: APP });
    expect(r).toEqual({ deleted: 2, freedBytes: 999, failed: 0 });
    expect(deleted).toEqual(["k1"]);
    expect(left.map((x) => x.id)).toEqual(["b"]);
  });

  it("refuses an app that still exists and a payload it cannot trust", async () => {
    const deps = (appExists: boolean) => ({ db: fakeDb([], appExists).db, storeFor: async () => { throw new Error("no store"); } });
    await expect(deleteOrphanedBackups(deps(true), "job", { sourceAppId: APP })).rejects.toThrow(/still exists/);
    await expect(deleteOrphanedBackups(deps(false), "job", { sourceAppId: "../etc" })).rejects.toThrow(/no valid sourceAppId/);
  });

  it("a key that climbs out of the backup folder is refused by the store and keeps its row", async () => {
    const root = await mkdtemp(join(tmpdir(), "dk-orphans-"));
    try {
      const store = new LocalStore(root);
      const { db, left } = fakeDb([row("a", "../outside.dkbk")]);
      const r = await deleteOrphanedBackups({ db, storeFor: async () => ({ store, prefix: "", destinationId: null, type: "local" }) }, "job", { sourceAppId: APP });
      expect(r.failed).toBe(1);
      expect(left).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never selects Dockify's own update dumps, which share one fixed source id", async () => {
    let where: unknown;
    const db = {
      app: { findUnique: async () => null },
      backup: { findMany: async (a: { where: unknown }) => ((where = a.where), []), deleteMany: async () => ({ count: 0 }) },
      job: { update: async () => undefined },
    } as unknown as Db;
    await deleteOrphanedBackups({ db, storeFor: async () => { throw new Error("no store needed"); } }, "job", { sourceAppId: APP });
    expect(where).toMatchObject({ kind: { not: "control_plane" } });
  });
});
