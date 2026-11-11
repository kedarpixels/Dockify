/** Mounted as a plugin so the webhook bodies stay raw inside their own encapsulated scopes. */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import type { EndpointId } from "@dockify/contracts";
import type { Ctx, Handler, Handlers } from "../../app.ts";
import { mountEndpoint } from "../../mount.ts";
import { POLICIES } from "../../policy.ts";
import { cloudflareHandlers, cloudflareView } from "./cloudflare.ts";
import { dashboardDomainHandlers } from "./dashboard-domain.ts";
import { defaultDeps, type IntegrationDeps } from "./deps.ts";
import { emailHandlers, emailView } from "./email.ts";
import { buildManifest, loadGitHubApp, manifestPostUrl, safeAppHtmlUrl, signManifestState } from "./github/app.ts";
import { completeAppManifest, completeInstall, gitHandlers } from "./github/handlers.ts";
import { registryHandlers, registryView } from "./registries.ts";
import { storageHandlers, storageView } from "./storage.ts";
import { enqueueVercelSync, followOnly, VERCEL_WEBHOOK_MAX_BYTES, vercelHandlers, vercelView } from "./vercel.ts";
import { vercelProjectHandlers } from "./vercel-project.ts";
import { assertProjectScope } from "../../actor.ts";
import { audit } from "../../audit.ts";
import { requireSession, who } from "./deps.ts";
import { HttpError } from "../../errors.ts";
import { findIntegration } from "./store.ts";
import { webhookHandlers, webhookRefs } from "./webhooks.ts";

/**
 * Not a 302: GitHub sends the browser here cross-site and a redirect stays cross-site, so the SameSite=Strict
 * session cookie would not arrive. This page navigates from our own origin instead. Nothing is reflected.
 */
function landOnSettings(reply: FastifyReply, origin: string, outcome: "installed" | "failed" | "app-created" | "app-failed"): void {
  const url = `${origin}/settings?section=integrations&github=${outcome}`;
  void reply
    .code(200)
    .header("content-security-policy", "default-src 'none'")
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(`<!doctype html><meta charset="utf-8"><title>Dockify</title><meta http-equiv="refresh" content="0;url=${url}"><a href="${url}">Continue to Dockify</a>`);
}

export const INTEGRATION_ENDPOINTS = [
  "git.installations", "git.installUrl", "git.repos", "git.branches", "git.installations.delete", "git.setup", "git.app.manifest", "git.app.callback", "git.app.delete",
  "apps.vercel.sync",
  "integrations.summary",
  "integrations.vercel.connect", "integrations.vercel.delete", "integrations.vercel.projects", "integrations.vercel.import",
  "integrations.vercel.webhook.create", "integrations.vercel.webhook.delete", "integrations.vercel.sync",
  "apps.vercel.logs", "apps.vercel.logs.stream", "apps.vercel.project", "apps.vercel.env",
  "integrations.cloudflare.connect", "integrations.cloudflare.delete", "integrations.cloudflare.zones", "integrations.cloudflare.zone",
  "integrations.cloudflare.domains", "integrations.cloudflare.lookup", "integrations.cloudflare.record",
  "settings.domain.get", "settings.domain.start", "settings.domain.check", "settings.domain.record", "settings.domain.switch", "settings.domain.cancel", "settings.domain.previous.delete",
  "integrations.registries.list", "integrations.registries.create", "integrations.registries.patch", "integrations.registries.delete",
  "integrations.storage.list", "integrations.storage.create", "integrations.storage.patch", "integrations.storage.delete", "integrations.storage.test",
  "integrations.webhooks.list", "integrations.webhooks.create", "integrations.webhooks.patch", "integrations.webhooks.delete", "integrations.webhooks.test", "integrations.webhooks.icon",
  "integrations.email.connect", "integrations.email.delete", "integrations.email.test",
  "webhooks.github", "webhooks.vercel",
] as const satisfies readonly EndpointId[];

