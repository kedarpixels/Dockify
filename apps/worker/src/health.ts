/**
 * Problems that stop some of the worker's jobs while it keeps running, written to Instance.workerIssues by the
 * heartbeat. Today: a work folder it cannot write.
 */
import { open, utimes } from "node:fs/promises";
import type { Db } from "@dockify/db";
import { checkWritable, type Logger } from "./boot.ts";
import { settleBackupRow, settleRestoreTest } from "./data/handlers.ts";
import { PermanentJobError } from "./errors.ts";
import type { ClaimedJob } from "./queue.ts";

/** The contract's server.WorkerIssue, which the api parses back. A type alias, so it is a JSON value as it is. */
export type WorkerIssue = {
  key: string;
  summary: string;
  message: string;
  since: string;
};

export const WORK_FOLDER_ISSUE = "work_folder";
export const WORK_FOLDER_KINDS = ["backup", "restore", "restore_test"] as const;

export class WorkerHealth {
  readonly #issues = new Map<string, WorkerIssue>();

  /** Records an issue. True when it is new or its message changed: the caller logs only then. */
  set(key: string, summary: string, message: string, now = new Date()): boolean {
    const prev = this.#issues.get(key);
    this.#issues.set(key, { key, summary: summary.slice(0, 120), message: message.slice(0, 500), since: prev?.since ?? now.toISOString() });
    return prev?.message !== message.slice(0, 500);
  }

  clear(key: string): boolean {
    return this.#issues.delete(key);
  }

  list(): WorkerIssue[] {
    return [...this.#issues.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
}

export function workFolderMessage(dir: string, problem: string): string {
  return (
    `The worker cannot write its work folder ${dir} (${problem}), where backups and restores stage their files. ` +
    "The volume must belong to uid 1000: run `sudo bash install.sh --upgrade` on the server."
  );
}

const WORK_FOLDER_SUMMARY = "cannot write its work folder; backups and restores fail";

export interface WorkFolderCheck {
  health: WorkerHealth;
  dir: string;
  log: Logger;
  check?: (dir: string) => Promise<string | null>;
}

export async function checkWorkFolder(o: WorkFolderCheck): Promise<string | null> {
  const problem = await (o.check ?? checkWritable)(o.dir);
  if (problem === null) {
    if (o.health.clear(WORK_FOLDER_ISSUE)) o.log.info(`the work folder ${o.dir} is writable again; backups and restores run`);
    return null;
  }
  const message = workFolderMessage(o.dir, problem);
  if (o.health.set(WORK_FOLDER_ISSUE, WORK_FOLDER_SUMMARY, message)) o.log.error(`${message} Until then those jobs fail at once; everything else runs.`);
  return problem;
}

type Handler = (job: ClaimedJob, signal: AbortSignal) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const backupIdOf = (payload: unknown): string | null => {
  const v = (payload as Record<string, unknown> | null)?.backupId;
  return typeof v === "string" && UUID.test(v) ? v : null;
};

/**
 * Wraps the work folder's jobs with a check of the folder. One that cannot run fails permanently at once (no
 * retry fixes a folder's owner) and marks its backup or restore test row, so no row is left reading "running".
 */
export function needsWorkFolder<T extends Partial<Record<string, Handler>>>(table: T, o: WorkFolderCheck & { db: Db }): T {
  const out: Partial<Record<string, Handler>> = { ...table };
  for (const kind of WORK_FOLDER_KINDS) {
    const h = table[kind];
    if (!h) continue;
    out[kind] = async (job, signal) => {
      const problem = await checkWorkFolder(o);
      if (problem === null) return h(job, signal);
      const e = new PermanentJobError(workFolderMessage(o.dir, problem));
      const backupId = backupIdOf(job.payload);
      if (backupId && kind === "backup") await settleBackupRow(o.db, backupId, e).catch(() => {});
      if (backupId && kind === "restore_test") await settleRestoreTest(o.db, backupId, e).catch(() => {});
      throw e;
    };
  }
  return out as T;
}

/** The file the compose healthcheck reads; /tmp is the worker's tmpfs. */
export const ALIVE_FILE = "/tmp/dockify-worker-alive";
/** Four heartbeats (30 s apart) lost in a row, with the compose healthcheck's 3 minutes above this. */
export const BEAT_STALE_MS = 120_000;

/**
 * Fresh while starting, then only while heartbeats reach the database, which proves the event loop and the
 * connection both work. False makes Docker report unhealthy; the updater's watchdog does the restart.
 */
export function aliveNow(o: { booted: boolean; lastBeatMs: number | null; nowMs: number }): boolean {
  return !o.booted || o.lastBeatMs === null || o.nowMs - o.lastBeatMs < BEAT_STALE_MS;
}

export class AliveFile {
  readonly #path: string;
  #booted = false;
  #lastBeatMs: number | null = null;
  constructor(path = ALIVE_FILE) {
    this.#path = path;
  }
  booted(): void {
    this.#booted = true;
  }
  beat(nowMs = Date.now()): void {
    this.#lastBeatMs = nowMs;
  }
  async touch(nowMs = Date.now()): Promise<void> {
    if (!aliveNow({ booted: this.#booted, lastBeatMs: this.#lastBeatMs, nowMs })) return;
    try {
      await (await open(this.#path, "a")).close();
      const t = new Date();
      await utimes(this.#path, t, t);
    } catch {
      // Read-only or missing /tmp outside the compose stack.
    }
  }
}

export function heartbeat(db: Db, health: WorkerHealth, now = new Date()) {
  return db.instance.updateMany({ where: { id: 1 }, data: { workerSeenAt: now, workerIssues: health.list() } });
}
