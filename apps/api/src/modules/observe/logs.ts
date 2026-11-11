// Runtime log reads. The worker writes lines already redacted. History pages newest to oldest by id; each page is returned oldest first.
import type { FastifyReply, FastifyRequest } from "fastify";
import { Prisma, type Db } from "@dockify/db";
import { enforce, type Actor } from "../../actor.ts";
import type { Ctx } from "../../app.ts";
import { forbidden, HttpError } from "../../errors.ts";
import { POLICIES } from "../../policy.ts";
import { levelsAtLeast, likePattern, parseLogCursor, type Level } from "./logic.ts";
import { notFound, projectLimit } from "./scope.ts";

export interface LogFilter {
  appIds: string[] | null;
  q?: string | undefined;
  regex?: boolean | undefined;
  stream?: "stdout" | "stderr" | undefined;
  level?: Level | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

interface Row {
  id: bigint;
  appId: string;
  ts: Date;
  stream: "stdout" | "stderr";
  level: Level | null;
  text: string;
}

export const PAGE = 200;
const STREAM_BATCH = 500;
const POLL_MS = 1_000;
const HEARTBEAT_MS = 15_000;
const REAUTH_MS = 60_000;
const MAX_STREAM_MS = 60 * 60_000;
const MAX_STREAMS_PER_USER = 4;
/** A history search: 5 s at most. A stream poll reads only new rows, so 1 s is plenty. */
const QUERY_TIMEOUT_MS = 5_000;
const POLL_TIMEOUT_MS = 1_000;
/** A stream whose poll fails this many times in a row ends instead of retrying forever. */
const MAX_POLL_FAILURES = 3;
/** A text search over every app must name a window no longer than this. */
export const MAX_SEARCH_WINDOW_MS = 24 * 3600_000;
const MAX_SEARCHES_PER_USER = 2;
const MAX_SEARCHES_TOTAL = 6;

export function whereSql(f: LogFilter, extra: Prisma.Sql[] = []): Prisma.Sql {
  const parts: Prisma.Sql[] = [...extra];
  if (f.appIds) parts.push(Prisma.sql`"appId" = ANY(${f.appIds}::uuid[])`);
  if (f.stream) parts.push(Prisma.sql`stream = ${f.stream}::"LogStream"`);
  if (f.level) parts.push(Prisma.sql`level = ANY(${levelsAtLeast(f.level)}::"LogLevel"[])`);
  if (f.from) parts.push(Prisma.sql`ts >= ${f.from}`);
  if (f.to) parts.push(Prisma.sql`ts < ${f.to}`);
  if (f.q) parts.push(f.regex ? Prisma.sql`text ~* ${f.q}` : Prisma.sql`text ILIKE ${likePattern(f.q)}`);
  return parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, " AND ")}` : Prisma.empty;
}

const toLine = (r: Row) => ({ id: r.id.toString(), ts: r.ts.toISOString(), appId: r.appId, stream: r.stream, level: r.level, text: r.text });

/** Postgres refusals of a user pattern become a 400, not a 500. */
function mapSqlError(e: unknown): never {
  const meta = (e as { meta?: { code?: string } }).meta;
  const msg = String((e as Error).message ?? "");
  if (meta?.code === "2201B" || /invalid regular expression/i.test(msg)) {
    throw new HttpError(400, "That regular expression is not valid", "INVALID_REQUEST", { field: "q" });
  }
  if (meta?.code === "57014" || /statement timeout/i.test(msg)) {
    throw new HttpError(400, "That search took too long. Narrow it with an app or a time range.", "QUERY_TIMEOUT", { field: "q" });
  }
  throw e;
}

async function select(db: Db, sql: Prisma.Sql, timeoutMs = QUERY_TIMEOUT_MS): Promise<Row[]> {
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${Math.max(100, Math.floor(timeoutMs))}`);
      return tx.$queryRaw<Row[]>(sql);
    });
  } catch (e) {
    return mapSqlError(e);
  }
}

