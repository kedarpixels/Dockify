/**
 * The read-only data browser: Postgres tables, rows and SQL; Redis keys with type and TTL.
 *
 * Postgres. Every call runs in BEGIN TRANSACTION READ ONLY with statement, lock and idle timeouts
 * set LOCAL, under SET LOCAL ROLE dockify_browser (pg_read_all_data only, not a superuser), and ends
 * in ROLLBACK. User SQL passes the lexer guard first and plain queries run through a cursor, so the
 * server stops at the row cap. Cells are clipped and the whole result has a size budget.
 *
 * The driver is injected (PgSession) so this file is testable without a database; the worker wires
 * it to node-postgres with rowMode "array" and text parsing.
 */
import type { RespValue, RedisConn } from "./resp.ts";
import { RespError } from "./resp.ts";
import { guardReadOnlySql, quoteQualified } from "./sql-guard.ts";

export interface PgField {
  name: string;
  dataTypeID: number;
}
export interface PgResult {
  fields: PgField[];
  rows: unknown[][];
}
export interface PgSession {
  query(text: string, values?: unknown[]): Promise<PgResult>;
  close(): Promise<void>;
}

export type Cell = string | number | boolean | null;
export interface Column {
  name: string;
  type: string;
  nullable?: boolean;
  primary?: boolean;
}

export const STATEMENT_TIMEOUT_MS = 15_000;
export const ROW_CAP = 1_000;
export const CELL_MAX = 16_384;
export const RESULT_MAX_CHARS = 4 * 1024 * 1024;
export const BROWSER_ROLE = "dockify_browser";

/**
 * Creates the browser role once per database. NOLOGIN: it is only ever entered with SET ROLE from
 * the owner's session, inside the read-only transaction.
 */
export const ENSURE_ROLE_SQL =
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${BROWSER_ROLE}') THEN CREATE ROLE ${BROWSER_ROLE} NOLOGIN; END IF; END $$; ` +
  `GRANT pg_read_all_data TO ${BROWSER_ROLE}; GRANT pg_read_all_stats TO ${BROWSER_ROLE}`;

export const READ_ONLY_PROLOGUE = [
  "BEGIN TRANSACTION READ ONLY",
  `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`,
  "SET LOCAL lock_timeout = 3000",
  "SET LOCAL idle_in_transaction_session_timeout = 30000",
  `SET LOCAL ROLE ${BROWSER_ROLE}`,
];

/** Runs `work` inside the read-only box and always rolls back. */
export async function readOnly<T>(pg: PgSession, work: () => Promise<T>): Promise<T> {
  await pg.query(ENSURE_ROLE_SQL);
  for (const s of READ_ONLY_PROLOGUE) await pg.query(s);
  try {
    return await work();
  } finally {
    await pg.query("ROLLBACK").catch(() => {});
  }
}

const NUMERIC_TYPES = new Set([20, 21, 23, 700, 701, 26]);
const BOOL = 16;

export function toCell(v: unknown, typeId: number): { cell: Cell; clipped: boolean } {
  if (v === null || v === undefined) return { cell: null, clipped: false };
  if (typeof v === "boolean") return { cell: v, clipped: false };
  if (typeId === BOOL && (v === "t" || v === "f")) return { cell: v === "t", clipped: false };
  if (typeof v === "number") return { cell: Number.isFinite(v) ? v : String(v), clipped: false };
  const s = typeof v === "string" ? v : Buffer.isBuffer(v) ? `\\x${v.toString("hex")}` : JSON.stringify(v);
  if (NUMERIC_TYPES.has(typeId) && /^-?\d{1,15}(\.\d+)?$/.test(s)) return { cell: Number(s), clipped: false };
  if (s.length > CELL_MAX) return { cell: s.slice(0, CELL_MAX), clipped: true };
  return { cell: s, clipped: false };
}

/** Applies the cell and size caps. The first row is always kept; anything dropped sets truncated. */
export function boundRows(rows: unknown[][], fields: PgField[], cap = ROW_CAP, budget = RESULT_MAX_CHARS): { rows: Cell[][]; truncated: boolean } {
  let truncated = rows.length > cap;
  const out: Cell[][] = [];
  let left = budget;
  for (const raw of rows.slice(0, cap)) {
    let size = 0;
    const row = raw.map((v, i) => {
      const { cell, clipped } = toCell(v, fields[i]?.dataTypeID ?? 0);
      if (clipped) truncated = true;
      size += cell === null ? 4 : String(cell).length;
      return cell;
    });
    if (out.length > 0 && size > left) {
      truncated = true;
      break;
    }
    out.push(row);
    left -= size;
  }
  return { rows: out, truncated };
}

async function typeNames(pg: PgSession, fields: PgField[]): Promise<Map<number, string>> {
  const ids = [...new Set(fields.map((f) => f.dataTypeID))];
  if (!ids.length) return new Map();
  const r = await pg.query("SELECT oid::int, format_type(oid, NULL) FROM pg_type WHERE oid = ANY($1::oid[])", [ids]);
  return new Map(r.rows.map((row) => [Number(row[0]), String(row[1])]));
}

