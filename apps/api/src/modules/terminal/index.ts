/**
 * The terminal's two catalog routes. The ticket is an ordinary elevated POST. A plain GET on the socket's
 * path reaches the handler only when it did not ask to upgrade, and gets told so; the upgrade itself is
 * gateway.ts, on the http server's upgrade event.
 */
import type { Handlers } from "../../app.ts";
import { assertProjectScope, requireSession } from "../../actor.ts";
import { HttpError, rateLimited } from "../../errors.ts";
import { clientKey } from "./tickets.ts";

export const terminalHandlers: Handlers = {
  "apps.terminal.ticket": async ({ params, actor, req, reply, ctx }) => {
    const a = requireSession(actor);
    const wait = ctx.limits.terminalTicket.take(a.sessionId);
    if (wait !== null) throw rateLimited(reply, wait);
    const inst = await ctx.db.instance.findUnique({ where: { id: 1 }, select: { terminalEnabled: true } });
    if (!inst?.terminalEnabled) throw new HttpError(403, "The terminal is turned off for this server. An admin can turn it on in Settings, Instance.", "TERMINAL_DISABLED");
    const app = await ctx.db.app.findUnique({ where: { id: params.id }, select: { id: true, deployTarget: true, environment: { select: { projectId: true } } } });
    if (!app) throw new HttpError(404, "That app does not exist", "NOT_FOUND");
    assertProjectScope(a, app.environment.projectId);
    if (app.deployTarget !== "server") throw new HttpError(409, "This app runs on Vercel, so there is no container on this server to open", "NOT_ON_SERVER");
    if (!ctx.terminalTickets) throw new HttpError(503, "The terminal is not available", "CHANNEL_UNAVAILABLE");
    return ctx.terminalTickets.issue({ sessionId: a.sessionId, appId: app.id, client: clientKey(req.clientIp, req.headers["user-agent"]) });
  },

  "apps.terminal": async ({ reply }) => {
    void reply.header("Upgrade", "websocket");
    throw new HttpError(426, "This address is a WebSocket", "UPGRADE_REQUIRED");
  },
};
