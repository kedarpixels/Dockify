import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { z } from "zod";
import {
  endpointIds, endpoints, type BodyOf, type EndpointDef, type EndpointId, type ParamsOf, type QueryOf, type ResponseOf,
} from "@dockify/contracts";
import { internalChannelToken, type Keyring } from "@dockify/crypto";
import type { Db } from "@dockify/db";
import { enforce, readBearer, type Actor, type InternalAuth } from "./actor.ts";
import { audit } from "./audit.ts";
import { createClientResolver } from "./client-ip.ts";
import type { ApiConfig } from "./config.ts";
import { webFor, type WebOrigin } from "./cookies.ts";
import { checkCsrf, SAFE_METHODS } from "./csrf.ts";
import { HttpError, rateLimited, zodFields } from "./errors.ts";
import { mountEndpoint } from "./mount.ts";
import { serviceVersionHandlers } from "./modules/resources/service-version.ts";
import { templateHandlers } from "./modules/templates/index.ts";
import { registerInternalRoutes } from "./internal/secrets.ts";
import { describePolicy, INFRA_POLICIES, POLICIES, type Policy } from "./policy.ts";
import { rateKey, RateLimits } from "./ratelimit.ts";
import { appsHandlers } from "./modules/apps/index.ts";
import { jobsHandlers } from "./modules/jobs/index.ts";
import { backupsHandlers } from "./modules/backups/index.ts";
import { dataHandlers } from "./modules/data/index.ts";
import { deploymentHandlers } from "./modules/deployments/index.ts";
import { domainHandlers } from "./modules/domains/index.ts";
import { registerDomainCheckRoute } from "./modules/domains/check-route.ts";
import { registerPreviewAsleepRoute } from "./modules/previews/asleep-route.ts";
import { GATE_ROUTES, registerPreviewGate } from "./modules/previews/gate.ts";
import { terminalHandlers } from "./modules/terminal/index.ts";
import { attachTerminalGateway, httpWorkerDial, type TerminalHub, type TerminalLimits, type WorkerDial } from "./modules/terminal/gateway.ts";
import { TerminalTickets } from "./modules/terminal/tickets.ts";
import { iconHandlers } from "./modules/icons/index.ts";
import { INTEGRATION_ENDPOINTS, integrationsPlugin, type IntegrationDeps } from "./modules/integrations/index.ts";
import { observeHandlers } from "./modules/observe/index.ts";
import { platformHandlers } from "./modules/platform/index.ts";
import { startWorkerWatch } from "./modules/platform/worker-watch.ts";
import { previewHandlers } from "./modules/previews/index.ts";
import { resourcesHandlers } from "./modules/resources/index.ts";
import { projectsHandlers } from "./modules/projects/index.ts";
import { authHandlers } from "./routes/auth.ts";

declare module "fastify" {
  interface FastifyContextConfig {
    policy?: Policy;
    endpoint?: string;
  }
  interface FastifyRequest {
    actor: Actor | null;
    clientIp: string;
  }
}

export interface Deps {
  db: Db;
  ring: Keyring;
  config: ApiConfig;
  /** Overrides the handler table, for tests. */
  handlers?: Handlers;
  /** Mounts the integrations plugin (default true). Tests that override handlers may skip it. */
  integrations?: boolean;
  /** What the integrations plugin reaches outside the database; tests pass a fake http client. */
  integrationDeps?: IntegrationDeps;
  /** Watches the worker's heartbeat and raises "worker down" from here (default true). */
  workerWatch?: boolean;
  /** How the terminal reaches the worker, and its limits; tests pass small ones. */
  terminalDial?: WorkerDial;
  terminalLimits?: Partial<TerminalLimits>;
  logger?: boolean;
}

/**
 * Every module's handler table, merged. Two modules claiming one endpoint is a wiring bug, so it
 * fails at boot instead of one silently shadowing the other.
 */
