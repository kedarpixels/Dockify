import { isIP } from "node:net";
import { defaultServerId, type Db, type Prisma, type SecretVault } from "@dockify/db";
import { PermanentJobError } from "../errors.ts";
import type { ClaimedJob } from "../queue.ts";
import { cfClient, ensureDashboardApiRule, unwireDomain, wireDomain, type Fetch } from "./cloudflare.ts";
import { checkDns, dnsRecheckDelayMs, serverAddresses, type DnsLookup, type ServerAddresses, type ZoneDns } from "./dns.ts";
import { foreignSpelledAddress, SSLIP_DOWN_MESSAGE } from "@dockify/contracts";
import { routableHosts } from "./hosts.ts";
import { reservedHosts } from "./hostnames.ts";
import type { EdgeMode, EdgeSettings } from "./ingress.ts";
import { loadCloudflare, tunnelLock } from "./integration.ts";
import type { ProbeResult } from "./probe.ts";
import { dashboardHandler, dashboardReservedHosts, syncDashboardEdge } from "./dashboard.ts";
import { ensureSystemRoutes, isBackendName, readRoute, rekeyRoute, removeRoute, sweepRoutes, writeRoute, type WriteResult } from "./routes.ts";
import { appsHere } from "../server/apps-here.ts";
import type { RouteStore } from "../server/runtime.ts";
import { checkTls, type TlsProbe } from "./tls.ts";

/**
 * Edge job handlers, one table for what acts on a server and one for what reaches none. Kinds:
 *
 *   edge_route_sync  { appId }                                  rewrite one app's route file
 *   reconcile        {}                                         system routes, orphan sweep, a
 *                                                               route sync for every app here, the
 *                                                               tunnel's api rule
 *   edge_cf_wire     { domainId, ruleIntent? }                  record + tunnel rule for a domain
 *   edge_cf_unwire   { hostname, zoneId, recordId, tunnelId }   remove exactly what was recorded
 *   dns_check        { domainId } or {}                         DNS and TLS state, one or all
 *   dashboard_domain see edge/dashboard.ts
 *
 */

/** Where an app's route sends traffic: a container name only that container answers to, on its network. */
export interface RouteTargetInfo {
  backend: string;
  network: string;
}

/** What the handlers that reach no server need. */
export interface EdgeGlobalDeps {
  db: Db;
  vault: SecretVault;
  settings: EdgeSettings;
  /** The route files of the server the dashboard answers on, and that server's ingress. */
  routes: RouteStore;
  mode: EdgeMode;
  dns: DnsLookup;
  /** The zone's own nameservers, for the dashboard's new name (edge/dashboard.ts). */
  zoneDns?: ZoneDns;
  tls: TlsProbe;
  /**
   * The ownership probe (edge/probe.ts), direct mode: asks the domain itself whether it reaches this
   * server, for a domain whose DNS names a proxy. Absent: DNS alone decides.
   */
  probe?: (host: string, domainId: string) => Promise<ProbeResult>;
  fetch?: Fetch;
  now?: () => Date;
}

/** One server's: its route files, its ingress and its containers. */
export interface EdgeDeps extends EdgeGlobalDeps {
  serverId: string;
  /**
   * The app's container as a route target: its route alias, or for a container made before route
   * aliases existed, the app's canonical name (dk-<app id>, which only the live container holds
   * outside a deploy). Null when the app has no container. Owned by the deploy module.
   */
  routeTarget: (appId: string) => Promise<RouteTargetInfo | null>;
  /** The port the image of the app's container says it listens on, as a deploy reads it. Null when it says none or there is no container. */
  imagePort: (appId: string) => Promise<number | null>;
  /** A running preview container's name for a preview member, for re-keying an old route. */
  previewTarget?: (previewDeploymentId: string) => Promise<RouteTargetInfo | null>;
  /** Joins Traefik to a network so it can reach a backend there. Idempotent. */
  joinProxy: (network: string) => Promise<void>;
}

export type EdgeJobHandler = (job: ClaimedJob, signal: AbortSignal) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTED_KINDS = ["frontend", "backend"] as const;
const IN_FLIGHT = ["queued", "building", "deploying", "cancelling"] as const;
const obj = (p: unknown): Record<string, unknown> => (p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {});
const uuidField = (p: Record<string, unknown>, key: string): string => {
  const v = p[key];
  if (typeof v !== "string" || !UUID.test(v)) throw new PermanentJobError(`Job payload needs a uuid ${key}`);
  return v;
};
const strField = (p: Record<string, unknown>, key: string): string => {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0 || v.length > 253) throw new PermanentJobError(`Job payload needs ${key}`);
  return v;
};

