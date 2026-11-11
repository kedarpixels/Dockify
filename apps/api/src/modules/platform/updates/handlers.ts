import { Prisma } from "@dockify/db";
import { audit } from "../../../audit.ts";
import { HttpError } from "../../../errors.ts";
import type { Handlers } from "../../../app.ts";
import { actorAudit, reqMeta, requireActor, type PlatformEnv } from "../shared.ts";
import { beginApply, beginRollback, UpdateRefused } from "./engine.ts";
import { isTimeZone } from "@dockify/contracts";
import { trustedKey, type Fetcher } from "./release.ts";
import { securityAlert, snoozeSecurity } from "./security.ts";
import { buildStatus, checkFeed, FeedError, toJob, type UpdateEnv } from "./state.ts";

export { storedFeed } from "./state.ts";

export const updateEnvOf = (env: PlatformEnv): UpdateEnv => ({
  version: env.version,
  feedBase: env.releaseFeedUrl,
  publicKey: trustedKey({ DOCKIFY_PINNED_PUBKEY: process.env.DOCKIFY_PINNED_PUBKEY, DOCKIFY_RELEASE_PUBKEY: env.releasePublicKey ?? undefined }),
});

const REFUSED_STATUS: Record<string, number> = { UPDATES_NOT_CONFIGURED: 409, UPDATE_SIGNATURE_INVALID: 502, UPDATE_FEED_UNREACHABLE: 502, UPDATE_FEED_REPLAY: 502 };

