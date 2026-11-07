import { actorFields, requireActor } from "../../actor.ts";
import type { FastifyRequest } from "fastify";
import { setTimeout as sleep } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { dashboardDomain as D, foreignSpelledAddress, nonPublicHostReason, testDomainName, testDomainOffer } from "@dockify/contracts";
import type { Prisma, Tx } from "@dockify/db";
import { assertProjectScope, tokenProjectLimit, type Actor } from "../../actor.ts";
import type { Ctx, Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError, isUniqueViolation } from "../../errors.ts";
import { isReserved, jobsForCreate, jobsForDelete, normalizeHost, reservedHosts, ROUTABLE_KINDS, toDomainRow, type EdgeJob } from "./logic.ts";

const withApp = { app: { select: { id: true, name: true, port: true, serverId: true, environment: { select: { name: true, project: { select: { slug: true, id: true } } } } } } } as const;

/** A token limited to projects sees and touches only those; the limit is never implied by an empty list. */
const projectFilter = (a: Actor): Prisma.DomainWhereInput => {
  const limit = tokenProjectLimit(a);
  return limit ? { app: { environment: { projectId: { in: limit } } } } : {};
};

function assertProject(a: Actor, projectId: string): void {
  assertProjectScope(a, projectId);
}

const reserved = (ctx: Ctx) => reservedHosts(ctx.config.publicUrl, ctx.config.reservedHosts.join(","));

/** The dashboard's other names: a domain being set up for it, and the addresses it left. */
async function dashboardHosts(ctx: Ctx): Promise<Set<string>> {
  const row = await ctx.db.instance.findUnique({ where: { id: 1 }, select: { dashboardDomain: true, dashboardPreviousHosts: true } });
  const pending = D.readPendingDomain(row?.dashboardDomain);
  return new Set([...(row?.dashboardPreviousHosts ?? []), ...(pending ? [pending.host] : [])]);
}

/** The list envelope: ingress mode and the targets a DNS record should point at. */
const envelope = (ctx: Ctx) => ({
  ingress: ctx.config.ingress,
  server: { ipv4: ctx.config.serverIpv4, ipv6: ctx.config.serverIpv6 ?? null, tunnelTarget: ctx.config.tunnelTarget },
});

/**
 * Enqueues an edge job. Collapses onto an open job with the same key only while that job has not
 * been claimed yet, so a change made while a sync is already running still gets its own run. A DNS
 * check reads the world from the control plane; the rest run on the app's server's deploy lane.
 */
