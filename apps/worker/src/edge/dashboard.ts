import { dashboardDomain as D } from "@dockify/contracts";
import { enqueueTx, type Db, type Prisma, type SecretVault, type Tx } from "@dockify/db";
import type { ClaimedJob } from "../queue.ts";
import { cfClient, syncDashboardTunnel, type Fetch, type WireInput } from "./cloudflare.ts";
import { checkDnsFresh, dnsRecheckDelayMs, serverAddresses, type DnsLookup, type ZoneDns } from "./dns.ts";
import type { EdgeMode, EdgeSettings } from "./ingress.ts";
import { loadCloudflare } from "./integration.ts";
import type { RouteStore } from "../server/runtime.ts";
import type { ProbeResult } from "./probe.ts";
import { writeDashboardFiles } from "./routes.ts";
import { checkTls, type TlsProbe } from "./tls.ts";

/**
 * The dashboard's own address, on the edge. DOCKIFY_PUBLIC_URL says what the address is; the database
 * says what is being set up (instance.dashboardDomain) and what the dashboard left behind
 * (instance.dashboardPreviousHosts). This module keeps the route files and the tunnel in line with
 * them, and checks a new domain the same way an app's domain is checked: its DNS, then asking the
 * domain itself when its records name a proxy (edge/probe.ts).
 *
 *   waiting    the new domain does not lead here yet, or has no certificate yet. Rechecked on a backoff.
 *   ready      it answers and has its certificate; the owner can switch.
 *   switching  checked once more at the press of the key, then the updater takes over: it holds the
 *              Docker socket, rewrites .env and recreates the control services
 *              (apps/api/src/modules/platform/updates/domain-switch.ts).
 *   failed     the switch stopped and went back; the old address never stopped working.
 *
 * A certificate is asked for only once the name leads here, so Let's Encrypt's failure budget is never
 * spent on a typo. Nothing is served on the new name but the probe's path until the switch.
 */

export const DASHBOARD_JOB_KEY = "dashboard.domain";
export const DASHBOARD_APPLY_KEY = "dashboard.domain.apply";

export interface DashboardDeps {
  db: Db;
  vault: SecretVault;
  settings: EdgeSettings;
  /** The route files of the server the dashboard answers on, and that server's ingress. */
  routes: RouteStore;
  mode: EdgeMode;
  dns: DnsLookup;
  /** Asks the new name's own zone first, so no resolver's negative cache delays the check (edge/dns.ts). */
  zoneDns?: ZoneDns;
  tls: TlsProbe;
  probe?: (host: string, id: string) => Promise<ProbeResult>;
  fetch?: Fetch;
  now?: () => Date;
  tunnelLock: WireInput["withTunnelLock"];
}

async function readRow(db: Tx) {
  return db.instance.findUnique({ where: { id: 1 }, select: { dashboardDomain: true, dashboardPreviousHosts: true, dashboardLastChange: true } });
}

/**
 * The dashboard's other names, which no tenant may claim: a tenant route on one would hand that
 * tenant the owner's session cookie and step-up password. Never throws: a database that does not
 * answer here must not take an app's route away, and the current host is reserved regardless.
 */
export async function dashboardReservedHosts(db: Tx): Promise<string[]> {
  try {
    const row = await readRow(db);
    const pending = D.readPendingDomain(row?.dashboardDomain);
    return [...(row?.dashboardPreviousHosts ?? []), ...(pending ? [pending.host] : [])];
  } catch {
    return [];
  }
}

/** A router for the new name: always in tunnel mode (the probe needs it), in direct mode once the name leads here. */
const nextHost = (pending: D.PendingDomain | null, mode: EdgeSettings["mode"]): string | null => {
  if (!pending) return null;
  return mode.ingress === "cloudflare_tunnel" || pending.dns.status === "ok" ? pending.host : null;
};

/**
 * Route files and tunnel rules, from what the database says. In a tunnel the current host's rules are
 * added only right after a change of address, recorded in dashboardLastChange: a tunnel edited by hand
 * since keeps its own design.
 */
export async function syncDashboardEdge(deps: DashboardDeps, opts: { forget?: readonly string[]; addCurrent?: boolean } = {}): Promise<void> {
  const { db, settings } = deps;
  const row = await readRow(db);
  if (!row) return;
  const pending = D.readPendingDomain(row.dashboardDomain);
  const previous = row.dashboardPreviousHosts ?? [];
  await writeDashboardFiles(deps.routes, deps.mode, { current: settings.dashboardHost, next: nextHost(pending, deps.mode), previous });
  if (deps.mode.ingress !== "cloudflare_tunnel") return;
  const loaded = await loadCloudflare(db, deps.vault);
  if (!loaded.ok || !loaded.conn.tunnelId) return;
  const last = D.readLastChange(row.dashboardLastChange);
  await syncDashboardTunnel({
    cf: cfClient(loaded.conn.token, deps.fetch),
    accountId: loaded.conn.accountId,
    tunnelId: loaded.conn.tunnelId,
    dashboardHost: settings.dashboardHost,
    previous,
    forget: opts.forget ?? [],
    addCurrent: opts.addCurrent ?? last?.to === settings.dashboardHost,
    withTunnelLock: deps.tunnelLock,
  });
}