export function moduleHandlers(): Handlers {
  const tables: Array<[string, Handlers]> = [
    ["auth", authHandlers],
    ["projects", projectsHandlers as Handlers],
    ["apps", appsHandlers],
    ["jobs", jobsHandlers],
    ["deployments", deploymentHandlers],
    ["domains", domainHandlers as Handlers],
    ["backups", backupsHandlers],
    ["data", dataHandlers],
    ["observe", observeHandlers as Handlers],
    ["platform", platformHandlers()],
    ["previews", previewHandlers],
    ["resources", resourcesHandlers],
    ["templates", templateHandlers],
    ["service-version", serviceVersionHandlers],
    ["icons", iconHandlers],
    ["terminal", terminalHandlers],
  ];
  const out: Record<string, unknown> = {};
  const owner = new Map<string, string>();
  for (const [name, table] of tables) {
    for (const [id, h] of Object.entries(table)) {
      if (!h) continue;
      const prev = owner.get(id);
      if (prev) throw new Error(`Endpoint ${id} is handled by both ${prev} and ${name}`);
      owner.set(id, name);
      out[id] = h;
    }
  }
  return out as Handlers;
}

/** The ids the integrations plugin registers itself (it needs a raw body for the webhook). */
export const PLUGIN_OWNED = new Set<string>(INTEGRATION_ENDPOINTS);

export interface Ctx {
  db: Db;
  ring: Keyring;
  config: ApiConfig;
  web: WebOrigin;
  limits: RateLimits;
  /** One store: the elevated route issues, the socket spends. Only a built app has it. */
  terminalTickets?: TerminalTickets;
}

export interface HandlerInput<K extends EndpointId> {
  body: BodyOf<K>;
  query: QueryOf<K>;
  params: ParamsOf<K>;
  actor: Actor | null;
  req: FastifyRequest;
  reply: FastifyReply;
  ctx: Ctx;
}
export type Handler<K extends EndpointId> = (input: HandlerInput<K>) => Promise<ResponseOf<K> | undefined>;
export type Handlers = { [K in EndpointId]?: Handler<K> };

export interface RegisteredRoute {
  method: string;
  url: string;
  policy: string | null;
}

/**
 * Endpoints that run argon2 or check a code: the strict per-IP bucket. auth.stepUp is not here: it
 * needs a session, and its guard is keyed on that session (limits.stepUp in the handler), so one
 * signed-in user cannot exhaust a bucket other users share and lock them out of step-up.
 */
export const AUTH_LIMITED = new Set<string>([
  "auth.setup", "auth.login", "auth.verify", "auth.invite.accept", "auth.forgot", "auth.reset", "me.email.confirm",
  "me.password", "me.password.code", "me.2fa.verify", "me.2fa.disable",
]);

/** Liveness and readiness probes come from inside the host and never carry a forwarded address. */
const PROBES = new Set(["/healthz", "/readyz"]);

const isZodError = (e: unknown): e is z.ZodError =>
  typeof e === "object" && e !== null && Array.isArray((e as { issues?: unknown }).issues) && (e as Error).name === "ZodError";

/**
 * The request as the log writes it: the route's pattern, or for an unmatched route the path alone.
 * Fastify's default writes the whole URL, and URLs here carry secrets a log must not keep: the GitHub
 * manifest's `code` in a query, reset and invite tokens in a path.
 */
export function requestLogFields(req: { method: string; url: string; routeOptions?: { url?: string }; ip?: string }) {
  return { method: req.method, url: req.routeOptions?.url ?? req.url.split("?")[0], remoteAddress: req.ip };
}