export function createIntegrationHandlers(deps: IntegrationDeps = defaultDeps()): Handlers {
  return {
    ...gitHandlers(deps),
    ...vercelHandlers(deps),
    ...vercelProjectHandlers(deps),
    ...cloudflareHandlers(deps),
    ...dashboardDomainHandlers(deps),
    ...registryHandlers(deps),
    ...storageHandlers(deps),
    ...webhookHandlers(deps),
    ...emailHandlers(deps),

    // Never reflects anything: success or failure both land on the integrations settings page.
    "git.setup": async ({ query, reply, ctx }) => {
      const ok = await completeInstall(ctx.db, ctx.ring, deps, query).then((r) => r.ok, () => false);
      landOnSettings(reply, ctx.config.publicUrl.origin, ok ? "installed" : "failed");
      return undefined;
    },

    // Refused once an App exists, so the owner learns it here and not after GitHub has created a second App.
    "git.app.manifest": async ({ body, actor, ctx }) => {
      const s = requireSession(actor);
      if (await findIntegration(ctx.db, "github_app")) throw new HttpError(409, "This server already has a GitHub App", "GITHUB_APP_EXISTS");
      const state = signManifestState(ctx.ring, deps.states, s.sessionId);
      return { postUrl: manifestPostUrl(state, body?.organization), manifest: buildManifest(ctx.config.publicUrl.origin) };
    },

    // Never reflects anything. Why it failed goes to the log only, and that reason never holds the code or a secret.
    "git.app.callback": async ({ query, reply, req, ctx }) => {
      const client = { ip: req.clientIp, userAgent: req.headers["user-agent"] ?? null };
      const out = await completeAppManifest(ctx.db, ctx.ring, deps, query, client).catch((e: unknown) => ({
        ok: false as const,
        reason: `storing the App failed (${e instanceof Error ? e.name : "unknown error"})`,
      }));
      if (out.ok) req.log.info({ slug: out.slug }, "GitHub App created from the manifest");
      else req.log.warn({ reason: out.reason }, "GitHub App creation did not complete");
      landOnSettings(reply, ctx.config.publicUrl.origin, out.ok ? "app-created" : "app-failed");
      return undefined;
    },

    "apps.vercel.sync": async ({ params, actor, ctx, req }) => {
      const app = await ctx.db.app.findUnique({ where: { id: params.id }, select: { name: true, deployTarget: true, vercelFollowOnly: true, environment: { select: { projectId: true } } } });
      if (!app) throw new HttpError(404, "App not found", "NOT_FOUND");
      if (actor) assertProjectScope(actor, app.environment.projectId);
      if (app.deployTarget !== "vercel") throw new HttpError(400, "This app does not deploy to Vercel", "NOT_VERCEL_TARGET");
      if (app.vercelFollowOnly) throw followOnly();
      await enqueueVercelSync(ctx.db, params.id, "sync_env");
      // This pushes the environment's secrets to Vercel, so it is audited like a deploy.
      await audit(ctx.db, { category: "deploys", action: "app.vercel.sync", verb: "pushed env to Vercel for", targetType: "app", targetId: params.id, targetLabel: app.name, ...who(actor, req) });
      return undefined;
    },
    "integrations.summary": async ({ actor, ctx }) => {
      const db = ctx.db;
      // A Viewer learns only which kinds are connected. Hosts, usernames, buckets and secret hints are an admin's.
      if (requireSession(actor).role !== "admin") {
        const kinds = await db.integration.groupBy({ by: ["kind"], where: { status: { not: "disconnected" } }, _count: true });
        const has = (kind: string) => kinds.some((k) => k.kind === kind);
        return {
          limited: true as const,
          github: (await db.gitHubInstallation.count()) > 0,
          vercel: has("vercel"),
          cloudflare: has("cloudflare"),
          registries: has("registry"),
          storage: has("storage"),
          webhooks: (await webhookRefs(db)).length > 0,
          email: !!(await emailView(db)),
        };
      }
      const [accounts, app, registries, storage] = await Promise.all([
        db.gitHubInstallation.count(),
        loadGitHubApp(db),
        db.integration.findMany({ where: { kind: "registry" }, orderBy: { createdAt: "asc" } }),
        db.integration.findMany({ where: { kind: "storage" }, orderBy: { createdAt: "asc" } }),
      ]);
      return {
        github: {
          accounts,
          app: app
            ? {
                slug: app.config.slug,
                htmlUrl: safeAppHtmlUrl(app.config.htmlUrl, app.config.slug),
                owner: app.config.owner ?? null,
                source: app.config.source ?? "installer",
                createdAt: app.row.createdAt.toISOString(),
              }
            : null,
        },
        vercel: await vercelView(db),
        cloudflare: await cloudflareView(db),
        registries: await Promise.all(registries.map((r) => registryView(db, r))),
        storage: await Promise.all(storage.map((r) => storageView(db, r))),
        webhooks: await webhookRefs(db),
        email: await emailView(db),
      };
    },
  };
}

export interface IntegrationsPluginOptions {
  ctx: Ctx;
  deps?: IntegrationDeps;
}

function mount(app: FastifyInstance, ctx: Ctx, handlers: Handlers, ids: readonly EndpointId[]): void {
  for (const id of ids) mountEndpoint(app, ctx, id, handlers[id] as Handler<EndpointId> | undefined);
}

export const integrationsPlugin: FastifyPluginAsync<IntegrationsPluginOptions> = async (app, opts) => {
  const handlers = createIntegrationHandlers(opts.deps ?? defaultDeps());
  const json = INTEGRATION_ENDPOINTS.filter((id) => id !== "webhooks.github" && id !== "webhooks.vercel");
  mount(app, opts.ctx, handlers, json);

  // GitHub signs the bytes it sent. In this child scope only, both hook content types stay a raw Buffer,
  // and the signature check runs over it before anything is parsed.
  await app.register(async (raw) => {
    for (const type of ["application/json", "application/x-www-form-urlencoded"]) {
      raw.addContentTypeParser(type, { parseAs: "buffer", bodyLimit: 5 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    }
    mount(raw, opts.ctx, handlers, ["webhooks.github"]);
  });

  // Vercel signs its bytes too, always as JSON. A body over the small limit is refused with 413 before it is read.
  await app.register(async (raw) => {
    raw.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: VERCEL_WEBHOOK_MAX_BYTES }, (_req, body, done) => done(null, body));
    mount(raw, opts.ctx, handlers, ["webhooks.vercel"]);
  });
};

export { seedGitHubAppFromEnv } from "./github/app.ts";
export { seedEmailFromEnv } from "./email.ts";
export type { IntegrationDeps } from "./deps.ts";
export { defaultDeps } from "./deps.ts";
