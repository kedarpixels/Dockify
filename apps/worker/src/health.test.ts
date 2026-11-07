import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { checkWritable, type Logger } from "./boot.ts";
import { isPermanentError } from "./errors.ts";
import { checkWorkFolder, heartbeat, needsWorkFolder, WORK_FOLDER_ISSUE, WorkerHealth } from "./health.ts";
import type { ClaimedJob } from "./queue.ts";

const BACKUP = "11111111-1111-4111-8111-111111111111";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "worker-health-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const logger = () => {
  const lines: Array<[string, string]> = [];
  const at = (l: string) => (m: string) => void lines.push([l, m]);
  return { log: { info: at("info"), warn: at("warn"), error: at("error") } as Logger, lines };
};

/** A file where the work folder should be: nothing can be made or written under it. */
async function blocked(): Promise<{ root: string; tmp: string; fix: () => Promise<void> }> {
  const root = join(dir, "work");
  await writeFile(root, "a file where the folder should be");
  return { root, tmp: join(root, "tmp"), fix: () => rm(root, { force: true }) };
}

const job = (kind: string, payload: unknown = { backupId: BACKUP }): ClaimedJob => ({ id: "j1", kind, payload, attempts: 1, maxAttempts: 3 }) as unknown as ClaimedJob;
type Handler = (job: ClaimedJob, signal: AbortSignal) => Promise<void>;
const handler = (fn: () => void): Handler => async () => fn();

/** The rows a refused job settles. */
function fakeDb() {
  const writes: Array<{ table: string; where: unknown; data: Record<string, unknown> }> = [];
  const db = {
    backup: { updateMany: async (a: { where: unknown; data: Record<string, unknown> }) => (writes.push({ table: "backup", ...a }), { count: 1 }) },
    instance: { updateMany: async (a: { where: unknown; data: Record<string, unknown> }) => (writes.push({ table: "instance", ...a }), { count: 1 }) },
  } as unknown as Db;
  return { db, writes };
}

describe("the work folder check", () => {
  it("passes a folder this process can write, made if missing", async () => {
    expect(await checkWritable(join(dir, "work", "tmp"))).toBeNull();
  });

  it("reports a folder it cannot write as an issue, logged once, and clears it once the folder works", async () => {
    const b = await blocked();
    const health = new WorkerHealth();
    const { log, lines } = logger();
    expect(await checkWorkFolder({ health, dir: b.tmp, log })).not.toBeNull();
    expect(await checkWorkFolder({ health, dir: b.tmp, log })).not.toBeNull();
    const [issue] = health.list();
    expect(issue).toMatchObject({ key: WORK_FOLDER_ISSUE, summary: "cannot write its work folder; backups and restores fail" });
    expect(issue!.message).toMatch(new RegExp(`^The worker cannot write its work folder ${b.tmp.replace(/[\\.]/g, "\\$&")} \\(.+\\), where backups and restores stage their files\\. .*sudo bash install\\.sh --upgrade`));
    expect(Date.parse(issue!.since)).not.toBeNaN();
    // One error line for the state change, none for the same state again.
    expect(lines.filter(([l]) => l === "error")).toHaveLength(1);
    expect(lines[0]![1]).toMatch(/Until then those jobs fail at once; everything else runs\.$/);
    await b.fix();
    expect(await checkWorkFolder({ health, dir: b.tmp, log })).toBeNull();
    expect(health.list()).toEqual([]);
    expect(lines.at(-1)).toEqual(["info", `the work folder ${b.tmp} is writable again; backups and restores run`]);
    expect(await checkWorkFolder({ health, dir: b.tmp, log })).toBeNull();
    expect(lines).toHaveLength(2);
  });

  it("keeps the time an issue was first seen while it lasts", () => {
    const health = new WorkerHealth();
    expect(health.set("a", "s", "m", new Date(1_000))).toBe(true);
    expect(health.set("a", "s", "m", new Date(9_000))).toBe(false);
    expect(health.set("a", "s", "m2", new Date(9_000))).toBe(true);
    expect(health.list()).toEqual([{ key: "a", summary: "s", message: "m2", since: new Date(1_000).toISOString() }]);
  });
});

