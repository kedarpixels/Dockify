import type { FastifyInstance } from "fastify";
import { dashboardDomain as D } from "@dockify/contracts";
import { DOMAIN_CHECK_PREFIX, domainCheckAnswer, domainCheckToken, internalChannelToken, sameCheckValue } from "@dockify/crypto";
import type { Ctx } from "../../app.ts";
import { INFRA_POLICIES } from "../../policy.ts";
import { normalizeHost } from "./logic.ts";

/** The probe's path on every host, with its one parameter. */
export const DOMAIN_CHECK_ROUTE = `${DOMAIN_CHECK_PREFIX}:token`;

/** The Host header as a domain name: no port, lowercase, no trailing dot; null for anything else. */
export function hostOf(header: string | undefined): string | null {
  if (!header || header.length > 300 || header.startsWith("[")) return null;
  const h = normalizeHost(header.replace(/:\d{1,5}$/, ""));
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) ? h : null;
}

/**
 * The domain ownership probe's answer (a domain behind a proxy such as Cloudflare's
 * resolves to the proxy, so DNS alone cannot say it reaches this server). The worker asks
 * http://<host>/.well-known/dockify-check/<token>; Traefik sends that prefix, and only that prefix,
 * to this route on every host (apps/worker/src/edge/routes.ts, the __edge.yml routers), above every
 * tenant route and below the dashboard's, so no tenant app can answer for a domain.
 *
 * It answers only for a domain row (or the dashboard domain being set up) whose own token is in the path, with a value only this server
 * can compute for that host and token (@dockify/crypto domain-check.ts). Anything else gets the
 * same empty 404, so the route says nothing about which domains exist here.
 */
export function registerDomainCheckRoute(app: FastifyInstance, ctx: Ctx): void {
  const secret = internalChannelToken(ctx.ring);
  app.get(DOMAIN_CHECK_ROUTE, { config: { policy: INFRA_POLICIES["GET /.well-known/dockify-check/:token"] } }, async (req, reply) => {
    const miss = () => reply.code(404).type("text/plain; charset=utf-8").send("");
    const token = (req.params as { token?: unknown }).token;
    const host = hostOf(req.headers.host);
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !host) return miss();
    const d = await ctx.db.domain.findUnique({ where: { hostname: host }, select: { id: true, hostname: true } });
    if (d) {
      if (!sameCheckValue(token, domainCheckToken(secret, d.id, d.hostname))) return miss();
      return reply.code(200).type("text/plain; charset=utf-8").send(domainCheckAnswer(secret, d.hostname, token));
    }
    // The dashboard's own domain being set up has no domain row; it has its own fixed id in the token.
    const row = await ctx.db.instance.findUnique({ where: { id: 1 }, select: { dashboardDomain: true } });
    const pending = D.readPendingDomain(row?.dashboardDomain);
    if (pending?.host !== host || !sameCheckValue(token, domainCheckToken(secret, D.DASHBOARD_CHECK_ID, host))) return miss();
    return reply.code(200).type("text/plain; charset=utf-8").send(domainCheckAnswer(secret, host, token));
  });
}
