/**
 * The read-only data browser routes. The api checks the policy (admin; SQL and row contents need a step-up) and the
 * app, then relays to the worker's data channel, which alone can reach tenant networks. Every SQL
 * run and every rows read is audited, since both return tenant data.
 */
import type { FastifyRequest } from "fastify";
import { internalChannelToken } from "@dockify/crypto";
import { assertProjectScope, type Actor } from "../../actor.ts";
import type { Ctx, Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError } from "../../errors.ts";

export type DataOp = "tables" | "rows" | "keys" | "query";

/** How the api reaches the worker. The default posts JSON; tests pass a fake. */
export interface DataChannel {
  call(op: DataOp, body: Record<string, unknown>, ctx: Ctx): Promise<unknown>;
}

const CHANNEL_TIMEOUT_MS = 25_000;

export function httpDataChannel(baseUrl: string | undefined = process.env.DOCKIFY_WORKER_CHANNEL_URL, fetchImpl: typeof fetch = fetch): DataChannel {
  return {
    async call(op, body, ctx) {
      if (!baseUrl) throw new HttpError(503, "The data browser is not connected to the worker on this server", "CHANNEL_UNAVAILABLE");
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/data/${op}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${internalChannelToken(ctx.ring)}` },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
        });
      } catch {
        throw new HttpError(503, "The worker did not answer", "CHANNEL_UNAVAILABLE");
      }
      const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) throw new HttpError(res.status === 401 ? 502 : res.status, json.error ?? "The data browser request failed", json.code ?? "CHANNEL_ERROR");
      return json;
    },
  };
}

async function loadApp(ctx: Ctx, actor: Actor | null, id: string, kind: "postgres" | "redis") {
  const app = await ctx.db.app.findUnique({ where: { id }, select: { id: true, name: true, kind: true, environment: { select: { projectId: true } } } });
  if (!app) throw new HttpError(404, "That app does not exist", "NOT_FOUND");
  if (actor) assertProjectScope(actor, app.environment.projectId);
  if (app.kind !== kind) throw new HttpError(400, `${app.name} is a ${app.kind} app; this view is for ${kind}`, "WRONG_KIND");
  return app;
}

/** Every read of tenant row data leaves an activity row naming what was read. */
async function auditRead(
  ctx: Ctx, actor: Actor | null, app: { id: string; name: string }, req: FastifyRequest,
  action: string, verb: string, suffix: string | null, failed: boolean,
): Promise<void> {
  await audit(ctx.db, {
    category: "access",
    action,
    verb,
    actorType: actor?.kind === "token" ? "token" : "user",
    actorId: actor?.kind === "token" ? actor.tokenId : (actor?.userId ?? null),
    actorName: actor?.name ?? null,
    targetType: "app",
    targetId: app.id,
    targetLabel: app.name,
    suffix,
    failed,
    ip: req.clientIp,
    userAgent: req.headers["user-agent"] ?? null,
  });
}

export function createDataHandlers(channel: DataChannel = httpDataChannel()): Handlers {
  return {
    "apps.data.tables": async ({ ctx, actor, params, req }) => {
      const app = await loadApp(ctx, actor, params.id, "postgres");
      let failed = false;
      try {
        return (await channel.call("tables", { appId: params.id }, ctx)) as never;
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        await auditRead(ctx, actor, app, req, "data.tables", "listed the tables of", null, failed);
      }
    },
    "apps.data.rows": async ({ ctx, actor, params, query, req }) => {
      const app = await loadApp(ctx, actor, params.id, "postgres");
      const limit = query.limit ?? 50;
      let failed = false;
      try {
        return (await channel.call("rows", { appId: params.id, table: query.table, limit }, ctx)) as never;
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        await auditRead(ctx, actor, app, req, "data.rows", "read rows from", `${query.table} (limit ${limit})`.slice(0, 300), failed);
      }
    },
    "apps.data.keys": async ({ ctx, actor, params, query, req }) => {
      const app = await loadApp(ctx, actor, params.id, "redis");
      const match = query.match || "*";
      let failed = false;
      try {
        return (await channel.call("keys", { appId: params.id, match, count: query.count ?? 100 }, ctx)) as never;
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        await auditRead(ctx, actor, app, req, "data.keys", "listed the keys of", `matching ${match}`.slice(0, 300), failed);
      }
    },
    "apps.data.query": async ({ ctx, actor, params, body, req }) => {
      const app = await loadApp(ctx, actor, params.id, "postgres");
      let failed = false;
      try {
        return (await channel.call("query", { appId: params.id, sql: body.sql }, ctx)) as never;
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        await auditRead(ctx, actor, app, req, "data.query", "ran a read-only query on", body.sql.slice(0, 300), failed);
      }
    },
  };
}

export const dataHandlers: Handlers = createDataHandlers();
