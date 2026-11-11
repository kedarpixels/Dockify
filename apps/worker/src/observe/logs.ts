/** Lines are redacted before they are stored. A batch that cannot be written is dropped. */
import { link as L } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import { DockerError, isNotFound } from "@dockify/engine";
import type { DockerReader } from "./docker.ts";
import { clean, Demuxer, guessLevel, LineSplitter, splitTimestamp, type LogLevel, type LogStream } from "./logparse.ts";
import { Redactor } from "@dockify/redact";
import type { SamplerState } from "./sampler.ts";

export interface LogRow {
  appId: string;
  ts: Date;
  stream: LogStream;
  level: LogLevel | null;
  text: string;
}

const FLUSH_MS = 1_000;
const MAX_BATCH = 1_000;
/** Per app, per wall-clock second. */
export const MAX_LINES_PER_SEC = 300;
export const MAX_BYTES_PER_SEC = 256 * 1024;
/** Per app, per UTC day: with 7 days of retention one app holds at most about 7 GiB. */
export const MAX_BYTES_PER_DAY = 1024 ** 3;
export const RUNTIME_MAX_LINE = 4 * 1024;
const RETENTION_BATCH = 10_000;

type DropReason = "lines" | "bytes" | "day";

interface Window {
  sec: number;
  lines: number;
  bytes: number;
  day: number;
  dayBytes: number;
  dropped: number;
  reason: DropReason | null;
}

export interface BudgetLimits {
  linesPerSec: number;
  bytesPerSec: number;
  bytesPerDay: number;
}

/**
 * Windows roll on the wall clock, never on a flush, so a size-triggered flush cannot reset what an app
 * has spent. Every container of one app shares that app's budget.
 */
export class LogBudget {
  private readonly apps = new Map<string, Window>();
  private readonly limits: BudgetLimits;
  constructor(limits: BudgetLimits = { linesPerSec: MAX_LINES_PER_SEC, bytesPerSec: MAX_BYTES_PER_SEC, bytesPerDay: MAX_BYTES_PER_DAY }) {
    this.limits = limits;
  }

  admit(appId: string, bytes: number, nowMs: number): boolean {
    const sec = Math.floor(nowMs / 1000);
    const day = Math.floor(nowMs / 86_400_000);
    let w = this.apps.get(appId);
    if (!w) {
      w = { sec, lines: 0, bytes: 0, day, dayBytes: 0, dropped: 0, reason: null };
      this.apps.set(appId, w);
    }
    if (w.sec !== sec) {
      w.sec = sec;
      w.lines = 0;
      w.bytes = 0;
    }
    if (w.day !== day) {
      w.day = day;
      w.dayBytes = 0;
    }
    const l = this.limits;
    const over: DropReason | null =
      w.dayBytes + bytes > l.bytesPerDay ? "day" : w.lines >= l.linesPerSec ? "lines" : w.bytes + bytes > l.bytesPerSec ? "bytes" : null;
    if (over) {
      w.dropped++;
      w.reason = over;
      return false;
    }
    w.lines++;
    w.bytes += bytes;
    w.dayBytes += bytes;
    return true;
  }

  /** Resets only the dropped counters. */
  takeDropped(): Array<{ appId: string; dropped: number; reason: DropReason }> {
    const out: Array<{ appId: string; dropped: number; reason: DropReason }> = [];
    for (const [appId, w] of this.apps) {
      if (w.dropped > 0) out.push({ appId, dropped: w.dropped, reason: w.reason ?? "lines" });
      w.dropped = 0;
      w.reason = null;
    }
    return out;
  }
}

export function droppedMarker(d: { dropped: number; reason: DropReason }): string {
  const why =
    d.reason === "day" ? `over ${Math.round(MAX_BYTES_PER_DAY / 1024 ** 2)} MiB today`
    : d.reason === "bytes" ? `over ${MAX_BYTES_PER_SEC / 1024} KiB per second`
    : `over ${MAX_LINES_PER_SEC} lines per second`;
  return `[dockify] ${d.dropped} lines dropped: ${why}`;
}

export async function insertLogRows(db: Db, rows: LogRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.$executeRaw`
    INSERT INTO runtime_log_lines ("appId", ts, stream, level, text)
    SELECT * FROM unnest(
      ${rows.map((r) => r.appId)}::uuid[],
      ${rows.map((r) => r.ts)}::timestamptz[],
      ${rows.map((r) => r.stream)}::text[]::"LogStream"[],
      ${rows.map((r) => r.level)}::text[]::"LogLevel"[],
      ${rows.map((r) => r.text)}::text[])`;
}

/**
 * A line of an app deleted meanwhile fails the foreign key for the whole batch, so such lines go first
 * (a refused insert prints a Prisma error even when handled), and once more if a delete wins the race.
 */
