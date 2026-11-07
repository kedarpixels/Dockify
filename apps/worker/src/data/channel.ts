/**
 * The api to worker channel for the data browser. The api never reaches tenant networks; the server's
 * dialer does, so browser calls are relayed: the api checks the policy, then POSTs here with the
 * internal channel token. This side re-checks everything that matters (the app exists, is the expected
 * kind, its container is ours by label and running) before dialing anything.
 *
 * Listen on the control-plane network only, never on a tenant network (a channel bound
 * to 0.0.0.0 was reachable from every environment the worker joined).
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { safeEqual } from "@dockify/crypto";
import type { Db } from "@dockify/db";
import type { Duplex } from "node:stream";
import type { Dialer, DialTarget } from "../server/runtime.ts";
import { BrowserError, listTables, runQuery, scanKeys, tableRows, type PgSession } from "./browser.ts";
import type { DockerPort } from "./docker-port.ts";
import { connectRedis, type RedisConn } from "./resp.ts";
import { containerNameFor, LABEL_APP, networkFor, SERVICE_PORTS, type ServiceCredentials } from "./services.ts";
import { SqlGuardError } from "./sql-guard.ts";

export interface ChannelDeps {
  db: Db;
  docker: DockerPort;
  token: string;
  credentials(appId: string): Promise<ServiceCredentials>;
  /** Takes the connection; it closes with the session, or when the session cannot be made. */
  connectPg(stream: Duplex, t: { user: string; password: string; database: string }): Promise<PgSession>;
  connectRedis?: typeof connectRedis;
  dial: Dialer;
}

/** How long a service gets to accept the connection: what each client gives its own connect. */
const CONNECT_TIMEOUT_MS = 5_000;

const MAX_BODY = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CHANNEL_OPS = ["tables", "rows", "keys", "query"] as const;
export type ChannelOp = (typeof CHANNEL_OPS)[number];

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new BrowserError(413, "Request too large", "TOO_LARGE");
    parts.push(c as Buffer);
  }
  const v = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}") as unknown;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new BrowserError(400, "Expected a JSON object", "INVALID_REQUEST");
  return v as Record<string, unknown>;
}

async function resolveTarget(deps: ChannelDeps, appId: string, kind: "postgres" | "redis"): Promise<{ to: DialTarget; creds: ServiceCredentials }> {
  const app = await deps.db.app.findUnique({ where: { id: appId }, select: { id: true, name: true, kind: true, environmentId: true } });
  if (!app) throw new BrowserError(404, "That app does not exist", "NOT_FOUND");
  if (app.kind !== kind) throw new BrowserError(400, `${app.name} is a ${app.kind} app; this view is for ${kind}`, "WRONG_KIND");
  const s = await deps.docker.inspect(containerNameFor(app.id));
  if (!s || s.labels[LABEL_APP] !== app.id || s.labels["dockify.managed"] !== "true") throw new BrowserError(409, `${app.name} has no Dockify managed container`, "NOT_RUNNING");
  if (!s.running) throw new BrowserError(409, `${app.name} is not running`, "NOT_RUNNING");
  const network = networkFor(app.environmentId);
  if (!s.addresses[network]) throw new BrowserError(409, `${app.name} has no address on its network`, "NOT_ROUTABLE");
  return { to: { container: containerNameFor(app.id), network, port: SERVICE_PORTS[kind] }, creds: await deps.credentials(app.id) };
}

export async function handleOp(deps: ChannelDeps, op: ChannelOp, body: Record<string, unknown>): Promise<unknown> {
  const appId = typeof body.appId === "string" && UUID.test(body.appId) ? body.appId : null;
  if (!appId) throw new BrowserError(400, "appId is required", "INVALID_REQUEST");
  if (op === "keys") {
    const t = await resolveTarget(deps, appId, "redis");
    const conn: RedisConn = await (deps.connectRedis ?? connectRedis)({ connect: (timeoutMs) => deps.dial(t.to, { timeoutMs }), user: t.creds.user, password: t.creds.password });
    try {
      const match = typeof body.match === "string" ? body.match.slice(0, 200) : "*";
      const count = typeof body.count === "number" ? body.count : 100;
      return await scanKeys(conn, match, count);
    } finally {
      conn.close();
    }
  }
  const t = await resolveTarget(deps, appId, "postgres");
  const pg = await deps.connectPg(await deps.dial(t.to, { timeoutMs: CONNECT_TIMEOUT_MS }), { user: t.creds.user, password: t.creds.password, database: t.creds.database ?? "postgres" });
  try {
    if (op === "tables") return await listTables(pg);
    if (op === "rows") {
      if (typeof body.table !== "string") throw new BrowserError(400, "table is required", "INVALID_REQUEST");
      return await tableRows(pg, body.table, typeof body.limit === "number" ? body.limit : 50);
    }
    if (typeof body.sql !== "string" || body.sql.length > 20_000) throw new BrowserError(400, "sql is required", "INVALID_REQUEST");
    return await runQuery(pg, body.sql);
  } finally {
    await pg.close().catch(() => {});
  }
}

const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE"]);
export function isConnectionError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && CONNECTION_CODES.has(code)) return true;
  return e instanceof Error && /Connection terminated|timeout expired|connection timeout/i.test(e.message);
}

/** Database errors carry the server's own message (syntax, missing column, timeout): safe to return. */
function failure(e: unknown): { status: number; body: { error: string; code: string } } {
  if (e instanceof BrowserError) return { status: e.status, body: { error: e.message, code: e.code } };
  if (e instanceof SqlGuardError) return { status: 400, body: { error: e.message, code: "QUERY_REFUSED" } };
  const msg = e instanceof Error ? e.message : String(e);
  if (e && typeof e === "object" && "severity" in e) return { status: 400, body: { error: msg.slice(0, 2000), code: "QUERY_FAILED" } };
  // Only a failure to talk to the database is called that. Anything else is this code's bug, and
  // reading it as an unreachable database sends the owner to look in the wrong place.
  if (isConnectionError(e)) return { status: 502, body: { error: `The database could not be reached: ${msg.slice(0, 300)}`, code: "DB_UNREACHABLE" } };
  return { status: 500, body: { error: `The data browser failed: ${msg.slice(0, 300)}`, code: "BROWSER_FAILED" } };
}

export function createDataChannel(deps: ChannelDeps): Server {
  return createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    void (async () => {
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), deps.token)) return send(401, { error: "Unauthorized", code: "UNAUTHENTICATED" });
      const m = /^\/data\/(tables|rows|keys|query)$/.exec(req.url ?? "");
      if (req.method !== "POST" || !m) return send(404, { error: "Not found", code: "NOT_FOUND" });
      try {
        send(200, await handleOp(deps, m[1] as ChannelOp, await readJson(req)));
      } catch (e) {
        const f = failure(e);
        send(f.status, f.body);
      }
    })();
  });
}