/**
 * How long a name on a managed Cloudflare zone waits for Dockify to make its record before it is looked
 * up anyway (the owner may have made it by hand). Making the record, or Check now, ends the wait at once.
 */
export const RECORD_FIRST_HOLD_MS = 10 * 60_000;

/** The pending name is waiting for Dockify to make its record: nothing looks it up yet. */
export const heldForRecord = (p: D.PendingDomain, now: number): boolean => !!p.recordFirst && !p.dns.checkedAt && now - Date.parse(p.requestedAt) < RECORD_FIRST_HOLD_MS;

/** Writes the check's result, under the lock Settings writes under, unless the owner cancelled or changed the domain meanwhile. */
async function savePending(db: Db, host: string, change: (p: D.PendingDomain) => D.PendingDomain, also?: (tx: Tx) => Promise<unknown>): Promise<D.PendingDomain | null> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dockify.dashboard.domain'))`;
    const row = await tx.instance.findUnique({ where: { id: 1 }, select: { dashboardDomain: true } });
    const now = D.readPendingDomain(row?.dashboardDomain);
    if (!now || now.host !== host) return null;
    const next = change(now);
    await tx.instance.update({ where: { id: 1 }, data: { dashboardDomain: next as unknown as Prisma.InputJsonValue } });
    await also?.(tx);
    return next;
  });
}

/**
 * One check of the domain being set up. With `switching`, a domain that still answers and has its
 * certificate moves on: in a tunnel its rules go in first (nothing else can route the name once the
 * dashboard moves), then the updater gets its job. Anything else leaves it waiting, with the reason.
 */
export async function checkDashboardDomain(deps: DashboardDeps, switching = false): Promise<void> {
  const { db, settings } = deps;
  const row = await readRow(db);
  const pending = D.readPendingDomain(row?.dashboardDomain);
  if (!pending) return;
  if (pending.phase === "switching" && !switching) return;
  const host = pending.host;
  const now = deps.now?.() ?? new Date();
  // Looked up before its record exists, the name would sit in resolvers' negative caches.
  if (!switching && heldForRecord(pending, now.getTime())) return;
  const at = now.toISOString();
  const ingress = deps.mode.ingress;
  const tunnel = ingress === "cloudflare_tunnel";

  // In a tunnel the probe has no way in until this route is there.
  if (tunnel) await writeDashboardFiles(deps.routes, deps.mode, { current: settings.dashboardHost, next: host, previous: row?.dashboardPreviousHosts ?? [] });

  const server = await serverAddresses(deps.dns, { serverIpv4: settings.serverIpv4, serverIpv6: settings.serverIpv6 ?? null, dashboardHost: tunnel ? null : settings.dashboardHost });
  const dns = await checkDnsFresh(deps.dns, deps.zoneDns, host, ingress, server);
  if (dns.lookupFailed) {
    // A resolver hiccup says nothing about the records: the last verdict stands, and a switch waits.
    await savePending(db, host, (p) => ({
      ...p,
      phase: p.phase === "switching" ? "ready" : p.phase,
      error: switching ? "The new domain could not be looked up just now. Try again in a moment." : p.error,
      dns: { ...p.dns, detail: dns.detail, checkedAt: at },
    }));
    return;
  }
  const askDomain = !!deps.probe && (tunnel ? dns.status === "ok" : dns.status === "mismatch" || dns.status === "unchecked");
  const probe = askDomain
    ? await deps.probe!(host, D.DASHBOARD_CHECK_ID).catch((e: unknown): ProbeResult => ({ status: "failed", detail: `The check could not run: ${e instanceof Error ? e.message : String(e)}` }))
    : null;
  const pointsHere = tunnel ? dns.status === "ok" && (!deps.probe || probe?.status === "passed") : dns.status === "ok" || probe?.status === "passed";

  // The certificate router only once the name leads here, then a read of what the name serves. Behind a
  // proxy in direct mode that is this server's own certificate; in a tunnel it is Cloudflare's, which is
  // the one visitors get.
  if (pointsHere && !tunnel) await writeDashboardFiles(deps.routes, deps.mode, { current: settings.dashboardHost, next: host, previous: row?.dashboardPreviousHosts ?? [] });
  const tlsAt = !tunnel && probe?.status === "passed" && server.v4.length ? server.v4 : dns.addresses;
  const tls = pointsHere
    ? await checkTls(deps.tls, host, tlsAt, settings.serverIpv4 ?? server.v4[0] ?? null, now)
    : { status: "pending" as const, issuer: null, expiresAt: null, detail: null };
  const ready = pointsHere && tls.status === "active";
  const proceed = switching && ready;

  // The rules go in before anything is recorded as switching, so a failure here leaves the switch unstarted.
  let stopped: string | null = null;
  if (proceed && tunnel) stopped = await addTunnelRules(deps, host, row?.dashboardPreviousHosts ?? []);

  await savePending(
    db,
    host,
    (p) => ({
      ...p,
      phase: proceed && !stopped ? "switching" : stopped ? "failed" : ready ? "ready" : "waiting",
      error: stopped ?? (switching && !ready ? `${host} stopped answering, so the dashboard stayed where it is. ${dns.detail ?? probe?.detail ?? tls.detail ?? ""}`.trim().slice(0, 300) : p.error && !switching && p.phase === "failed" ? p.error : null),
      dns: { status: pointsHere ? "ok" : dns.status, resolved: dns.resolved.slice(0, 16), detail: pointsHere ? null : dns.detail?.slice(0, 300) ?? null, checkedAt: at },
      probe: probe ? { status: probe.status, detail: probe.detail.slice(0, 300), checkedAt: at } : { status: "untried", detail: null, checkedAt: null },
      tls: { status: tls.status, issuer: tls.issuer?.slice(0, 200) ?? null, expiresAt: tls.expiresAt?.toISOString() ?? null, detail: tls.detail?.slice(0, 300) ?? null },
    }),
    proceed && !stopped ? (tx) => enqueueTx(tx, { kind: "dashboard_domain_apply", lane: "update", payload: { host, from: settings.dashboardHost }, dedupeKey: DASHBOARD_APPLY_KEY, maxAttempts: 3 }) : undefined,
  );
}