export async function listTables(pg: PgSession): Promise<{ database: string; tables: Array<{ schema: string; name: string; rows: number; sizeBytes: number }> }> {
  return readOnly(pg, async () => {
    const db = await pg.query("SELECT current_database()");
    const r = await pg.query(
      "SELECT n.nspname, c.relname, greatest(c.reltuples, 0)::bigint, pg_total_relation_size(c.oid) " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' " +
        "ORDER BY n.nspname, c.relname LIMIT 2000",
    );
    return {
      database: String(db.rows[0]?.[0] ?? ""),
      tables: r.rows.map((row) => ({ schema: String(row[0]), name: String(row[1]), rows: Number(row[2]) || 0, sizeBytes: Number(row[3]) || 0 })),
    };
  });
}

export class BrowserError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = "BrowserError";
    this.status = status;
    this.code = code;
  }
}

const EXACT_COUNT_BELOW = 50_000;

export async function tableRows(pg: PgSession, table: string, limit = 50): Promise<{ table: string; columns: Column[]; rows: Cell[][]; total: number }> {
  const t = quoteQualified(table);
  return readOnly(pg, async () => {
    const cols = await pg.query(
      "SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, coalesce(bool_or(i.indisprimary), false), max(c.reltuples)::bigint " +
        "FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey) " +
        "WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped " +
        "GROUP BY a.attnum, a.attname, a.atttypid, a.atttypmod, a.attnotnull ORDER BY a.attnum",
      [t.schema, t.name],
    );
    if (!cols.rows.length) throw new BrowserError(404, `Table ${table} does not exist`, "NOT_FOUND");
    const columns: Column[] = cols.rows.map((r) => ({ name: String(r[0]), type: String(r[1]), nullable: r[2] === true || r[2] === "t", primary: r[3] === true || r[3] === "t" }));
    const n = Math.min(Math.max(1, Math.floor(limit)), 200);
    const data = await pg.query(`SELECT * FROM ${t.sql} LIMIT ${n}`);
    let total = Math.max(0, Number(cols.rows[0]?.[4]) || 0);
    if (total < EXACT_COUNT_BELOW) {
      const c = await pg.query(`SELECT count(*) FROM ${t.sql}`);
      total = Number(c.rows[0]?.[0]) || 0;
    }
    return { table, columns, rows: boundRows(data.rows, data.fields, n).rows, total };
  });
}

export async function runQuery(pg: PgSession, sql: string, now: () => number = Date.now): Promise<{ columns: Column[]; rows: Cell[][]; rowCount: number; durationMs: number; truncated: boolean }> {
  const g = guardReadOnlySql(sql);
  return readOnly(pg, async () => {
    const started = now();
    let result: PgResult;
    if (g.cursor) {
      await pg.query(`DECLARE dockify_browse NO SCROLL CURSOR FOR ${g.text}`);
      result = await pg.query(`FETCH FORWARD ${ROW_CAP + 1} FROM dockify_browse`);
    } else {
      result = await pg.query(g.text);
    }
    const durationMs = now() - started;
    const names = await typeNames(pg, result.fields);
    const bounded = boundRows(result.rows, result.fields);
    return {
      columns: result.fields.map((f) => ({ name: f.name, type: names.get(f.dataTypeID) ?? `oid ${f.dataTypeID}` })),
      rows: bounded.rows,
      rowCount: Math.min(result.rows.length, ROW_CAP),
      durationMs,
      truncated: bounded.truncated,
    };
  });
}

// -------------------------------------------------------------------------------------- redis

const KEY_TYPES = new Set(["string", "hash", "list", "set", "zset", "stream"]);
type KeyType = "string" | "hash" | "list" | "set" | "zset" | "stream";
const SCAN_ROUNDS = 50;

const asStr = (v: RespValue): string => {
  if (v instanceof RespError) throw new BrowserError(409, `Redis: ${v.message}`, "REDIS_ERROR");
  return typeof v === "string" ? v : String(v ?? "");
};

/** SCAN until `count` keys or the keyspace ends; never KEYS, which blocks the server. */
export async function scanKeys(r: RedisConn, match = "*", count = 100): Promise<{ keys: Array<{ key: string; type: KeyType; ttlSeconds: number | null; sizeBytes: number }>; total: number; truncated: boolean }> {
  const want = Math.min(Math.max(1, Math.floor(count)), 1000);
  const found: string[] = [];
  let cursor = "0";
  let rounds = 0;
  do {
    const reply = await r.command(["SCAN", cursor, "MATCH", match || "*", "COUNT", String(Math.max(want, 100))]);
    if (!Array.isArray(reply) || reply.length !== 2) throw new BrowserError(409, "Redis gave an unexpected SCAN reply", "REDIS_ERROR");
    cursor = asStr(reply[0]!);
    for (const k of (reply[1] as RespValue[]) ?? []) if (found.length < want) found.push(asStr(k));
  } while (cursor !== "0" && found.length < want && ++rounds < SCAN_ROUNDS);

  const keys: Array<{ key: string; type: KeyType; ttlSeconds: number | null; sizeBytes: number }> = [];
  for (const key of found) {
    const type = asStr(await r.command(["TYPE", key]));
    if (!KEY_TYPES.has(type)) continue;
    const pttl = await r.command(["PTTL", key]);
    const mem = await r.command(["MEMORY", "USAGE", key]);
    const ms = typeof pttl === "number" ? pttl : -1;
    keys.push({ key, type: type as KeyType, ttlSeconds: ms >= 0 ? Math.ceil(ms / 1000) : null, sizeBytes: typeof mem === "number" ? mem : 0 });
  }
  const size = await r.command(["DBSIZE"]);
  return { keys, total: typeof size === "number" ? size : keys.length, truncated: cursor !== "0" };
}
