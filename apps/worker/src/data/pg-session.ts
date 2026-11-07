/**
 * The data browser's PgSession over node-postgres. Rows come back as arrays (rowMode "array") and
 * every value as its text form, so the browser formats cells itself and never trusts a driver
 * parser with tenant data. A query without values goes over the simple protocol, which is what
 * the multi-statement role setup needs.
 */
import type { Duplex } from "node:stream";
import pg from "pg";
import type { PgResult, PgSession } from "./browser.ts";

interface PgRaw {
  fields?: Array<{ name: string; dataTypeID: number }>;
  rows?: unknown[];
}

const CONNECT_TIMEOUT_MS = 5_000;

export interface PgTarget {
  user: string;
  password: string;
  database: string;
}

/** Every type parses to its text form (or null). */
export const textTypes = { getTypeParser: () => (v: string) => v } as unknown as pg.CustomTypesConfig;

/** node-postgres answers text with several statements (ENSURE_ROLE_SQL) with one result per statement. The last one speaks for the text. */
export function pgResult(raw: PgRaw | PgRaw[]): PgResult {
  const r = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  return { fields: (r?.fields ?? []).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: (r?.rows ?? []) as unknown[][] };
}

/**
 * What node-postgres wants of a stream it was handed, around one that is already connected: it calls
 * setNoDelay and connect on it and then waits for its connect event. Those three are answered here;
 * everything else is the real stream, so a write, an end or a destroy reaches it as itself.
 */
export function connectedStream(stream: Duplex): Duplex {
  const adapter: Duplex = new Proxy(stream, {
    get(target, key) {
      if (key === "connect" || key === "setNoDelay" || key === "setKeepAlive") return () => adapter;
      if (key === "once") {
        return (event: string, listener: (...args: unknown[]) => void) => {
          if (event === "connect") setImmediate(listener);
          else target.once(event, listener);
          return adapter;
        };
      }
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return adapter;
}

export async function connectPg(stream: Duplex, t: PgTarget): Promise<PgSession> {
  const client = new pg.Client({
    stream: () => connectedStream(stream),
    user: t.user,
    password: t.password,
    database: t.database,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: "dockify-data-browser",
    types: textTypes,
  });
  // A session that could not be made leaves no connection behind (it may be holding a network).
  await client.connect().catch((e: unknown) => {
    stream.destroy();
    throw e;
  });
  return {
    async query(text: string, values?: unknown[]): Promise<PgResult> {
      return pgResult(await client.query({ text, values, rowMode: "array" }));
    },
    async close() {
      await client.end().catch(() => {});
    },
  };
}