export async function insertLiveLogRows(db: Db, rows: LogRow[]): Promise<void> {
  const onlyLive = async (list: LogRow[]) => {
    const live = new Set((await db.app.findMany({ where: { id: { in: [...new Set(list.map((r) => r.appId))] } }, select: { id: true } })).map((a) => a.id));
    return list.filter((r) => live.has(r.appId));
  };
  const left = await onlyLive(rows);
  try {
    await insertLogRows(db, left);
  } catch (e) {
    if (!(e as Error).message?.includes("23503")) throw e;
    await insertLogRows(db, await onlyLive(left));
  }
}

export interface LogCaps {
  /** Total size budget for runtime_log_lines, in bytes (table, indexes and toast). */
  maxTableBytes: number;
  maxRowsPerApp: number;
}

/**
 * Postgres does not give space back on DELETE, so the relation size is scaled by the live fraction:
 * rows already deleted are reusable space, not a reason to delete more.
 */
export function rowsToShed(s: { totalBytes: number; liveRows: number; deadRows: number }, maxBytes: number): number {
  const rows = s.liveRows + s.deadRows;
  if (s.liveRows <= 0 || rows <= 0) return 0;
  const perRow = s.totalBytes / rows;
  const liveBytes = perRow * s.liveRows;
  if (liveBytes <= maxBytes) return 0;
  // Down to 90 percent of the budget, so the next pass is not over again at once.
  return Math.min(s.liveRows, Math.ceil((liveBytes - maxBytes * 0.9) / Math.max(1, perRow)));
}

export function planShed(counts: Array<{ appId: string; rows: number }>, caps: Pick<LogCaps, "maxRowsPerApp">, overBudgetRows: number): Map<string, number> {
  const plan = new Map<string, number>();
  const left = new Map<string, number>();
  for (const c of counts) {
    const over = Math.max(0, c.rows - caps.maxRowsPerApp);
    if (over) plan.set(c.appId, over);
    left.set(c.appId, c.rows - over);
  }
  let need = overBudgetRows - [...plan.values()].reduce((a, b) => a + b, 0);
  for (const c of [...counts].sort((a, b) => b.rows - a.rows)) {
    if (need <= 0) break;
    const take = Math.min(need, left.get(c.appId) ?? 0);
    if (take > 0) plan.set(c.appId, (plan.get(c.appId) ?? 0) + take);
    need -= take;
  }
  return plan;
}

async function shedOldest(db: Db, appId: string, rows: number): Promise<number> {
  let total = 0;
  while (total < rows) {
    const n = await db.$executeRaw`
      DELETE FROM runtime_log_lines WHERE id IN (
        SELECT id FROM runtime_log_lines WHERE "appId" = ${appId}::uuid ORDER BY id ASC LIMIT ${Math.min(RETENTION_BATCH, rows - total)})`;
    total += n;
    if (n === 0) break;
  }
  return total;
}

export async function enforceLogCaps(db: Db, caps: LogCaps): Promise<number> {
  const counts = (await db.$queryRaw<{ appId: string; n: bigint }[]>`
    SELECT "appId", count(*) AS n FROM runtime_log_lines GROUP BY "appId"`).map((c) => ({ appId: c.appId, rows: Number(c.n) }));
  const [stat] = await db.$queryRaw<{ total: bigint; live: bigint; dead: bigint }[]>`
    SELECT pg_total_relation_size('runtime_log_lines') AS total,
      coalesce((SELECT n_live_tup FROM pg_stat_user_tables WHERE relname = 'runtime_log_lines'), 0) AS live,
      coalesce((SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'runtime_log_lines'), 0) AS dead`;
  const over = stat ? rowsToShed({ totalBytes: Number(stat.total), liveRows: Number(stat.live), deadRows: Number(stat.dead) }, caps.maxTableBytes) : 0;
  let shed = 0;
  for (const [appId, rows] of planShed(counts, caps, over)) shed += await shedOldest(db, appId, rows);
  return shed;
}

/** Read on every pass, so a change applies without a restart. */
export async function logRetentionDays(db: Db, fallback: number): Promise<number> {
  const row = await db.instance.findUnique({ where: { id: 1 }, select: { logRetentionDays: true } });
  const d = row?.logRetentionDays;
  return typeof d === "number" && Number.isInteger(d) && d >= 1 ? Math.min(365, d) : fallback;
}

export async function pruneLogs(db: Db, days: number, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - days * 86_400_000);
  let total = 0;
  for (;;) {
    const n = await db.$executeRaw`
      DELETE FROM runtime_log_lines WHERE id IN (SELECT id FROM runtime_log_lines WHERE ts < ${cutoff} LIMIT ${RETENTION_BATCH})`;
    total += n;
    if (n < RETENTION_BATCH) return total;
  }
}

export type SecretsFor = (appId: string) => Promise<string[]>;