export async function enqueueEdge(tx: Tx, job: Extract<EdgeJob, { kind: "dns_check" }>): Promise<void>;
export async function enqueueEdge(tx: Tx, job: EdgeJob, serverId: string): Promise<void>;
export async function enqueueEdge(tx: Tx, job: EdgeJob, serverId?: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${job.dedupeKey}))`;
  const open = await tx.job.findFirst({
    where: { dedupeKey: job.dedupeKey, completedAt: null, failedAt: null, attempts: 0 },
    select: { id: true },
  });
  if (open) return;
  const lane = job.kind === "dns_check" ? "maintenance" : "deploy";
  const runAfterMs = "runAfterMs" in job ? (job.runAfterMs ?? 0) : 0;
  await tx.job.create({
    data: { kind: job.kind, lane, serverId: job.kind === "dns_check" ? null : (serverId ?? null), payload: job.payload, dedupeKey: job.dedupeKey, runAfter: new Date(Date.now() + runAfterMs), maxAttempts: 5 },
  });
}

async function loadRow(ctx: Ctx, id: string, a: Actor) {
  const d = await ctx.db.domain.findFirst({ where: { id, ...projectFilter(a) }, include: withApp });
  if (!d) throw new HttpError(404, "Domain not found", "NOT_FOUND");
  return d;
}

/**
 * Long enough for the slowest check: the DNS lookup, then for a domain behind a proxy the ownership
 * probe (two requests of 5 s at most, apps/worker/src/edge/probe.ts) and the TLS read (5 s).
 */
const CHECK_WAIT_MS = 16_000;
const CHECK_POLL_MS = 400;
/** Let's Encrypt limits new certificates, and these are for trying things out. */
const MAX_TEST_DOMAINS = 20;

/**
 * A hostname an app may take, normalized, or the reason it may not. Also asked by a template before
 * it creates anything, so a bad name refuses the whole install rather than half of it.
 */
export async function usableHostname(ctx: Ctx, raw: string): Promise<string> {
  const hostname = normalizeHost(raw);
  if (isReserved(hostname, reserved(ctx))) {
    throw new HttpError(400, "This is the dashboard's own hostname and cannot be added to an app", "RESERVED_HOSTNAME", { field: "hostname" });
  }
  // A name that can never point at a public server would only wait for DNS forever.
  const notPublic = nonPublicHostReason(hostname);
  if (notPublic) throw new HttpError(400, notPublic, "HOSTNAME_NOT_PUBLIC", { field: "hostname" });
  // On sslip.io anyone can spell any address: such a name leads to that address, not here.
  const foreign = foreignSpelledAddress(hostname, ctx.config.serverIpv4);
  if (foreign) throw new HttpError(400, `This name spells ${foreign}, which is not this server. Use the free test domain instead, or your own domain`, "HOSTNAME_FOREIGN_ADDRESS", { field: "hostname" });
  if ((await dashboardHosts(ctx)).has(hostname)) {
    throw new HttpError(400, "The dashboard answers on this hostname, so it cannot be added to an app. Stop its old address in Settings, Instance first.", "RESERVED_HOSTNAME", { field: "hostname" });
  }
  // Preview hostnames live in a separate table, so the domain unique index alone would let one
  // steal a running preview's traffic. Refuse a hostname a preview already serves.
  if (await ctx.db.previewDeployment.findUnique({ where: { hostname }, select: { id: true } })) {
    throw new HttpError(409, "That hostname is already in use", "DOMAIN_TAKEN", { field: "hostname" });
  }
  return hostname;
}

/** Refuses when the server cannot give out one more test domain. A template asks before it creates anything. */
export async function assertTestDomainRoom(ctx: Ctx): Promise<void> {
  const offer = testDomainOffer({ ingress: ctx.config.ingress, serverIpv4: ctx.config.serverIpv4 });
  if (!offer.available) throw new HttpError(409, offer.reason ?? "This server has no test domain to offer", "TEST_DOMAIN_UNAVAILABLE");
  if ((await ctx.db.domain.count({ where: { testDomain: true } })) >= MAX_TEST_DOMAINS) {
    throw new HttpError(409, `This server has ${MAX_TEST_DOMAINS} test domains already. Remove one first: each is a certificate from Let's Encrypt`, "TEST_DOMAIN_LIMIT");
  }
}

/** Adds the test domain of a name already chosen: the row, its primary claim, its jobs and the audit row. */
export async function insertTestDomain(ctx: Ctx, a: Actor, req: FastifyRequest, app: { id: string; name: string }, hostname: string): Promise<string> {
  return ctx.db.$transaction(async (tx) => {
    const d = await tx.domain.create({ data: { appId: app.id, hostname, testDomain: true }, select: { id: true, appId: true } });
    await tx.app.updateMany({ where: { id: app.id, primaryDomainId: null }, data: { primaryDomainId: d.id } });
    const { serverId } = await tx.app.findUniqueOrThrow({ where: { id: app.id }, select: { serverId: true } });
    for (const job of jobsForCreate(d, ctx.config.ingress)) await enqueueEdge(tx, job, serverId);
    await audit(tx, {
      category: "config", action: "domain.test.create", verb: "added test domain", ...actorFields(a), targetType: "domain", targetId: d.id, targetLabel: hostname,
      suffix: `to ${app.name}`, ip: req.clientIp, userAgent: req.headers["user-agent"] ?? null,
    });
    return d.id;
  });
}