async function system(db: Db, action: string, verb: string, target: { type: string; id: string; label: string }, failed: boolean, suffix: string): Promise<void> {
  await db.activityLog.create({
    data: {
      category: "config",
      action,
      verb,
      actorType: "system",
      actorName: "Dockify",
      targetType: target.type,
      targetId: target.id,
      targetLabel: target.label,
      suffix: suffix.slice(0, 300),
      failed,
    },
  });
}

/**
 * Queues a route sync for one app on the deploy lane, where it runs between deploys and never
 * during a swap. Collapses onto a queued sync only while nobody has claimed it yet, so a change
 * made while one already runs still gets its own pass (the api's enqueueEdge does the same).
 */
export async function enqueueRouteSync(db: Db, appId: string): Promise<void> {
  const key = `edge.route:${appId}`;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const open = await tx.job.findFirst({ where: { dedupeKey: key, completedAt: null, failedAt: null, lockedBy: null }, select: { id: true } });
    if (open) return;
    // A deleted app's route still has to go (syncAppRoute removes it), from the primary server for now.
    const app = await tx.app.findUnique({ where: { id: appId }, select: { serverId: true } });
    const serverId = app?.serverId ?? (await defaultServerId(tx));
    await tx.job.create({ data: { kind: "edge_route_sync", lane: "deploy", serverId, payload: { appId }, dedupeKey: key, maxAttempts: 5, runAfter: new Date() } });
  });
}

/**
 * Brings one app's route file in line with the database and its live container. The hosts are the
 * app's domains whose DNS points here (edge/hosts.ts), primary first. The backend is the live
 * container's route alias, never an address, so this is safe to run at any time: at
 * boot, on a Docker start event, on every reconcile.
 *
 * While a deploy of the app is under way its swap owns the backend (the canonical name may hold a
 * new container that is not ready yet), so only the hosts are brought up to date and the backend
 * stays what the file says.
 */
export async function syncAppRoute(deps: EdgeDeps, appId: string): Promise<WriteResult | "kept"> {
  const { db, settings, routes, mode } = deps;
  const app = await db.app.findUnique({
    where: { id: appId },
    select: {
      id: true, name: true, port: true, kind: true, desiredState: true, serverId: true,
      primaryDomain: { select: { hostname: true } },
      domains: { select: { hostname: true, dnsStatus: true }, orderBy: { createdAt: "asc" } },
    },
  });
  // Deleted, not meant to run, or by now on another server: this server has nothing to route for it.
  if (!app || app.serverId !== deps.serverId || app.desiredState !== "running" || !(ROUTED_KINDS as readonly string[]).includes(app.kind)) {
    await removeRoute(routes, appId);
    return "removed";
  }
  // The dashboard's own address, a domain being set up for it and the addresses it left: never a tenant's.
  const reserved = reservedHosts(settings.dashboardHost, await dashboardReservedHosts(db));
  const primary = app.primaryDomain?.hostname;
  const domains = primary ? [...app.domains.filter((d) => d.hostname === primary), ...app.domains.filter((d) => d.hostname !== primary)] : app.domains;
  const current = await readRoute(routes, appId);
  const hosts = routableHosts(domains, { routed: new Set(current?.hosts ?? []), reserved });

  const deploying = await db.deployment.findFirst({ where: { appId, previewId: null, status: { in: [...IN_FLIGHT] } }, select: { id: true } });
  if (deploying) {
    if (!current?.backend) return "kept";
    return writeRoute(routes, { id: app.id, port: app.port, hosts }, current.backend, mode, reserved);
  }
  const target = await deps.routeTarget(appId);
  if (!target) {
    await removeRoute(routes, appId);
    return "removed";
  }
  // A domain added after the deploy that started this container: the deploy had no reason to settle a
  // port (an app with none may not listen at all), and this is the moment it has one.
  const port = app.port ?? (app.domains.length ? await learnPort(deps, app) : null);
  // Traefik keeps the networks it joined across restarts, so a join that fails now (the proxy not
  // started yet after a reboot) does not hold the route back; the next sync tries it again.
  if (port !== null && hosts.length) await deps.joinProxy(target.network).catch(() => undefined);
  return writeRoute(routes, { id: app.id, port, hosts }, target.backend, mode, reserved);
}

