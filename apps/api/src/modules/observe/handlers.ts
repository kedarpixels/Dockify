import type { Ctx, Handlers } from "../../app.ts";
import { tokenProjectLimit } from "../../actor.ts";
import { HttpError } from "../../errors.ts";
import { alertsPayload, createRule, deleteMute, deleteRule, patchRule, putMute, type Caller } from "./alerts.ts";
import { boundSearch, queryLogs, scopeApps, streamLogs, tailApp, withSearchSlot, type LogFilter } from "./logs.ts";
import { withLogReadSlot } from "../deployments/handlers.ts";
import { vercelRuntimeTail } from "../integrations/vercel.ts";
import { viewerLeft } from "../integrations/vercel-logs.ts";
import { appMetrics } from "./metrics.ts";
import { overview } from "./overview.ts";
import { loadApp } from "./scope.ts";
import { CACHE_MS, publicStatus, statusPageGet, statusPagePatch } from "./status.ts";

const caller = (input: { actor: Caller["actor"]; req: { clientIp: string; headers: Record<string, unknown> } }): Caller => ({
  actor: input.actor,
  ip: input.req.clientIp,
  ua: typeof input.req.headers["user-agent"] === "string" ? input.req.headers["user-agent"] : undefined,
});

const date = (v: string | undefined, field: string): Date | undefined => {
  if (v === undefined) return undefined;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new HttpError(400, "Not a valid time", "INVALID_REQUEST", { field });
  return new Date(ms);
};

type ObserveIds =
  | "overview.get" | "apps.metrics" | "apps.logs" | "logs.query" | "logs.stream"
  | "alerts.get" | "alerts.rules.create" | "alerts.rules.patch" | "alerts.rules.delete" | "alerts.mutes.put" | "alerts.mutes.delete"
  | "public.status" | "statusPage.get" | "statusPage.patch";

/** An app Vercel hosts writes nothing to this server's log table: its tail is read from Vercel. */
async function vercelAppTail(db: Ctx["db"], ring: Ctx["ring"], appId: string, tail: number, signal?: AbortSignal) {
  const app = await db.app.findUnique({ where: { id: appId }, select: { deployTarget: true } });
  if (app?.deployTarget !== "vercel") return null;
  const out = await vercelRuntimeTail(db, ring, appId, undefined, Math.min(tail, 256), signal);
  return { lines: out.lines.map((l) => ({ at: l.ts, stream: l.stream, text: l.text })), source: "vercel" as const, retention: out.retention };
}

export const observeHandlers = {
  "overview.get": async ({ ctx, actor }) => overview(ctx.db, actor),

  "apps.metrics": async ({ ctx, actor, params, query }) => {
    const app = await loadApp(ctx.db, actor, params.id);
    return appMetrics(ctx.db, app, query.range ?? "1h");
  },

  "apps.logs": async ({ ctx, actor, params, query, reply }) => {
    const left = viewerLeft(reply);
    await loadApp(ctx.db, actor, params.id);
    const remote = await withLogReadSlot(actor?.userId ?? "anonymous", () => vercelAppTail(ctx.db, ctx.ring, params.id, query.tail ?? 200, left));
    return remote ?? tailApp(ctx.db, params.id, query.tail ?? 200);
  },

  "logs.query": async ({ ctx, actor, query }) => {
    const filter: LogFilter = {
      appIds: await scopeApps(ctx.db, actor, query.apps),
      q: query.q, regex: query.regex === "1", stream: query.stream, level: query.level,
      from: date(query.from, "from"), to: date(query.to, "to"),
    };
    const bounded = boundSearch(filter, !!query.apps?.length);
    return withSearchSlot(actor?.userId ?? "anonymous", () => queryLogs(ctx.db, bounded, query.cursor));
  },

  "logs.stream": async ({ ctx, actor, query, req, reply }) => {
    const filter: LogFilter = {
      appIds: await scopeApps(ctx.db, actor, query.apps),
      q: query.q, regex: query.regex === "1", stream: query.stream, level: query.level,
    };
    await streamLogs(ctx, req, reply, filter, query.since);
    return undefined;
  },

  "alerts.get": async ({ ctx, actor }) => alertsPayload(ctx.db, Date.now(), tokenProjectLimit(actor)),
  "alerts.rules.create": async (i) => createRule(i.ctx.db, i.body, caller(i)),
  "alerts.rules.patch": async (i) => patchRule(i.ctx.db, i.params.id, i.body, caller(i)),
  "alerts.rules.delete": async (i) => {
    await deleteRule(i.ctx.db, i.params.id, caller(i));
    return undefined;
  },
  "alerts.mutes.put": async (i) => putMute(i.ctx.db, i.params.appId, i.body.hours, caller(i)),
  "alerts.mutes.delete": async (i) => {
    await deleteMute(i.ctx.db, i.params.appId, caller(i));
    return undefined;
  },

  "public.status": async ({ ctx, params, reply }) => {
    const out = await publicStatus(ctx.db, params.slug);
    // Overrides the api-wide no-store: this payload is public and identical for every viewer.
    void reply.header("Cache-Control", `public, max-age=${CACHE_MS / 1000}`);
    return out;
  },
  "statusPage.get": async ({ ctx, actor, params }) => statusPageGet(ctx.db, actor, params.slug),
  "statusPage.patch": async (i) => statusPagePatch(i.ctx.db, i.actor, i.params.slug, i.body, caller(i).ip, caller(i).ua),
} satisfies Pick<Required<Handlers>, ObserveIds>;