describe("the jobs that need the work folder", () => {
  it("fail at once and for good with one message, settling a backup's or a restore test's row", async () => {
    const b = await blocked();
    const { db, writes } = fakeDb();
    const health = new WorkerHealth();
    const ran: string[] = [];
    const inner = (kind: string) => handler(() => void ran.push(kind));
    const table = needsWorkFolder({ backup: inner("backup"), restore: inner("restore"), restore_test: inner("restore_test"), dns_check: inner("dns_check") }, { db, dir: b.tmp, health, log: logger().log });

    for (const kind of ["backup", "restore", "restore_test"] as const) {
      const e = await table[kind](job(kind, kind === "restore" ? { backupId: BACKUP, targetAppId: BACKUP, mode: "new" } : { backupId: BACKUP }), new AbortController().signal).then(() => null, (x: unknown) => x);
      expect(isPermanentError(e), kind).toBe(true);
      expect((e as Error).message, kind).toMatch(/^The worker cannot write its work folder .*install\.sh --upgrade/);
    }
    expect(ran).toEqual([]);
    // Only rows still running are touched, with the same message.
    expect(writes.map((w) => [w.table, w.where])).toEqual([
      ["backup", { id: BACKUP, status: "running" }],
      ["backup", { id: BACKUP, restoreTestStatus: "running" }],
    ]);
    expect(writes[0]!.data).toMatchObject({ status: "failed", error: expect.stringMatching(/^The worker cannot write its work folder/) });
    expect(writes[1]!.data).toMatchObject({ restoreTestStatus: "failed", restoreTestError: expect.stringMatching(/^The worker cannot write its work folder/) });
    expect(health.list().map((i) => i.key)).toEqual([WORK_FOLDER_ISSUE]);

    // Every other job runs as before.
    await table.dns_check(job("dns_check", {}), new AbortController().signal);
    expect(ran).toEqual(["dns_check"]);
  });

  it("run as before once the folder works, and clear the issue", async () => {
    const b = await blocked();
    const { db } = fakeDb();
    const health = new WorkerHealth();
    const ran: string[] = [];
    const table = needsWorkFolder({ backup: handler(() => void ran.push("backup")) }, { db, dir: b.tmp, health, log: logger().log });
    await expect(table.backup(job("backup"), new AbortController().signal)).rejects.toThrow(/work folder/);
    await b.fix();
    await table.backup(job("backup"), new AbortController().signal);
    expect(ran).toEqual(["backup"]);
    expect(health.list()).toEqual([]);
  });

  it("settle no row for a payload without a valid backup id", async () => {
    const b = await blocked();
    const { db, writes } = fakeDb();
    const table = needsWorkFolder({ backup: handler(() => {}) }, { db, dir: b.tmp, health: new WorkerHealth(), log: logger().log });
    await expect(table.backup(job("backup", { backupId: "x" }), new AbortController().signal)).rejects.toThrow(/work folder/);
    expect(writes).toEqual([]);
  });
});

describe("the heartbeat", () => {
  it("stamps liveness with the issues the worker has now, an empty list when none", async () => {
    const { db, writes } = fakeDb();
    const health = new WorkerHealth();
    const at = new Date(Date.UTC(2026, 10, 6, 12));
    await heartbeat(db, health, at);
    health.set(WORK_FOLDER_ISSUE, "cannot write its work folder; backups and restores fail", "The worker cannot write its work folder /w (EACCES).", at);
    await heartbeat(db, health, at);
    expect(writes).toEqual([
      { table: "instance", where: { id: 1 }, data: { workerSeenAt: at, workerIssues: [] } },
      { table: "instance", where: { id: 1 }, data: { workerSeenAt: at, workerIssues: [{ key: WORK_FOLDER_ISSUE, summary: "cannot write its work folder; backups and restores fail", message: "The worker cannot write its work folder /w (EACCES).", since: at.toISOString() }] } },
    ]);
  });

  it("is never held back by the work folder: start-up checks it and goes on", async () => {
    const main = await readFile(join(import.meta.dirname, "main.ts"), "utf8");
    expect(main).not.toMatch(/waitForWorkDir/);
    expect(main).toMatch(/await checkWorkFolder\(\{ health: shared\.health, dir: wired\.data\.tmpDir, log: logger \}\);\n\s+return \{ runtime, wired, primary \};/);
  });
});