/**
 * The deploy's rule for an app with a domain and no port, on the container already running: the port
 * its image says it listens on settles the app's, for good. An image that says none leaves the app with
 * no port and no route, and the domain's row says so. A person's own value, saved meanwhile, stands.
 */
async function learnPort(deps: EdgeDeps, app: { id: string; name: string }): Promise<number | null> {
  const port = await deps.imagePort(app.id);
  if (port === null) return null;
  const { count } = await deps.db.app.updateMany({ where: { id: app.id, port: null }, data: { port } });
  if (count === 0) return (await deps.db.app.findUnique({ where: { id: app.id }, select: { port: true } }))?.port ?? null;
  await system(deps.db, "app.port.detected", "set the port of", { type: "app", id: app.id, label: app.name }, false, `to ${port}: it has a domain, and its image says it listens there. Change it in the app's Settings.`);
  return port;
}

/**
 * Re-points every route at its container by name, then clears what can no longer be routed. Runs
 * once at worker boot, before the job lanes start, so a host reboot (new container addresses)
 * leaves no route on an old address, including routes written by a version that used addresses.
 * Returns how many apps were synced and how many preview routes were re-keyed or dropped.
 */
export async function resyncRoutes(deps: EdgeDeps, log: (msg: string, extra?: object) => void = () => {}): Promise<{ apps: number; previews: number }> {
  const apps = await deps.db.app.findMany({ where: { kind: { in: [...ROUTED_KINDS] }, ...appsHere(deps.serverId) }, select: { id: true } });
  let synced = 0;
  for (const a of apps) {
    try {
      await syncAppRoute(deps, a.id);
      synced++;
    } catch (e) {
      log("route sync failed", { appId: a.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // A preview route an older version wrote names an address. Point it at the preview container's
  // name, or drop it when that container is gone: an old address can belong to anyone now.
  let previews = 0;
  const { routes } = deps;
  for (const name of Object.keys(await routes.snapshot())) {
    const m = /^pv-([0-9a-f-]{36})\.yml$/.exec(name);
    if (!m) continue;
    const id = `pv-${m[1]}`;
    const route = await readRoute(routes, id);
    if (!route?.backend || !isIP(route.backend)) continue;
    const target = await deps.previewTarget?.(m[1]!).catch(() => null);
    if (target && isBackendName(target.backend)) {
      await deps.joinProxy(target.network).catch(() => undefined);
      await rekeyRoute(routes, id, route.backend, target.backend);
    } else {
      await removeRoute(routes, id);
    }
    previews++;
  }
  return { apps: synced, previews };
}

async function wire(deps: EdgeGlobalDeps, job: ClaimedJob): Promise<void> {
  const { db, settings } = deps;
  const payload = obj(job.payload);
  const domainId = uuidField(payload, "domainId");
  const domain = await db.domain.findUnique({ where: { id: domainId }, select: { id: true, hostname: true, cfRecordId: true } });
  if (!domain) return; // deleted before the job ran: nothing to wire
  if (domain.cfRecordId) return; // already wired
  const label = { type: "domain", id: domain.id, label: domain.hostname };
  if (settings.mode.ingress !== "cloudflare_tunnel") return;

  const loaded = await loadCloudflare(db, deps.vault);
  if (!loaded.ok) {
    await system(db, "domain.cloudflare.skip", "skipped Cloudflare for", label, false, loaded.reason);
    return;
  }
  const { conn } = loaded;
  if (!conn.tunnelId) {
    await system(db, "domain.cloudflare.skip", "skipped Cloudflare for", label, true, "No tunnel is recorded for this server.");
    return;
  }
  const outcome = await wireDomain({
    cf: cfClient(conn.token, deps.fetch),
    accountId: conn.accountId,
    tunnelId: conn.tunnelId,
    host: domain.hostname,
    reserved: reservedHosts(settings.dashboardHost, await dashboardReservedHosts(db)),
    managedZoneIds: conn.managedZoneIds,
    withTunnelLock: tunnelLock(db),
    resumingRule: payload.ruleIntent === true,
    markRuleIntent: async () => {
      await db.job.update({ where: { id: job.id }, data: { payload: { ...payload, ruleIntent: true } as Prisma.InputJsonValue } });
    },
  });
  if (outcome.state === "managed") {
    const n = await db.domain.updateMany({ where: { id: domain.id, cfRecordId: null }, data: { cfZoneId: outcome.zoneId, cfRecordId: outcome.recordId } });
    if (n.count === 0) {
      // The row went away mid-job: undo what this run made, by the ids it just got.
      await unwireDomain({
        cf: cfClient(conn.token, deps.fetch), accountId: conn.accountId, host: domain.hostname, zoneId: outcome.zoneId,
        recordId: outcome.recordId, tunnelId: outcome.tunnelId, reserved: reservedHosts(settings.dashboardHost), withTunnelLock: tunnelLock(db),
      });
      return;
    }
  }
  await system(db, `domain.cloudflare.${outcome.state}`, outcome.state === "managed" ? "routed" : "did not route", label, outcome.state === "failed", outcome.message);
  if (outcome.state === "failed") throw new Error(outcome.message);
}

async function unwire(deps: EdgeGlobalDeps, job: ClaimedJob): Promise<void> {
  const { db, settings } = deps;
  const p = obj(job.payload);
  const host = strField(p, "hostname");
  const zoneId = strField(p, "zoneId");
  const recordId = strField(p, "recordId");
  const tunnelId = typeof p.tunnelId === "string" ? p.tunnelId : null;
  const label = { type: "domain", id: recordId, label: host };
  const loaded = await loadCloudflare(db, deps.vault);
  if (!loaded.ok) {
    await system(db, "domain.cloudflare.left", "left on Cloudflare", label, true, `${loaded.reason} The record and tunnel rule for ${host} were left in place.`);
    return;
  }
  // The owner took this zone out of Dockify's hands since: its records are theirs now.
  if (!loaded.conn.managedZoneIds.has(zoneId)) {
    await system(db, "domain.cloudflare.left", "left on Cloudflare", label, false, `${host} is on a zone Dockify no longer manages, so its record stays.`);
    return;
  }
  const outcome = await unwireDomain({
    cf: cfClient(loaded.conn.token, deps.fetch),
    accountId: loaded.conn.accountId,
    host,
    zoneId,
    recordId,
    tunnelId,
    reserved: reservedHosts(settings.dashboardHost),
    withTunnelLock: tunnelLock(db),
    serverAddresses: [settings.serverIpv4, settings.serverIpv6].filter((a): a is string => !!a),
  });
  await system(db, "domain.cloudflare.unwire", "removed Cloudflare wiring for", label, !outcome.ok, outcome.message);
}

/** This server's addresses for the DNS check: the configured ones, plus the dashboard host's in direct mode. */
export function addressesFor(deps: Pick<EdgeGlobalDeps, "settings" | "dns">): Promise<ServerAddresses> {
  const s = deps.settings;
  return serverAddresses(deps.dns, { serverIpv4: s.serverIpv4, serverIpv6: s.serverIpv6 ?? null, dashboardHost: s.mode.ingress === "direct_tls" ? s.dashboardHost : null });
}

/**
 * One domain's DNS and TLS, written back to its row. A lookup that failed outright says nothing
 * about the records, so it never overwrites an earlier verdict: a resolver hiccup must not take a
 * live domain's router away. When the verdict moves into or out of "points here", the app's route
 * is synced, which adds or drops the domain's router.
 *
 * DNS is the fast path. In direct mode, a domain whose records name somewhere else (a proxy such as
 * Cloudflare's) or cannot be compared is then asked itself (edge/probe.ts); a domain that answers
 * with this server's value points here. Only then does it get a router, so Traefik asks Let's
 * Encrypt for a certificate only once the name leads to this server, proxy or not.
 */
export async function checkDomain(deps: Pick<EdgeGlobalDeps, "db" | "settings" | "dns" | "tls" | "now" | "probe">, domainId: string, here?: ServerAddresses): Promise<void> {
  const { db, settings } = deps;
  const d = await db.domain.findUnique({ where: { id: domainId }, select: { id: true, hostname: true, appId: true, dnsStatus: true, probeStatus: true, testDomain: true } });
  if (!d) return;
  const now = deps.now?.() ?? new Date();
  const server = here ?? (await addressesFor(deps));
  const dns = await checkDns(deps.dns, d.hostname, settings.mode.ingress, server);
  const keepVerdict = dns.lookupFailed && d.dnsStatus !== "unchecked";
  if (keepVerdict) {
    // A live test domain stays live; one still waiting says what it is waiting for.
    await db.domain.update({ where: { id: d.id }, data: { dnsCheckedAt: now, ...(d.testDomain && d.dnsStatus !== "ok" ? { dnsDetail: SSLIP_DOWN_MESSAGE } : {}) } });
    return;
  }
  // A test domain is only ever this server's own name. If the server's address has moved since, it
  // leads elsewhere, whatever the records say about the old address, and it gets no router.
  const movedFrom = d.testDomain ? foreignSpelledAddress(d.hostname, settings.serverIpv4) : null;
  if (movedFrom) {
    await db.domain.update({
      where: { id: d.id },
      data: { dnsStatus: "mismatch", dnsResolved: dns.resolved.slice(0, 16), dnsCheckedAt: now, dnsDetail: `This test domain spells ${movedFrom}, and this server is no longer there. Remove it and add a new one.`, tlsStatus: "pending", tlsIssuer: null, tlsExpiresAt: null },
    });
    if (d.dnsStatus === "ok") await enqueueRouteSync(db, d.appId);
    return;
  }
  // The records exist but do not name this server (or cannot be compared): ask the domain.
  // A test domain's records are sslip.io's answer: there is no proxy to ask through.
  const askDomain = !d.testDomain && settings.mode.ingress === "direct_tls" && !!deps.probe && !dns.lookupFailed && (dns.status === "mismatch" || dns.status === "unchecked");
  const probe = askDomain ? await deps.probe!(d.hostname, d.id).catch((e: unknown): ProbeResult => ({ status: "failed", detail: `The check could not run: ${e instanceof Error ? e.message : String(e)}` })) : null;
  // A live domain whose check got no answer at all (a timeout, a proxy's 5xx) keeps its route for one
  // more check: a bad minute at a proxy must not take a site down. Two in a row is not a bad minute.
  if (probe?.status === "failed" && probe.transient && d.dnsStatus === "ok" && d.probeStatus !== "failed") {
    await db.domain.update({
      where: { id: d.id },
      data: { dnsCheckedAt: now, probeStatus: "failed", probeDetail: `${probe.detail} The domain stays live until the next check.`.slice(0, 300), probeCheckedAt: now },
    });
    return;
  }
  const status = probe?.status === "passed" ? ("ok" as const) : dns.status;
  // Behind a proxy the records name the proxy, whose certificate is not the one this server holds:
  // a domain that passed the probe has its certificate read from this server itself.
  const tlsAt = probe?.status === "passed" && server.v4.length ? server.v4 : dns.addresses;
  const tls = status === "ok"
    ? await checkTls(deps.tls, d.hostname, tlsAt, settings.serverIpv4 ?? server.v4[0] ?? null, now)
    : { status: "pending" as const, issuer: null, expiresAt: null };
  await db.domain.update({
    where: { id: d.id },
    data: {
      dnsStatus: status,
      dnsResolved: dns.resolved.slice(0, 16),
      dnsCheckedAt: now,
      dnsDetail: status === "ok" ? null : d.testDomain ? SSLIP_DOWN_MESSAGE : dns.detail?.slice(0, 300) ?? null,
      probeStatus: probe ? probe.status : "untried",
      probeDetail: probe ? probe.detail.slice(0, 300) : null,
      probeCheckedAt: probe ? now : null,
      tlsStatus: tls.status,
      tlsIssuer: tls.issuer?.slice(0, 200) ?? null,
      tlsExpiresAt: tls.expiresAt,
    },
  });
  if ((d.dnsStatus === "ok") !== (status === "ok")) await enqueueRouteSync(db, d.appId);
}

export { dnsRecheckDelayMs };

/** Due when never checked, or when its delay has passed since the last check. */
export const dnsRecheckDue = (createdAt: Date, checkedAt: Date | null, now: number): boolean =>
  !checkedAt || now - checkedAt.getTime() >= dnsRecheckDelayMs(now - createdAt.getTime());

/**
 * Queues a check for each domain still waiting for its DNS (anything but "points here") or for its
 * certificate, which follows the DNS by seconds to minutes, on the backoff above. Domains older than two days are left to the 15 minute sweep. At most `limit` per
 * call, longest waiting first.
 */
export async function queueWaitingDnsChecks(db: Db, now = Date.now(), limit = 25): Promise<number> {
  const rows = await db.domain.findMany({
    where: { OR: [{ dnsStatus: { not: "ok" } }, { tlsStatus: "pending" }], createdAt: { gt: new Date(now - 2 * 86_400_000) } },
    select: { id: true, createdAt: true, dnsCheckedAt: true },
    orderBy: { dnsCheckedAt: { sort: "asc", nulls: "first" } },
    take: 200,
  });
  let n = 0;
  for (const r of rows) {
    if (n >= limit) break;
    if (!dnsRecheckDue(r.createdAt, r.dnsCheckedAt, now)) continue;
    await db.$transaction(async (tx) => {
      const key = `edge.dns.wait:${r.id}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      const open = await tx.job.findFirst({ where: { dedupeKey: key, completedAt: null, failedAt: null }, select: { id: true } });
      if (!open) await tx.job.create({ data: { kind: "dns_check", lane: "maintenance", payload: { domainId: r.id }, dedupeKey: key, maxAttempts: 2, runAfter: new Date(now) } });
    });
    n++;
  }
  return n;
}

/**
 * Tunnel mode, with Cloudflare connected: adds the dashboard's api rule to a tunnel made before
 * it existed. Without a stored Cloudflare token it cannot; `install.sh --upgrade --cf-token-file`
 * adds the same rule.
 */
async function ensureTunnelApiRule(deps: EdgeDeps): Promise<void> {
  const { db, settings } = deps;
  if (settings.mode.ingress !== "cloudflare_tunnel") return;
  const loaded = await loadCloudflare(db, deps.vault);
  if (!loaded.ok || !loaded.conn.tunnelId) return;
  const out = await ensureDashboardApiRule({
    cf: cfClient(loaded.conn.token, deps.fetch),
    accountId: loaded.conn.accountId,
    tunnelId: loaded.conn.tunnelId,
    dashboardHost: settings.dashboardHost,
    withTunnelLock: tunnelLock(db),
  });
  if (out === "added") {
    await system(db, "tunnel.api_route", "added the api route to", { type: "tunnel", id: loaded.conn.tunnelId, label: settings.dashboardHost }, false, "API tokens and GitHub now reach the api on the dashboard host.");
  }
}

export function edgeServerHandlers(deps: EdgeDeps): Record<string, EdgeJobHandler> {
  return {
    edge_route_sync: async (job) => {
      await syncAppRoute(deps, uuidField(obj(job.payload), "appId"));
    },
    reconcile: async () => {
      const { db, settings, serverId } = deps;
      await ensureSystemRoutes(deps.routes, deps.mode, settings.dashboardHost);
      const apps = await db.app.findMany({ where: { kind: { in: [...ROUTED_KINDS] }, ...appsHere(serverId) }, select: { id: true, desiredState: true } });
      // Preview route files (pv-<id>) belong to the preview reconcile; routed ones are kept here.
      const previews = await db.previewDeployment.findMany({ where: { env: { status: { in: ["building", "ready", "failed", "asleep"] } }, app: appsHere(serverId) }, select: { id: true } });
      await sweepRoutes(deps.routes, [...apps.map((a) => a.id), ...previews.map((p) => `pv-${p.id}`)]);
      // Every app's route again, on the deploy lane so a sync never runs during a swap: catches a
      // container Docker restarted, a file edited by hand, a start event the worker missed.
      for (const a of apps) await enqueueRouteSync(db, a.id);
      await ensureTunnelApiRule(deps).catch(() => {});
      await syncDashboardEdge({ ...deps, tunnelLock: tunnelLock(deps.db) }).catch(() => {});
    },
  };
}

export function edgeGlobalHandlers(deps: EdgeGlobalDeps): Record<string, EdgeJobHandler> {
  return {
    dashboard_domain: dashboardHandler({ ...deps, tunnelLock: tunnelLock(deps.db) }),
    edge_cf_wire: (job) => wire(deps, job),
    edge_cf_unwire: (job) => unwire(deps, job),
    dns_check: async (job, signal) => {
      const p = obj(job.payload);
      if (p.domainId !== undefined) return checkDomain(deps, uuidField(p, "domainId"));
      const here = await addressesFor(deps);
      const rows = await deps.db.domain.findMany({ select: { id: true }, orderBy: { dnsCheckedAt: { sort: "asc", nulls: "first" } }, take: 200 });
      for (const r of rows) {
        if (signal.aborted) return;
        await checkDomain(deps, r.id, here).catch(() => {});
      }
    },
  };
}