export async function buildApp(deps: Deps): Promise<{ app: FastifyInstance; routes: RegisteredRoute[] }> {
  const { db, ring, config } = deps;
  const web: WebOrigin = { origin: config.publicUrl.origin, secure: config.publicUrl.protocol === "https:", loopback: `127.0.0.1:${config.webPort ?? 3000}` };
  const limits = new RateLimits();
  const terminalTickets = new TerminalTickets();
  const ctx: Ctx = { db, ring, config, web, limits, terminalTickets };
  const internal: InternalAuth = { token: internalChannelToken(ring), peers: config.internalPeers };
  const resolveClient = createClientResolver(config.trustedProxies, config.ingress);
  let lastMissingWarn = 0;
  const handlers: Handlers = deps.handlers ?? moduleHandlers();
  const withIntegrations = deps.integrations ?? true;
  const routes: RegisteredRoute[] = [];

  const app = Fastify({
    logger: deps.logger === false ? false : {
      level: config.logLevel,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']", "*.password", "*.token", "*.secret", "*.code"],
        censor: "[REDACTED]",
      },
      serializers: { req: requestLogFields },
    },
    // Client identity is decided by client-ip.ts, never by Fastify's own proxy handling.
    trustProxy: false,
    exposeHeadRoutes: false,
    bodyLimit: 1024 * 1024,
  });
  app.decorateRequest("actor", null);
  app.decorateRequest("clientIp", "");

  // Every route must carry a policy. A route without one fails at registration, before listen.
  app.addHook("onRoute", (opts) => {
    const policy = opts.config?.policy;
    if (!policy) throw new Error(`Route ${String(opts.method)} ${opts.url} has no policy`);
    routes.push({ method: String(opts.method), url: opts.url, policy: describePolicy(policy) });
  });

  const sweeper = setInterval(() => limits.sweep(), 60_000);
  sweeper.unref();
  app.addHook("onClose", async () => clearInterval(sweeper));
  // A dead worker cannot alert about itself; the api watches its heartbeat (worker-watch.ts).
  if (deps.workerWatch ?? true) {
    const stopWatch = startWorkerWatch({ db, ring, publicUrl: config.publicUrl }, (msg, err) => app.log.warn({ err }, msg));
    app.addHook("onClose", async () => stopWatch());
  }

  app.setValidatorCompiler(({ schema }) => (data) => {
    const r = (schema as z.ZodType).safeParse(data);
    return r.success ? { value: r.data } : { error: r.error as unknown as Error };
  });

  // The one enforcing hook: headers, client address, rate limit, CSRF, then the route's policy.
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    reply.header("Cache-Control", "no-store");

    const client = resolveClient(req.socket.remoteAddress, req.headers);
    req.clientIp = client.ip;
    const cfg = req.routeOptions.config;
    if (!req.routeOptions.url) return; // unmatched: the 404 handler answers

    const policy = cfg?.policy;
    if (!policy) throw new HttpError(500, "Route has no policy", "NO_POLICY");
    if (req.routeOptions.url === "/healthz") return;
    // Traefik asks the check on every request to a preview, and the form does its own origin check and
    // per-preview limits: neither fits a bucket keyed on one address, or the dashboard's own origin.
    if (req.routeOptions.url === GATE_ROUTES.check || req.routeOptions.url === GATE_ROUTES.form) return;

    const authLimited = AUTH_LIMITED.has(cfg.endpoint ?? "");
    const anonymous = policy.access === "anonymous" && !authLimited;
    // A trusted proxy that reports no client address would put every caller behind it in one
    // bucket. Refuse instead of keying on the proxy, except for probes and anonymous routes, which
    // have their own bucket and cannot starve a signed-in user.
    if (!client.known && !anonymous && !PROBES.has(req.routeOptions.url)) {
      const now = Date.now();
      if (now - lastMissingWarn > 60_000) {
        lastMissingWarn = now;
        req.log.warn({ peer: client.ip }, "trusted proxy sent no client address (X-Forwarded-For or CF-Connecting-IP); request refused");
      }
      throw new HttpError(400, "The proxy in front of the API did not report the client address", "CLIENT_ADDRESS_MISSING");
    }

    // Internal routes are authenticated by a shared secret from a pinned peer, not by a browser:
    // no per-address bucket (one worker, many opens) and no CSRF (no cookie is ever read).
    if (policy.access === "internal") {
      req.actor = await enforce(db, req, web, policy, new Date(), internal);
      return;
    }

    const webhook = cfg.endpoint === "webhooks.github" || cfg.endpoint === "webhooks.vercel";
    const limiter = authLimited ? limits.auth : webhook ? limits.webhook : anonymous ? limits.anon : limits.general;
    const wait = limiter.take(rateKey(req.clientIp));
    if (wait !== null) throw rateLimited(reply, wait);

    if (!readBearer(req)) {
      const verdict = checkCsrf(req.method, req.headers, webFor(req, web).origin);
      if (!verdict.ok) throw new HttpError(403, "Cross-origin request refused", "CROSS_ORIGIN");
    }

    req.actor = await enforce(db, req, web, policy);
    if (req.actor?.kind === "token") {
      const now = new Date();
      const writes: Array<Promise<unknown>> = [
        // Throttle the "last used" write: skip it when the row was touched in the last minute, so a
        // polling CI token does not write the row on every request.
        db.apiToken.updateMany({
          where: { id: req.actor.tokenId, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now.getTime() - 60_000) } }] },
          data: { lastUsedAt: now, lastUsedIp: req.clientIp },
        }),
      ];
      // Audit a token's state-changing calls; auditing every read would bloat the activity log.
      if (!SAFE_METHODS.has(req.method)) {
        writes.push(
          audit(db, {
            category: "access", action: "token.use", verb: "used API token",
            actorType: "token", actorId: req.actor.tokenId, actorName: req.actor.name,
            targetType: "route", targetLabel: cfg.endpoint ?? req.routeOptions.url,
            ip: req.clientIp, userAgent: req.headers["user-agent"] ?? null,
          }),
        );
      }
      await Promise.all(writes);
    }
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({ error: "Not found", code: "NOT_FOUND" });
  });

  app.setErrorHandler((error: FastifyError | HttpError | z.ZodError, req, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send({ error: error.message, code: error.code, ...error.extra });
    }
    if (isZodError(error)) {
      // Fastify marks which part failed (body, querystring, params) on the error it was handed.
      const f = zodFields(error, (error as { validationContext?: string }).validationContext);
      return reply.code(400).send({ error: f.message, code: "INVALID_REQUEST", ...(f.field ? { field: f.field } : {}), fields: f.fields });
    }
    const status = typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) req.log.error({ err: error }, "request failed");
    return reply.code(status).send({ error: status >= 500 ? "Internal error" : error.message, code: (error as FastifyError).code ?? "INTERNAL" });
  });

  app.get("/healthz", { config: { policy: INFRA_POLICIES["GET /healthz"] } }, async () => ({ ok: true }));
  registerInternalRoutes(app, ctx);
  registerDomainCheckRoute(app, ctx);
  registerPreviewAsleepRoute(app);
  registerPreviewGate(app, ctx);
  app.get("/readyz", { config: { policy: INFRA_POLICIES["GET /readyz"] } }, async (req, reply) => {
    try {
      const row = await db.instance.findUnique({ where: { id: 1 }, select: { masterKeyFingerprint: true } });
      // After a rotation the row still names the old key, which stays loaded as a previous key.
      const ok = !!row && (row.masterKeyFingerprint === ring.active || ring.keys.has(row.masterKeyFingerprint));
      return reply.code(ok ? 200 : 503).send({ ok });
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  for (const id of endpointIds) {
    if (withIntegrations && PLUGIN_OWNED.has(id)) {
      if (handlers[id]) throw new Error(`Endpoint ${id} belongs to the integrations plugin`);
      continue;
    }
    mountEndpoint(app, ctx, id, handlers[id] as Handler<EndpointId> | undefined);
  }
  if (withIntegrations) await app.register(integrationsPlugin, { ctx, ...(deps.integrationDeps ? { deps: deps.integrationDeps } : {}) });

  const terminal: TerminalHub = attachTerminalGateway(app.server, ctx, resolveClient, {
    tickets: terminalTickets,
    dial: deps.terminalDial ?? httpWorkerDial(process.env.DOCKIFY_WORKER_CHANNEL_URL, () => internalChannelToken(ring)),
    ...(deps.terminalLimits ? { limits: deps.terminalLimits } : {}),
    log: (msg, extra) => app.log.warn(extra ?? {}, msg),
  });
  // Before the server closes: its close would otherwise wait on these sockets for good.
  app.addHook("preClose", async () => terminal.close());

  return { app, routes };
}

