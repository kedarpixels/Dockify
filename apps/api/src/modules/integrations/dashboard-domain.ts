/**
 * Moving the dashboard to a new domain. The new address is set up and checked beside the running one; the switch
 * rewrites DOCKIFY_PUBLIC_URL and the old address redirects afterwards, so nobody can lock themselves out.
 * `sudo dockify admin set-domain <host>` is the way back in.
 */
import { dashboardDomain as D, nonPublicHostReason } from "@dockify/contracts";
import type { Keyring } from "@dockify/crypto";
import { enqueueTx, Prisma, type Db, type Tx } from "@dockify/db";
import { setTimeout as sleep } from "node:timers/promises";
import type { Ctx, Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError } from "../../errors.ts";
import { isReserved, normalizeHost, reservedHosts } from "../domains/logic.ts";
import { hostReadContext, putRecord, readHost, serverTarget } from "./cloudflare-domains.ts";
import { requireActor, who, type IntegrationDeps } from "./deps.ts";
import { buildManifest, loadGitHubApp } from "./github/app.ts";
import { findIntegration } from "./store.ts";

const JOB_KEY = "dashboard.domain";
const SWITCH_KEY = "dashboard.domain.switch";
const APPLY_KEY = "dashboard.domain.apply";
const LOCK = "dockify.dashboard.domain";

/** Must outlast the slowest check (modules/domains/handlers.ts CHECK_WAIT_MS). */
const CHECK_WAIT_MS = 16_000;
const CHECK_POLL_MS = 400;

const toJson = (v: unknown) => v as Prisma.InputJsonValue;

async function instanceRow(db: Tx) {
  const row = await db.instance.findUnique({ where: { id: 1 }, select: { dashboardDomain: true, dashboardPreviousHosts: true, dashboardLastChange: true, dashboardCfRecords: true } });
  if (!row) throw new HttpError(503, "The instance is not initialised yet", "NOT_READY");
  return row;
}

/** Only the webhook URL can be set through GitHub's API; the other three must be changed on github.com, so they are listed. */
export function githubSteps(app: { config: { slug: string; owner?: { login: string; type: string } } }, origin: string) {
  const m = buildManifest(origin) as { url: string; redirect_url: string; setup_url: string; hook_attributes: { url: string } };
  const slug = encodeURIComponent(app.config.slug);
  const owner = app.config.owner;
  return {
    slug: app.config.slug,
    settingsUrl: owner?.type === "Organization" ? `https://github.com/organizations/${encodeURIComponent(owner.login)}/settings/apps/${slug}` : `https://github.com/settings/apps/${slug}`,
    homepageUrl: m.url,
    callbackUrl: m.redirect_url,
    setupUrl: m.setup_url,
    webhookUrl: m.hook_attributes.url,
  };
}

async function stateOf(ctx: Ctx, deps: IntegrationDeps) {
  const row = await instanceRow(ctx.db);
  const pending = D.readPendingDomain(row.dashboardDomain);
  const cf = await findIntegration(ctx.db, "cloudflare");
  const connected = !!cf && cf.status !== "disconnected";
  let cloudflare: D.HostState | null = null;
  if (pending && connected) {
    const read = await hostReadContext(ctx, deps).catch(() => null);
    if (read) cloudflare = await readHost(read, pending.host, { ownRecordId: pending.cfRecord?.recordId ?? null, certActive: pending.tls.status === "active", dnsOk: pending.dns.status === "ok" });
  }
  const app = await loadGitHubApp(ctx.db);
  const target = serverTarget(ctx.config);
  const made = D.readCfRecords(row.dashboardCfRecords);
  return {
    url: ctx.config.publicUrl.origin,
    host: ctx.config.publicUrl.hostname,
    ingress: ctx.config.ingress,
    server: { ipv4: target.ipv4, ipv6: target.ipv6, tunnelTarget: target.tunnelTarget },
    previousHosts: row.dashboardPreviousHosts ?? [],
    previousRecords: (row.dashboardPreviousHosts ?? []).filter((h) => !!made[h]),
    pending,
    cloudflareConnected: connected,
    cloudflare,
    github: app ? githubSteps(app, pending ? `https://${pending.host}` : ctx.config.publicUrl.origin) : null,
    lastChange: D.readLastChange(row.dashboardLastChange),
  };
}