/** Nothing of a Vercel app runs here, so a domain on it would route nowhere and ask for a certificate it cannot use. */
function assertOnServer(app: { deployTarget: string }): void {
  if (app.deployTarget === "vercel") throw new HttpError(400, "This app is hosted on Vercel, so its domains stay on Vercel", "NOT_ON_SERVER", { field: "appId" });
}

export const domainHandlers: Handlers = {
  "domains.list": async ({ actor, ctx }) => {
    const a = requireActor(actor);
    const rows = await ctx.db.domain.findMany({ where: projectFilter(a), include: withApp, orderBy: [{ hostname: "asc" }], take: 2000 });
    return { items: rows.map(toDomainRow), ...envelope(ctx) };
  },

  "apps.domains": async ({ params, actor, ctx }) => {
    const a = requireActor(actor);
    const app = await ctx.db.app.findUnique({ where: { id: params.id }, select: { environment: { select: { projectId: true } } } });
    if (!app) throw new HttpError(404, "App not found", "NOT_FOUND");
    assertProject(a, app.environment.projectId);
    const rows = await ctx.db.domain.findMany({ where: { appId: params.id }, include: withApp, orderBy: [{ createdAt: "asc" }] });
    return { items: rows.map(toDomainRow), ...envelope(ctx) };
  },

  "domains.create": async ({ body, actor, req, ctx }) => {
    const a = requireActor(actor);
    const hostname = await usableHostname(ctx, body.hostname);
    const app = await ctx.db.app.findUnique({
      where: { id: body.appId },
      select: { id: true, name: true, kind: true, deployTarget: true, serverId: true, environment: { select: { projectId: true } } },
    });
    if (!app) throw new HttpError(404, "App not found", "NOT_FOUND", { field: "appId" });
    assertProject(a, app.environment.projectId);
    if (!ROUTABLE_KINDS.has(app.kind)) {
      throw new HttpError(400, "Only frontend and backend apps can have a domain", "NOT_ROUTABLE", { field: "appId" });
    }
    assertOnServer(app);

    let id: string;
    try {
      id = await ctx.db.$transaction(async (tx) => {
        const d = await tx.domain.create({ data: { appId: app.id, hostname }, select: { id: true, appId: true } });
        // An app with no primary takes its oldest domain: the one its route and links lead with. That
        // is the new one for a first domain; a later add never moves a card to its new name.
        const oldest = await tx.domain.findFirst({ where: { appId: app.id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
        await tx.app.updateMany({ where: { id: app.id, primaryDomainId: null }, data: { primaryDomainId: oldest?.id ?? d.id } });
        // A real domain takes over from a test domain: an app's links never lead with a test name.
        await tx.app.updateMany({ where: { id: app.id, primaryDomain: { testDomain: true } }, data: { primaryDomainId: d.id } });
        for (const job of jobsForCreate(d, ctx.config.ingress)) await enqueueEdge(tx, job, app.serverId);
        await audit(tx, {
          category: "config",
          action: "domain.create",
          verb: "added domain",
          ...actorFields(a),
          targetType: "domain",
          targetId: d.id,
          targetLabel: hostname,
          suffix: `to ${app.name}`,
          ip: req.clientIp,
          userAgent: req.headers["user-agent"] ?? null,
        });
        return d.id;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, "That hostname is already in use", "DOMAIN_TAKEN", { field: "hostname" });
      throw e;
    }
    return toDomainRow(await loadRow(ctx, id, a));
  },

  "domains.test.offer": async ({ actor, ctx }) => {
    requireActor(actor);
    return testDomainOffer({ ingress: ctx.config.ingress, serverIpv4: ctx.config.serverIpv4 });
  },

  /**
   * One free test domain for an app, on an explicit press: each one is a Let's Encrypt certificate, so
   * nothing creates these on its own, an app has one at most, and a server a bounded number. The name
   * comes from here alone. From then on it is an ordinary domain: route sync, DNS check, certificate.
   */
  "domains.test.create": async ({ body, actor, req, ctx }) => {
    const a = requireActor(actor);
    await assertTestDomainRoom(ctx);
    const app = await ctx.db.app.findUnique({ where: { id: body.appId }, select: { id: true, name: true, kind: true, deployTarget: true, environment: { select: { projectId: true } } } });
    if (!app) throw new HttpError(404, "App not found", "NOT_FOUND", { field: "appId" });
    assertProject(a, app.environment.projectId);
    if (!ROUTABLE_KINDS.has(app.kind)) throw new HttpError(400, "Only frontend and backend apps can have a domain", "NOT_ROUTABLE", { field: "appId" });
    assertOnServer(app);
    if (await ctx.db.domain.findFirst({ where: { appId: app.id, testDomain: true }, select: { id: true } })) {
      throw new HttpError(409, "This app already has a test domain", "TEST_DOMAIN_EXISTS");
    }
    // Six hex digits: a collision is rare, and the unique index turns one into a new try.
    for (let attempt = 0; attempt < 3; attempt++) {
      const hostname = testDomainName(app.name, randomBytes(3).toString("hex"), ctx.config.serverIpv4!);
      try {
        const id = await insertTestDomain(ctx, a, req, app, hostname);
        return toDomainRow(await loadRow(ctx, id, a));
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    }
    throw new HttpError(409, "Could not find a free test name. Try again", "DOMAIN_TAKEN");
  },

  /**
   * The DNS check, the ownership probe and the TLS read run in the worker (dns_check). The request
   * queues one and waits for the row to move; past CHECK_WAIT_MS it answers with the current row and
   * the result lands on the next list.
   */
  "domains.check": async ({ params, actor, ctx }) => {
    const a = requireActor(actor);
    const before = await loadRow(ctx, params.id, a);
    const since = before.dnsCheckedAt?.getTime() ?? 0;
    await ctx.db.$transaction((tx) => enqueueEdge(tx, { kind: "dns_check", payload: { domainId: before.id }, dedupeKey: `edge.dns.now:${before.id}` }));
    const deadline = Date.now() + CHECK_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(CHECK_POLL_MS);
      const row = await ctx.db.domain.findUnique({ where: { id: before.id }, select: { dnsCheckedAt: true } });
      if (!row) throw new HttpError(404, "Domain not found", "NOT_FOUND");
      if ((row.dnsCheckedAt?.getTime() ?? 0) > since) break;
    }
    return toDomainRow(await loadRow(ctx, before.id, a));
  },

  "domains.delete": async ({ params, query, actor, req, ctx }) => {
    const a = requireActor(actor);
    const d = await loadRow(ctx, params.id, a);
    await ctx.db.$transaction(async (tx) => {
      // The primary pointer is SetNull in the schema; the row and its wiring go together.
      const gone = await tx.domain.deleteMany({ where: { id: d.id } });
      if (gone.count === 0) return;
      // The primary pointer went to null with the row: the app's oldest remaining domain takes over.
      const next = await tx.domain.findFirst({ where: { appId: d.appId }, orderBy: { createdAt: "asc" }, select: { id: true } });
      if (next) await tx.app.updateMany({ where: { id: d.appId, primaryDomainId: null }, data: { primaryDomainId: next.id } });
      // keepRecord: the owner chose to leave the Cloudflare record Dockify made.
      const keep = query?.keepRecord === "1";
      for (const job of jobsForDelete(keep ? { ...d, cfRecordId: null } : d)) await enqueueEdge(tx, job, d.app.serverId);
      await audit(tx, {
        category: "config",
        action: "domain.delete",
        verb: "removed domain",
        ...actorFields(a),
        targetType: "domain",
        targetId: d.id,
        targetLabel: d.hostname,
        suffix: d.cfRecordId && query?.keepRecord !== "1" ? `from ${d.app.name}, with its Cloudflare record` : `from ${d.app.name}`,
        ip: req.clientIp,
        userAgent: req.headers["user-agent"] ?? null,
      });
    });
    return undefined;
  },
};