export async function scopeApps(db: Db, actor: Actor | null, requested: string[] | undefined): Promise<string[] | null> {
  const limit = projectLimit(actor);
  if (requested && requested.length > 0) {
    const rows = await db.app.findMany({ where: { id: { in: requested } }, select: { id: true, environment: { select: { projectId: true } } } });
    if (rows.length !== new Set(requested).size) throw notFound();
    if (limit && rows.some((r) => !limit.includes(r.environment.projectId))) throw forbidden("This API token is limited to other projects");
    return rows.map((r) => r.id);
  }
  if (!limit) return null;
  const rows = await db.app.findMany({ where: { environment: { projectId: { in: limit } } }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** A text search with no app named scans the whole table, so its window is capped; with none given it covers the latest one. */
export function boundSearch(f: LogFilter, appsNamed: boolean, now = new Date()): LogFilter {
  if (!f.q || appsNamed) return f;
  const to = f.to ?? now;
  const from = f.from ?? new Date(to.getTime() - MAX_SEARCH_WINDOW_MS);
  if (to.getTime() - from.getTime() > MAX_SEARCH_WINDOW_MS) {
    throw new HttpError(400, "Search across all apps covers at most 24 hours. Pick an app or a shorter range.", "INVALID_REQUEST", { field: "from" });
  }
  return { ...f, from, to };
}

const searches = new Map<string, number>();
let searchesTotal = 0;

/** Runs a history search inside a per-user and a global slot, so searches cannot hold the pool. */
export async function withSearchSlot<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const n = searches.get(userId) ?? 0;
  if (n >= MAX_SEARCHES_PER_USER || searchesTotal >= MAX_SEARCHES_TOTAL) {
    throw new HttpError(429, "Too many log searches at once. Try again shortly.", "TOO_MANY_SEARCHES");
  }
  searches.set(userId, n + 1);
  searchesTotal++;
  try {
    return await fn();
  } finally {
    searchesTotal--;
    const left = (searches.get(userId) ?? 1) - 1;
    if (left <= 0) searches.delete(userId);
    else searches.set(userId, left);
  }
}

export async function queryLogs(db: Db, f: LogFilter, cursor: string | undefined) {
  if (f.appIds && f.appIds.length === 0) return { lines: [], nextCursor: null };
  const before = parseLogCursor(cursor);
  const rows = await select(db, Prisma.sql`
    SELECT id, "appId", ts, stream, level, text FROM runtime_log_lines
    ${whereSql(f, before !== null ? [Prisma.sql`id < ${before}`] : [])}
    ORDER BY id DESC LIMIT ${PAGE}`);
  const last = rows[rows.length - 1];
  return { lines: rows.reverse().map(toLine), nextCursor: rows.length === PAGE && last ? last.id.toString() : null };
}

export async function tailApp(db: Db, appId: string, tail: number) {
  const rows = await select(db, Prisma.sql`
    SELECT id, "appId", ts, stream, level, text FROM runtime_log_lines
    WHERE "appId" = ${appId}::uuid ORDER BY id DESC LIMIT ${tail}`);
  return { lines: rows.reverse().map((r) => ({ at: r.ts.toISOString(), stream: r.stream, text: r.text })) };
}

const open = new Map<string, number>();

async function send(reply: FastifyReply, frame: string): Promise<boolean> {
  const raw = reply.raw;
  if (raw.destroyed || raw.writableEnded) return false;
  if (raw.write(frame)) return true;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 10_000);
    raw.once("drain", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

export const sseFrame = (event: string, data: unknown, id?: string): string =>
  `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export async function streamLogs(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, f: LogFilter, since: string | undefined): Promise<void> {
  const actor = req.actor;
  if (!actor) throw new HttpError(401, "Sign in to continue", "UNAUTHENTICATED");
  const key = actor.userId;
  if ((open.get(key) ?? 0) >= MAX_STREAMS_PER_USER) throw new HttpError(429, "Too many open log streams", "TOO_MANY_STREAMS");

  // A bad pattern answers 400 here, before the stream opens, instead of failing every poll.
  if (f.q && f.regex) await select(ctx.db, Prisma.sql`SELECT '' ~* ${f.q} AS ok`);

  // Everything that ends the stream is wired before the next await, so a client that leaves
  // during the handshake still releases its slot.
  let closed = false;
  const stop = (): void => {
    if (closed) return;
    closed = true;
    open.set(key, Math.max(0, (open.get(key) ?? 1) - 1));
    if (!reply.raw.writableEnded) reply.raw.end();
  };
  open.set(key, (open.get(key) ?? 0) + 1);
  reply.raw.on("close", stop);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
    connection: "keep-alive",
  });

  const header = req.headers["last-event-id"];
  const resume = typeof since === "string" ? since : typeof header === "string" ? header : undefined;
  const maxId = async (): Promise<bigint | null> => {
    const [m] = await ctx.db.$queryRaw<{ id: bigint | null }[]>`SELECT max(id) AS id FROM runtime_log_lines`.catch(() => [{ id: null }]);
    return m?.id ?? null;
  };
  let lastId = 0n;
  if (resume && /^\d{1,19}$/.test(resume)) {
    lastId = BigInt(resume);
  } else {
    lastId = (await maxId()) ?? 0n;
  }
  let failures = 0;

  const started = Date.now();
  let lastBeat = started;
  let lastAuth = started;
  try {
    await send(reply, "retry: 3000\n\n");
    while (!closed) {
      const now = Date.now();
      if (now - started > MAX_STREAM_MS) {
        await send(reply, sseFrame("end", { reason: "max_duration" }));
        break;
      }
      if (now - lastAuth > REAUTH_MS) {
        lastAuth = now;
        try {
          await enforce(ctx.db, req, ctx.web, POLICIES["logs.stream"]);
        } catch {
          await send(reply, sseFrame("end", { reason: "unauthorized" }));
          break;
        }
      }
      if (!f.appIds || f.appIds.length > 0) {
        // Each poll scans only the rows written since the last one (up to a high-water mark taken
        // first), so a pattern that never matches cannot rescan the table every second.
        const high = await maxId();
        let rows: Row[] = [];
        if (high !== null && high > lastId) {
          try {
            rows = await select(ctx.db, Prisma.sql`
              SELECT id, "appId", ts, stream, level, text FROM runtime_log_lines
              ${whereSql(f, [Prisma.sql`id > ${lastId}`, Prisma.sql`id <= ${high}`])}
              ORDER BY id ASC LIMIT ${STREAM_BATCH}`, POLL_TIMEOUT_MS);
            failures = 0;
          } catch {
            if (++failures >= MAX_POLL_FAILURES) {
              await send(reply, sseFrame("end", { reason: "too_slow" }));
              break;
            }
            rows = [];
          }
          for (const r of rows) {
            if (!(await send(reply, sseFrame("line", toLine(r), r.id.toString())))) return;
            lastId = r.id;
          }
          if (rows.length === STREAM_BATCH) continue;
          if (failures === 0) lastId = high;
        }
      }
      if (now - lastBeat > HEARTBEAT_MS) {
        lastBeat = now;
        if (!(await send(reply, ": ping\n\n"))) break;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  } finally {
    stop();
  }
}