export function updateHandlers(env: PlatformEnv, get?: Fetcher): Handlers {
  const uenv = updateEnvOf(env);
  const refused = (e: unknown): never => {
    if (e instanceof UpdateRefused) throw new HttpError(409, e.message, e.code);
    throw e;
  };

  return {
    "server.updates": async ({ ctx }) => buildStatus(ctx.db, uenv),

    "server.updates.check": async ({ actor, req, ctx }) => {
      const a = requireActor(actor);
      try {
        const feed = await checkFeed(ctx.db, uenv, get);
        await audit(ctx.db, { category: "system", action: "update.check", verb: "checked for updates", suffix: `${feed.channel} feed, newest ${feed.releases[0]?.version ?? "none"}`, ...actorAudit(a), ...reqMeta(req) });
      } catch (e) {
        if (!(e instanceof FeedError)) throw e;
        await audit(ctx.db, { category: "system", action: "update.check", verb: "checked for updates", failed: true, suffix: e.message.slice(0, 300), ...actorAudit(a), ...reqMeta(req) });
        throw new HttpError(REFUSED_STATUS[e.code] ?? 502, e.message, e.code);
      }
      return buildStatus(ctx.db, uenv);
    },

    /** The updater re-fetches and re-verifies the feed and refuses if its hash differs from the one stored here. */
    "server.updates.apply": async ({ body, actor, req, ctx }) => {
      const a = requireActor(actor);
      if (!uenv.feedBase || !uenv.publicKey) throw new HttpError(409, "Updates are not configured: the installer writes DOCKIFY_RELEASE_FEED and DOCKIFY_RELEASE_PUBKEY", "UPDATES_NOT_CONFIGURED");
      const row = await ctx.db.$transaction(async (tx) => {
        const u = await beginApply(tx, uenv, { version: body.version, trigger: "manual", actorName: a.name }).catch(refused);
        await audit(tx, { category: "system", action: "update.apply", verb: "started the update to", targetType: "release", targetId: u.id, targetLabel: u.version, suffix: `from ${u.fromVersion}`, ...actorAudit(a), ...reqMeta(req) });
        return u;
      });
      return toJob(row);
    },

    "server.updates.rollback": async ({ body, actor, req, ctx }) => {
      const a = requireActor(actor);
      const row = await ctx.db.$transaction(async (tx) => {
        const u = await beginRollback(tx, uenv, { updateId: body.updateId, trigger: "manual", actorName: a.name }).catch(refused);
        await audit(tx, { category: "system", action: "update.rollback.start", verb: "started a rollback to", targetType: "release", targetId: u.id, targetLabel: u.version, suffix: `from ${u.fromVersion}`, ...actorAudit(a), ...reqMeta(req) });
        return u;
      });
      return toJob(row);
    },

    "server.updates.skip": async ({ body, actor, req, ctx }) => {
      const a = requireActor(actor);
      const version = body.version ? body.version.replace(/^v/, "") : null;
      await ctx.db.instance.update({ where: { id: 1 }, data: { updateSkipVersion: version } });
      await audit(ctx.db, { category: "config", action: "update.skip", verb: version ? "skipped the release" : "stopped skipping a release", targetType: "release", targetLabel: version, ...actorAudit(a), ...reqMeta(req) });
      return buildStatus(ctx.db, uenv);
    },

    "server.updates.pause": async ({ body, actor, req, ctx }) => {
      const a = requireActor(actor);
      const until = body.days ? new Date(Date.now() + body.days * 86_400_000) : null;
      await ctx.db.instance.update({ where: { id: 1 }, data: { updatePausedUntil: until } });
      await audit(ctx.db, { category: "config", action: "update.pause", verb: until ? "paused automatic updates" : "resumed automatic updates", suffix: until ? `until ${until.toISOString()}` : null, ...actorAudit(a), ...reqMeta(req) });
      return buildStatus(ctx.db, uenv);
    },

    "server.updates.policy": async ({ body, actor, req, ctx }) => {
      const a = requireActor(actor);
      if (!isTimeZone(body.timeZone)) throw new HttpError(400, `${body.timeZone} is not a time zone this server knows`, "VALIDATION");
      if (body.window && !body.window.days.length) throw new HttpError(400, "Pick at least one day for the maintenance window, or choose any time", "VALIDATION");
      const window = body.window ? { days: [...new Set(body.window.days)].sort(), start: body.window.start, end: body.window.end } : null;
      const before = await ctx.db.instance.findUnique({ where: { id: 1 }, select: { updateMode: true, updateChannel: true, updateWindow: true, updateTimeZone: true } });
      await ctx.db.instance.update({
        where: { id: 1 },
        data: {
          updateMode: body.mode,
          updateChannel: body.channel,
          updateWindow: window ?? Prisma.JsonNull,
          updateTimeZone: body.timeZone,
          // A new channel needs a fresh check before anything is offered from it.
          ...(before && before.updateChannel !== body.channel ? { updateNextCheckAt: new Date() } : {}),
        },
      });
      await audit(ctx.db, {
        category: "config", action: "update.policy", verb: "changed the update policy", suffix: `${body.mode}, ${body.channel}`,
        changes: { before: before ? { mode: before.updateMode, channel: before.updateChannel, window: before.updateWindow, timeZone: before.updateTimeZone } : null, after: { mode: body.mode, channel: body.channel, window, timeZone: body.timeZone } } as unknown as Prisma.InputJsonValue,
        ...actorAudit(a), ...reqMeta(req),
      });
      return buildStatus(ctx.db, uenv);
    },

    "server.updates.security": async ({ actor, ctx }) => securityAlert(ctx.db, uenv, requireActor(actor).userId),

    /** Audited on purpose: the activity log shows who put off a security alert and for how long. */
    "server.updates.security.snooze": async ({ body, actor, req, ctx }) => {
      const a = requireActor(actor);
      const { alert, stored } = await snoozeSecurity(ctx.db, uenv, a.userId, body);
      if (stored && alert.release) {
        const days = Math.round((stored.getTime() - Date.now()) / 86_400_000);
        await audit(ctx.db, {
          category: "system", action: "update.security.snooze", verb: "put off the security release", targetType: "release", targetLabel: alert.release.version,
          suffix: `${alert.release.level}, reminds again in ${days === 1 ? "1 day" : `${days} days`}`, ...actorAudit(a), ...reqMeta(req),
        });
      }
      return alert;
    },
  };
}