/** The new host's tunnel rules, or why they could not go in. Only Cloudflare's API can change a tunnel. */
async function addTunnelRules(deps: DashboardDeps, host: string, previous: readonly string[]): Promise<string | null> {
  const loaded = await loadCloudflare(deps.db, deps.vault);
  if (!loaded.ok) return `${loaded.reason} A tunnel's rules can only be changed through Cloudflare, so connect it in Settings, Integrations.`;
  if (!loaded.conn.tunnelId) return "No tunnel is recorded for this server, so the new domain cannot be routed.";
  try {
    await syncDashboardTunnel({
      cf: cfClient(loaded.conn.token, deps.fetch),
      accountId: loaded.conn.accountId,
      tunnelId: loaded.conn.tunnelId,
      dashboardHost: host,
      previous,
      addCurrent: true,
      withTunnelLock: deps.tunnelLock,
    });
    return null;
  } catch (e) {
    return `Cloudflare refused the tunnel's new rules: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
  }
}

/** Queues a check of a domain still waiting, on the same backoff as an app's domain. */
export async function queueDashboardCheck(db: Db, now = Date.now()): Promise<boolean> {
  const row = await db.instance.findUnique({ where: { id: 1 }, select: { dashboardDomain: true } });
  const p = D.readPendingDomain(row?.dashboardDomain);
  if (!p || (p.phase !== "waiting" && p.phase !== "ready")) return false;
  if (heldForRecord(p, now)) return false;
  const age = now - Date.parse(p.requestedAt);
  // Past two days a waiting domain is left to the owner's Check key, like an app's to the 15 minute sweep.
  if (age > 2 * 86_400_000) return false;
  const last = p.dns.checkedAt ? Date.parse(p.dns.checkedAt) : 0;
  if (now - last < dnsRecheckDelayMs(age)) return false;
  await db.$transaction((tx) => enqueueTx(tx, { kind: "dashboard_domain", lane: "maintenance", payload: {}, dedupeKey: DASHBOARD_JOB_KEY, maxAttempts: 2 }));
  return true;
}

/** The job: { switch?: true } checks and moves on; { forget?: host } drops an address's tunnel rules; {} syncs and checks. */
export function dashboardHandler(deps: DashboardDeps) {
  return async (job: ClaimedJob): Promise<void> => {
    const p = (job.payload && typeof job.payload === "object" ? job.payload : {}) as { switch?: unknown; forget?: unknown };
    const forget = typeof p.forget === "string" ? [p.forget] : [];
    // A tunnel that cannot be reached right now must not keep the check of the new domain from running.
    await syncDashboardEdge(deps, { forget }).catch(() => undefined);
    await checkDashboardDomain(deps, p.switch === true);
  };
}