const enqueueCheck = (tx: Tx, payload: Record<string, unknown> = {}, key = JOB_KEY) => enqueueTx(tx as Parameters<typeof enqueueTx>[0], { kind: "dashboard_domain", lane: "maintenance", payload: toJson(payload), dedupeKey: key, maxAttempts: 2 });
const lock = (tx: Tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK}))`;

/**
 * True when Dockify can create the record on a managed Cloudflare zone, in which case the first lookup must wait:
 * looked up before the record exists, the name sits in resolvers' negative cache (30 minutes on Cloudflare).
 * Anything that cannot be read answers false, and the check runs at once.
 */
async function offersRecord(ctx: Ctx, deps: IntegrationDeps, host: string): Promise<boolean> {
  try {
    const read = await hostReadContext(ctx, deps);
    if (!read) return false;
    const state = await readHost(read, host, { ownRecordId: null, certActive: false, dnsOk: false });
    return state.managed && !!state.expected && state.records.length === 0 && !state.findings.some((f) => f.code === "dns_denied");
  } catch {
    return false;
  }
}

/** Lets the worker look the pending name up, once the record exists or the owner pressed Check now. */
async function releaseHold(tx: Tx, host: string): Promise<void> {
  await lock(tx);
  const now = D.readPendingDomain((await instanceRow(tx)).dashboardDomain);
  if (!now || now.host !== host || !now.recordFirst) return;
  const { recordFirst: _held, ...rest } = now;
  await tx.instance.update({ where: { id: 1 }, data: { dashboardDomain: toJson(rest) } });
}

/** Also used by `dockify admin set-domain`. */
export async function hostProblem(db: Tx, host: string): Promise<{ message: string; code: string } | null> {
  const notPublic = nonPublicHostReason(host);
  if (notPublic) return { message: notPublic, code: "HOSTNAME_NOT_PUBLIC" };
  const domain = await db.domain.findUnique({ where: { hostname: host }, select: { app: { select: { name: true } } } });
  if (domain) return { message: `${host} is a domain of the app ${domain.app.name}. Remove it there first`, code: "DOMAIN_TAKEN" };
  if (await db.previewDeployment.findUnique({ where: { hostname: host }, select: { id: true } })) return { message: `A preview answers on ${host}`, code: "DOMAIN_TAKEN" };
  return null;
}

export function dashboardDomainHandlers(deps: IntegrationDeps): Handlers {
  return {
    "settings.domain.get": async ({ ctx }) => stateOf(ctx, deps),

    "settings.domain.start": async ({ body, actor, req, ctx }) => {
      const a = requireActor(actor);
      const host = normalizeHost(body.hostname);
      const field = { field: "hostname" };
      if (host === ctx.config.publicUrl.hostname) throw new HttpError(400, "The dashboard already answers on this address", "SAME_HOSTNAME", field);
      if (isReserved(host, reservedHosts(new URL("https://reserved.invalid"), ctx.config.reservedHosts.join(",")))) throw new HttpError(400, "This hostname is reserved on this server", "RESERVED_HOSTNAME", field);
      const problem = await hostProblem(ctx.db, host);
      if (problem) throw new HttpError(problem.code === "DOMAIN_TAKEN" ? 409 : 400, problem.message, problem.code, field);
      // Only Cloudflare's API can route a new name through a tunnel, so say it before any waiting.
      if (ctx.config.ingress === "cloudflare_tunnel" && !(await findIntegration(ctx.db, "cloudflare").then((r) => r && r.status !== "disconnected"))) {
        throw new HttpError(409, "This server runs behind a Cloudflare tunnel, and only Cloudflare can route a new name through it. Connect Cloudflare in Settings, Integrations first", "NEEDS_CLOUDFLARE");
      }
      const recordFirst = await offersRecord(ctx, deps, host);
      await ctx.db.$transaction(async (tx) => {
        await lock(tx);
        const row = await instanceRow(tx);
        if (D.readPendingDomain(row.dashboardDomain)?.phase === "switching") throw new HttpError(409, "The dashboard is switching address right now", "SWITCHING");
        await tx.instance.update({ where: { id: 1 }, data: { dashboardDomain: toJson({ ...D.freshPendingDomain(host, a.name, new Date()), ...(recordFirst ? { recordFirst: true } : {}) }) } });
        // A name Dockify is about to make the record for is looked up only once that record exists.
        if (!recordFirst) await enqueueCheck(tx);
        await audit(tx, { category: "config", action: "dashboard.domain.start", verb: "started moving the dashboard to", targetType: "instance", targetLabel: host, ...who(a, req) });
      });
      return stateOf(ctx, deps);
    },

    /** Waits for the queued check up to CHECK_WAIT_MS; past that the page polls. */
    "settings.domain.check": async ({ ctx }) => {
      const before = D.readPendingDomain((await instanceRow(ctx.db)).dashboardDomain);
      if (!before) throw new HttpError(409, "No new domain is being set up", "NOT_PENDING");
      const since = before.dns.checkedAt ?? "";
      await ctx.db.$transaction(async (tx) => {
        // Check now is the owner's own go-ahead to look the name up, record or not.
        if (before.recordFirst) await releaseHold(tx, before.host);
        await enqueueCheck(tx);
      });
      const deadline = Date.now() + CHECK_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(CHECK_POLL_MS);
        const p = D.readPendingDomain((await instanceRow(ctx.db)).dashboardDomain);
        if (!p || (p.dns.checkedAt ?? "") > since) break;
      }
      return stateOf(ctx, deps);
    },

    "settings.domain.record": async ({ body, actor, req, ctx }) => {
      const a = requireActor(actor);
      const pending = D.readPendingDomain((await instanceRow(ctx.db)).dashboardDomain);
      if (!pending) throw new HttpError(409, "No new domain is being set up", "NOT_PENDING");
      const c = await hostReadContext(ctx, deps);
      if (!c) throw new HttpError(409, "Cloudflare is not connected", "NOT_CONNECTED");
      const out = await putRecord({ api: c.api, zones: c.zones, managed: c.managed, target: c.target, host: pending.host, proxied: body.proxied ?? false, replace: body.replace ?? [] });
      await ctx.db.$transaction(async (tx) => {
        await lock(tx);
        const now = D.readPendingDomain((await instanceRow(tx)).dashboardDomain);
        if (now && now.host === pending.host) {
          // Only a record Dockify created here is recorded as its own: one the owner made stays theirs.
          const cfRecord = out.created && out.recordId ? { zoneId: out.zoneId, recordId: out.recordId } : now.cfRecord;
          const { recordFirst: _held, ...rest } = now;
          await tx.instance.update({ where: { id: 1 }, data: { dashboardDomain: toJson({ ...rest, cfRecord }) } });
        }
        await enqueueCheck(tx);
        await audit(tx, {
          category: "config",
          action: "dashboard.domain.record",
          verb: out.removed.length ? "replaced the Cloudflare record for" : "created a Cloudflare record for",
          targetType: "instance",
          targetLabel: pending.host,
          suffix: out.removed.length ? `, removing ${out.removed.map((r) => `${r.type} ${r.content}`).join(", ")}`.slice(0, 300) : null,
          ...who(a, req),
        });
      });
      return stateOf(ctx, deps);
    },

    /** The worker checks once more, then hands over to the updater. The page follows by polling. */
    "settings.domain.switch": async ({ actor, req, ctx }) => {
      const a = requireActor(actor);
      await ctx.db.$transaction(async (tx) => {
        await lock(tx);
        const pending = D.readPendingDomain((await instanceRow(tx)).dashboardDomain);
        if (!pending) throw new HttpError(409, "No new domain is being set up", "NOT_PENDING");
        if (pending.phase !== "ready") throw new HttpError(409, `${pending.host} has to answer and have its certificate before the dashboard can move to it`, "NOT_READY");
        await enqueueCheck(tx, { switch: true }, SWITCH_KEY);
        await audit(tx, { category: "config", action: "dashboard.domain.switch", verb: "switched the dashboard to", targetType: "instance", targetLabel: pending.host, suffix: `from ${ctx.config.publicUrl.hostname}`, ...who(a, req) });
      });
      return stateOf(ctx, deps);
    },

    "settings.domain.cancel": async ({ actor, req, ctx }) => {
      const a = requireActor(actor);
      await ctx.db.$transaction(async (tx) => {
        await lock(tx);
        const pending = D.readPendingDomain((await instanceRow(tx)).dashboardDomain);
        if (!pending) return;
        if (pending.phase === "switching") {
          const claimed = await tx.job.findFirst({ where: { dedupeKey: APPLY_KEY, completedAt: null, failedAt: null, lockedUntil: { gt: new Date() } }, select: { id: true } });
          if (claimed) throw new HttpError(409, "The dashboard is switching address right now", "SWITCHING");
        }
        await tx.job.updateMany({ where: { dedupeKey: { in: [APPLY_KEY, SWITCH_KEY] }, completedAt: null, failedAt: null }, data: { failedAt: new Date(), lastError: "Cancelled from Settings" } });
        await tx.instance.update({ where: { id: 1 }, data: { dashboardDomain: Prisma.DbNull } });
        await enqueueCheck(tx);
        await audit(tx, { category: "config", action: "dashboard.domain.cancel", verb: "stopped moving the dashboard to", targetType: "instance", targetLabel: pending.host, ...who(a, req) });
      });
      return stateOf(ctx, deps);
    },

    /** The Cloudflare record goes too, but only the one Dockify recorded by id and only while it still names this server. */
    "settings.domain.previous.delete": async ({ params, actor, req, ctx }) => {
      const a = requireActor(actor);
      const host = normalizeHost(params.host);
      await ctx.db.$transaction(async (tx) => {
        await lock(tx);
        const row = await instanceRow(tx);
        if (!(row.dashboardPreviousHosts ?? []).includes(host)) throw new HttpError(404, "The dashboard does not answer on that address", "NOT_FOUND");
        const made = D.readCfRecords(row.dashboardCfRecords);
        const ours = made[host] ?? null;
        const rest = Object.fromEntries(Object.entries(made).filter(([h]) => h !== host));
        await tx.instance.update({ where: { id: 1 }, data: { dashboardPreviousHosts: row.dashboardPreviousHosts.filter((h) => h !== host), ...(ours ? { dashboardCfRecords: toJson(rest) } : {}) } });
        await enqueueCheck(tx, { forget: host }, `${JOB_KEY}.forget:${host}`);
        if (ours) {
          await enqueueTx(tx as Parameters<typeof enqueueTx>[0], {
            kind: "edge_cf_unwire",
            lane: "maintenance",
            payload: toJson({ hostname: host, zoneId: ours.zoneId, recordId: ours.recordId, tunnelId: null }),
            dedupeKey: `edge.cf.unwire:${ours.recordId}`,
            maxAttempts: 5,
          });
        }
        await audit(tx, { category: "config", action: "dashboard.domain.forget", verb: "stopped the dashboard answering on", targetType: "instance", targetLabel: host, suffix: ours ? "removing the Cloudflare record Dockify made for it" : null, ...who(a, req) });
      });
      return stateOf(ctx, deps);
    },
  };
}

/**
 * Runs once per change of address, at the api's first boot on the new one. A failure is recorded for the page,
 * which then lists the webhook URL among the manual steps; the old address keeps serving the webhook meanwhile.
 */
export async function followGitHubWebhook(db: Db, ring: Keyring, deps: IntegrationDeps, origin: string): Promise<"updated" | "failed" | "skipped"> {
  const row = await db.instance.findUnique({ where: { id: 1 }, select: { dashboardLastChange: true } });
  const last = D.readLastChange(row?.dashboardLastChange);
  if (!last || last.webhook !== "none" || `https://${last.to}` !== origin) return "skipped";
  const app = await loadGitHubApp(db);
  if (!app) return "skipped";
  const url = githubSteps(app, origin).webhookUrl;
  let outcome: "updated" | "failed" = "updated";
  let error: string | null = null;
  try {
    const jwt = await deps.github.jwt(db, ring, app);
    await deps.github.call("PATCH", "/app/hook/config", { jwt }, { url });
  } catch (e) {
    outcome = "failed";
    // GitHubApiError's text names the path and status, never a credential or a response body.
    error = (e instanceof Error ? e.message : "GitHub did not accept the change").slice(0, 200);
  }
  await db.$transaction(async (tx) => {
    await tx.instance.update({ where: { id: 1 }, data: { dashboardLastChange: toJson({ ...last, webhook: outcome, webhookError: error }) } });
    await audit(tx, {
      category: "config", action: "dashboard.domain.github", verb: outcome === "updated" ? "pointed the GitHub App's webhook at" : "could not point the GitHub App's webhook at",
      actorType: "system", actorId: null, actorName: "Dockify", targetType: "instance", targetLabel: last.to, failed: outcome === "failed",
    });
  });
  return outcome;
}