/**
 * A container's variables cannot change while it lives, so its secrets are opened once, not on every
 * follow a crash loop restarts. The limit bounds how long a misread or since-edited value stays in use.
 */
export const SECRETS_TTL_MS = 60 * 60_000;

interface Follower {
  appId: string;
  stop: AbortController;
}

export interface LogCollector {
  sync(state: SamplerState): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export function createLogCollector(
  db: Db,
  docker: DockerReader,
  secretsFor: SecretsFor,
  log: (msg: string, extra?: object) => void,
): LogCollector {
  const followers = new Map<string, Follower>();
  /** By container. Only a non-empty read is kept: a failed read retries on the next follow. */
  const secrets = new Map<string, { at: number; values: string[] }>();
  const budget = new LogBudget();
  let pending: LogRow[] = [];
  let lastErrorAt = 0;

  async function secretsOf(appId: string, containerId: string): Promise<string[]> {
    const hit = secrets.get(containerId);
    if (hit && Date.now() - hit.at < SECRETS_TTL_MS) return hit.values;
    const values = await secretsFor(appId).catch(() => []);
    if (values.length) secrets.set(containerId, { at: Date.now(), values });
    else secrets.delete(containerId);
    return values;
  }

  async function start(appId: string, containerId: string): Promise<void> {
    const f: Follower = { appId, stop: new AbortController() };
    followers.set(containerId, f);
    const redactor = new Redactor().conceal(await secretsOf(appId, containerId));
    const rows = await db.$queryRaw<{ ts: Date | null }[]>`SELECT max(ts) AS ts FROM runtime_log_lines WHERE "appId" = ${appId}::uuid`
      .catch(() => [{ ts: null }]);
    const lastMs = rows[0]?.ts?.getTime() ?? Date.now() - 60_000;
    const demux = new Demuxer();
    const lines = new LineSplitter();
    try {
      const res = await docker.followLogs(containerId, lastMs / 1000, f.stop.signal);
      for await (const chunk of res) {
        for (const frame of demux.push(chunk as Buffer)) {
          for (const { stream, raw } of lines.push(frame)) {
            const { ms, text } = splitTimestamp(raw, Date.now());
            if (ms < lastMs) continue; // `since` has second granularity: skip what is already stored
            const cut = clean(text).slice(0, RUNTIME_MAX_LINE);
            if (!budget.admit(appId, Buffer.byteLength(cut, "utf8"), Date.now())) continue;
            const body = redactor.line(cut);
            pending.push({ appId, ts: new Date(ms), stream, level: guessLevel(body), text: body });
          }
        }
        if (pending.length >= MAX_BATCH) await flush();
      }
    } catch (e) {
      // A 404 is the container going away, a 409 is it being removed. Either ends a follow and says nothing new.
      const going = isNotFound(e) || (e instanceof DockerError && e.status === 409);
      if (!f.stop.signal.aborted && !going) log("logs: follow ended", { app: appId, error: (e as Error).message });
    } finally {
      if (followers.get(containerId) === f) followers.delete(containerId);
    }
  }

  async function flush(): Promise<void> {
    for (const d of budget.takeDropped()) {
      pending.push({ appId: d.appId, ts: new Date(), stream: "stderr", level: "warn", text: droppedMarker(d) });
    }
    const batch = pending;
    pending = [];
    for (let i = 0; i < batch.length; i += MAX_BATCH) {
      try {
        await insertLiveLogRows(db, batch.slice(i, i + MAX_BATCH));
      } catch (e) {
        if (Date.now() - lastErrorAt > 60_000) {
          lastErrorAt = Date.now();
          log("logs: write failed", { error: (e as Error).message });
        }
      }
    }
  }

  const timer = setInterval(() => void flush(), FLUSH_MS);
  timer.unref();

  return {
    async sync(state) {
      const want = new Map<string, string>();
      for (const [appId, a] of state.apps) if (a.state === "running" || a.state === "restarting") want.set(a.containerId, appId);
      for (const [cid, f] of followers) if (!want.has(cid)) f.stop.abort();
      // A container the listing no longer shows at all is gone, and its values with it.
      const present = new Set([...state.apps.values()].map((a) => a.containerId));
      for (const cid of secrets.keys()) if (!present.has(cid)) secrets.delete(cid);
      for (const [cid, appId] of want) {
        if (followers.has(cid)) continue;
        // Each follow is a stream of the link for as long as its container runs. Past the limit every other
        // Docker call would wait for one to end, so a server this full goes without some apps' live logs.
        if (followers.size >= L.LINK_LIMITS.logFollowsMax) {
          log("this server runs more apps than the link holds log follows for; some apps have no live logs", { max: L.LINK_LIMITS.logFollowsMax });
          break;
        }
        void start(appId, cid);
      }
    },
    flush,
    async close() {
      clearInterval(timer);
      for (const f of followers.values()) f.stop.abort();
      await flush();
    },
  };
}
