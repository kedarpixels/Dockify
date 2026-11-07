import { assertTenantHost, normalizeHost } from "./hostnames.ts";
import { API_PATH_PREFIX, API_UPSTREAM, TUNNEL_SERVICE, WEB_UPSTREAM } from "./ingress.ts";

/**
 * Cloudflare automation, ported from the old api's cloudflare.ts with its two defects fixed:
 *
 *   1. Nothing is adopted or overwritten. Wiring refuses when the hostname already has any DNS
 *      record or any tunnel rule, and reports it as "external" instead.
 *   2. Teardown deletes only what Dockify recorded: the record by its stored id (and only while it
 *      still is the tunnel CNAME we made), and the tunnel rule only when it still points at our
 *      proxy service. Hand-made records and rules are never touched.
 *
 * The tunnel is the one the installer recorded for this box (by id, never looked up by name or
 * position). Tunnel config edits are a read-modify-write, so the caller serialises them with
 * `withTunnelLock`. The token goes only in the Authorization header and is never logged.
 */

const CF_API = "https://api.cloudflare.com/client/v4";
const CF_TIMEOUT_MS = 15_000;
const TUNNEL_SUFFIX = ".cfargotunnel.com";
const CATCH_ALL = "http_status:404";
const TUNNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CF_ID = /^[0-9a-f]{32}$/;

export class CfError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CfError";
    this.status = status;
  }
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface CfClient {
  call<T>(path: string, init?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown }): Promise<T>;
}

export function cfClient(token: string, fetchImpl: Fetch = fetch as unknown as Fetch): CfClient {
  return {
    async call<T>(path: string, init: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown } = {}): Promise<T> {
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (init.body !== undefined) headers["content-type"] = "application/json";
      let res;
      try {
        res = await fetchImpl(`${CF_API}${path}`, {
          method: init.method ?? "GET",
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal: AbortSignal.timeout(CF_TIMEOUT_MS),
        });
      } catch (e) {
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        throw new CfError(timedOut ? "Cloudflare did not respond in time" : "Could not reach Cloudflare", 0);
      }
      const text = await res.text().catch(() => "");
      let env: { success?: boolean; errors?: { message?: string }[]; result?: T } | null = null;
      try {
        env = text ? JSON.parse(text) : null;
      } catch {
        env = null;
      }
      if (!res.ok || !env || env.success === false) {
        throw new CfError(env?.errors?.[0]?.message?.slice(0, 300) ?? `Cloudflare returned ${res.status}`, res.status);
      }
      return env.result as T;
    },
  };
}

interface CfZone { id: string; name: string; status: string }
interface CfRecord { id: string; type: string; name: string; content: string; proxied?: boolean }
export interface CfIngress { hostname?: string; service?: string; path?: string; [k: string]: unknown }
interface CfTunnelConfig { config?: ({ ingress?: CfIngress[] } & Record<string, unknown>) | null }

const enc = encodeURIComponent;

/**
 * The managed zone that owns `host`: walks the host's suffixes longest first and asks for each by
 * exact name, so the account's zone count never matters. Only zones the owner marked managed in
 * Dockify count; a zone the token can see but nobody opted in is never written to.
 */
export async function findZoneForHost(cf: CfClient, host: string, managedZoneIds: ReadonlySet<string>): Promise<CfZone | null> {
  const labels = host.split(".");
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join(".");
    const zones = await cf.call<CfZone[]>(`/zones?name=${enc(name)}&per_page=5`);
    const zone = zones.find((z) => z.name === name);
    if (zone) return managedZoneIds.has(zone.id) ? zone : null;
  }
  return null;
}

const tunnelConfigPath = (accountId: string, tunnelId: string) => `/accounts/${enc(accountId)}/cfd_tunnel/${enc(tunnelId)}/configurations`;

/** Inserts `rule` ahead of the trailing catch-all, keeping every other entry exactly as it was. */
export function withRule(ingress: CfIngress[], rule: CfIngress): CfIngress[] {
  const last = ingress[ingress.length - 1];
  if (last && !last.hostname) return [...ingress.slice(0, -1), rule, last];
  return [...ingress, rule, { service: CATCH_ALL }];
}

/** Our rule for `host`: that exact hostname, no path, pointing at our proxy service. */
export const isOurRule = (r: CfIngress, host: string): boolean =>
  r.hostname === host && r.service === TUNNEL_SERVICE && (r.path === undefined || r.path === "");

export interface WireInput {
  cf: CfClient;
  accountId: string;
  /** The tunnel the installer recorded for this box. */
  tunnelId: string;
  host: string;
  reserved: Set<string>;
  managedZoneIds: ReadonlySet<string>;
  withTunnelLock: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Set on a retry of a job that had already started adding the rule, so a rule we added before a
   * crash is recognised as ours instead of being reported as hand-made.
   */
  resumingRule: boolean;
  /** Persists "about to add the rule" before the PUT, so a retry can tell. */
  markRuleIntent: () => Promise<void>;
}

export type WireOutcome =
  | { state: "managed"; zoneId: string; recordId: string; tunnelId: string; message: string }
  | { state: "external"; message: string }
  | { state: "failed"; message: string };

export async function wireDomain(w: WireInput): Promise<WireOutcome> {
  const host = assertTenantHost(w.host, w.reserved);
  if (!TUNNEL_ID.test(w.tunnelId)) return { state: "failed", message: "The recorded tunnel id is not valid. Reconnect Cloudflare." };
  const { cf } = w;

  const zone = await findZoneForHost(cf, host, w.managedZoneIds);
  if (!zone) return { state: "external", message: `${host} is not on a Cloudflare zone Dockify manages. Add the DNS record yourself.` };

  const existing = await cf.call<CfRecord[]>(`/zones/${enc(zone.id)}/dns_records?name=${enc(host)}&per_page=20`);
  const target = `${w.tunnelId}${TUNNEL_SUFFIX}`;
  const ours = existing.find((r) => r.type === "CNAME" && r.name === host && r.content === target && w.resumingRule);
  if (existing.length > 0 && !ours) {
    return { state: "external", message: `${host} already has a ${existing[0]?.type ?? "DNS"} record on Cloudflare. Dockify left it alone.` };
  }

  const path = tunnelConfigPath(w.accountId, w.tunnelId);
  const added = await w.withTunnelLock(async () => {
    const current = await cf.call<CfTunnelConfig>(path);
    const config = current.config ?? {};
    const ingress = Array.isArray(config.ingress) ? config.ingress : [];
    const present = ingress.filter((r) => r.hostname === host);
    if (present.length > 0) {
      if (w.resumingRule && present.length === 1 && isOurRule(present[0]!, host)) return "resumed" as const;
      return "conflict" as const;
    }
    await w.markRuleIntent();
    await cf.call(path, { method: "PUT", body: { config: { ...config, ingress: withRule(ingress, { hostname: host, service: TUNNEL_SERVICE }) } } });
    return "added" as const;
  });
  if (added === "conflict") {
    return { state: "external", message: `The tunnel already has a rule for ${host}. Dockify left it alone.` };
  }

  if (ours) return { state: "managed", zoneId: zone.id, recordId: ours.id, tunnelId: w.tunnelId, message: `Routed ${host} through the tunnel.` };
  try {
    const record = await cf.call<CfRecord>(`/zones/${enc(zone.id)}/dns_records`, {
      method: "POST",
      body: { type: "CNAME", name: host, content: target, ttl: 1, proxied: true, comment: "Managed by Dockify" },
    });
    return { state: "managed", zoneId: zone.id, recordId: record.id, tunnelId: w.tunnelId, message: `Routed ${host} through the tunnel.` };
  } catch (e) {
    // Undo only the rule this run added; the record was never created.
    await removeOurRule(w, host, w.tunnelId).catch(() => {});
    return { state: "failed", message: `Creating the DNS record failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function removeOurRule(
  w: { cf: CfClient; accountId: string; withTunnelLock: WireInput["withTunnelLock"] },
  host: string,
  tunnelId: string,
): Promise<"removed" | "absent" | "foreign"> {
  const path = tunnelConfigPath(w.accountId, tunnelId);
  return w.withTunnelLock(async () => {
    const current = await w.cf.call<CfTunnelConfig>(path);
    const config = current.config ?? {};
    const ingress = Array.isArray(config.ingress) ? config.ingress : [];
    const forHost = ingress.filter((r) => r.hostname === host);
    if (forHost.length === 0) return "absent";
    const next = ingress.filter((r) => !isOurRule(r, host));
    if (next.length === ingress.length) return "foreign";
    await w.cf.call(path, { method: "PUT", body: { config: { ...config, ingress: next } } });
    return "removed";
  });
}

export interface UnwireInput {
  cf: CfClient;
  accountId: string;
  host: string;
  /** Exactly what the Domain row recorded. */
  zoneId: string;
  recordId: string;
  /** The tunnel recorded at wire time, when known; otherwise read from the record we made. */
  tunnelId: string | null;
  reserved: Set<string>;
  withTunnelLock: WireInput["withTunnelLock"];
  /** This server's addresses: an A or AAAA record Dockify made in direct mode still names one. */
  serverAddresses?: readonly string[];
}

export interface UnwireOutcome {
  ok: boolean;
  record: "deleted" | "absent" | "changed";
  rule: "removed" | "absent" | "foreign" | "skipped";
  message: string;
}

/**
 * Removes what wireDomain created, by the recorded ids. A record someone has since edited (other
 * name, other target) is left in place, and so is any tunnel rule that is not exactly ours.
 */
export async function unwireDomain(u: UnwireInput): Promise<UnwireOutcome> {
  const host = normalizeHost(u.host);
  if (u.reserved.has(host)) return { ok: false, record: "changed", rule: "skipped", message: `${host} is reserved; nothing was changed.` };
  if (!CF_ID.test(u.zoneId) || !CF_ID.test(u.recordId)) return { ok: false, record: "changed", rule: "skipped", message: "The recorded Cloudflare ids are not valid." };
  const recordPath = `/zones/${enc(u.zoneId)}/dns_records/${enc(u.recordId)}`;

  let record: CfRecord | null = null;
  try {
    record = await u.cf.call<CfRecord>(recordPath);
  } catch (e) {
    if (!(e instanceof CfError && e.status === 404)) throw e;
  }
  const fromRecord = record?.content.endsWith(TUNNEL_SUFFIX) ? record.content.slice(0, -TUNNEL_SUFFIX.length) : null;
  const tunnelId = u.tunnelId ?? fromRecord;
  // Direct mode's record, made from the Domains page: still at this name, still naming this server.
  const directIsOurs = !!record && (record.type === "A" || record.type === "AAAA") && record.name === host && !!u.serverAddresses?.includes(record.content);
  const recordIsOurs = directIsOurs || (!!record && record.type === "CNAME" && record.name === host && !!fromRecord && (u.tunnelId === null || fromRecord === u.tunnelId));

  // A direct-mode record has no tunnel behind it, so there is no rule to look for.
  const rule = tunnelId && TUNNEL_ID.test(tunnelId) ? await removeOurRule(u, host, tunnelId) : directIsOurs ? "absent" : "skipped";

  let recordState: UnwireOutcome["record"] = "absent";
  if (record && recordIsOurs) {
    await u.cf.call(recordPath, { method: "DELETE" });
    recordState = "deleted";
  } else if (record) {
    recordState = "changed";
  }

  const problems: string[] = [];
  if (recordState === "changed") problems.push("the DNS record was edited by hand, so it was left in place");
  if (rule === "foreign") problems.push("the tunnel rule was edited by hand, so it was left in place");
  if (rule === "skipped") problems.push("the tunnel could not be identified, so its rule was not checked");
  return problems.length
    ? { ok: false, record: recordState, rule, message: `Removed ${host}, but ${problems.join("; ")}.` }
    : { ok: true, record: recordState, rule, message: `Removed ${host} and the Cloudflare record and tunnel rule Dockify made for it.` };
}

// ------------------------------------------------------------------ the dashboard's api path

/** The tunnel rule that sends the api's prefix on the dashboard host to the api (installer render_tunnel_ingress). */
export const dashboardApiRule = (dashboardHost: string): CfIngress => ({ hostname: dashboardHost, path: `^${API_PATH_PREFIX}`, service: API_UPSTREAM });

/**
 * Adds the dashboard's api rule to a tunnel the installer made before the api had its own path on
 * the dashboard host, so API tokens, GitHub's webhook and GitHub's return URLs reach the api on
 * those installs too. cloudflared takes the first rule that matches, so it goes
 * right above the dashboard's own rule. Nothing else changes: a tunnel with no plain dashboard
 * rule (edited by hand), or with any rule for that path already, is left exactly as it is.
 */
export async function ensureDashboardApiRule(o: {
  cf: CfClient;
  accountId: string;
  tunnelId: string;
  dashboardHost: string;
  withTunnelLock: WireInput["withTunnelLock"];
}): Promise<"added" | "present" | "skipped"> {
  if (!TUNNEL_ID.test(o.tunnelId)) return "skipped";
  const host = normalizeHost(o.dashboardHost);
  const rule = dashboardApiRule(host);
  const path = tunnelConfigPath(o.accountId, o.tunnelId);
  return o.withTunnelLock(async () => {
    const current = await o.cf.call<CfTunnelConfig>(path);
    const config = current.config ?? {};
    const ingress = Array.isArray(config.ingress) ? config.ingress : [];
    if (ingress.some((r) => r.hostname === host && r.path === rule.path)) return "present";
    const at = ingress.findIndex((r) => r.hostname === host && (r.path === undefined || r.path === ""));
    if (at < 0) return "skipped";
    const next = [...ingress.slice(0, at), rule, ...ingress.slice(at)];
    await o.cf.call(path, { method: "PUT", body: { config: { ...config, ingress: next } } });
    return "added";
  });
}

/** Rules Dockify gives the dashboard's hosts: the api, the web, or the proxy for a host it left. */
const DASHBOARD_SERVICES = new Set([API_UPSTREAM, WEB_UPSTREAM, TUNNEL_SERVICE, "http://dockify-proxy:80"]);

/**
 * The tunnel's rules for the dashboard's address, as a change of address needs them. Only rules for
 * those hosts move, and only ones Dockify could have written:
 *
 *   the current host   the api path and the web, right at the top, when addCurrent says it is new
 *   a host it left     its api path stays on the api, for GitHub; the rest goes to the proxy, whose
 *                      router redirects (edge/routes.ts renderDashboardOld)
 *   a host forgotten   its rules go
 *
 * Nothing is written when nothing has to change. A first-match table, so a rule for the current host
 * goes above everything; the hostnames are exact, so no other rule can shadow it.
 */
export async function syncDashboardTunnel(o: {
  cf: CfClient;
  accountId: string;
  tunnelId: string;
  dashboardHost: string;
  previous: readonly string[];
  forget?: readonly string[];
  addCurrent: boolean;
  withTunnelLock: WireInput["withTunnelLock"];
}): Promise<"changed" | "unchanged" | "skipped"> {
  if (!TUNNEL_ID.test(o.tunnelId)) return "skipped";
  const host = normalizeHost(o.dashboardHost);
  const previous = new Set(o.previous.map(normalizeHost));
  const forget = new Set((o.forget ?? []).map(normalizeHost));
  const apiRule = dashboardApiRule(host);
  const path = tunnelConfigPath(o.accountId, o.tunnelId);
  return o.withTunnelLock(async () => {
    const current = await o.cf.call<CfTunnelConfig>(path);
    const config = current.config ?? {};
    const ingress = Array.isArray(config.ingress) ? config.ingress : [];
    const isPlain = (r: CfIngress) => r.path === undefined || r.path === "";
    let next = ingress.filter((r) => !(r.hostname && forget.has(r.hostname) && DASHBOARD_SERVICES.has(r.service ?? "")));
    next = next.map((r) => {
      if (r.hostname && previous.has(r.hostname) && isPlain(r) && r.service === WEB_UPSTREAM) return { ...r, service: TUNNEL_SERVICE };
      // Back on a host it left: the rule that sent it to the redirect serves the dashboard again.
      if (r.hostname === host && isPlain(r) && r.service !== undefined && DASHBOARD_SERVICES.has(r.service)) return { ...r, service: WEB_UPSTREAM };
      return r;
    });
    if (o.addCurrent) {
      const missing: CfIngress[] = [];
      if (!next.some((r) => r.hostname === host && r.path === apiRule.path)) missing.push(apiRule);
      if (!next.some((r) => r.hostname === host && isPlain(r))) missing.push({ hostname: host, service: WEB_UPSTREAM });
      next = [...missing, ...next];
    }
    if (JSON.stringify(next) === JSON.stringify(ingress)) return "unchanged";
    await o.cf.call(path, { method: "PUT", body: { config: { ...config, ingress: next } } });
    return "changed";
  });
}

// ------------------------------------------------------------------ preview wildcard

export interface WildcardInput {
  cf: CfClient;
  accountId: string | null;
  /** Tunnel mode: the tunnel the wildcard CNAME and rule point at. Null in direct mode. */
  tunnelId: string | null;
  /** Direct mode: the A record target. */
  serverIpv4: string | null;
  /** The preview domain; the record is *.<domain>. */
  domain: string;
  reserved: Set<string>;
  managedZoneIds: ReadonlySet<string>;
  withTunnelLock: WireInput["withTunnelLock"];
}

/**
 * One wildcard record for a preview domain: a proxied CNAME to the tunnel plus the tunnel rule
 * (tunnel mode), or a DNS-only A record to the server (direct mode). Like wireDomain, nothing that
 * already exists is adopted or overwritten; the ids of what Dockify made are returned.
 */
export async function wireWildcard(w: WildcardInput): Promise<WireOutcome> {
  const domain = assertTenantHost(w.domain, w.reserved);
  const name = `*.${domain}`;
  const { cf } = w;
  const zone = await findZoneForHost(cf, domain, w.managedZoneIds);
  if (!zone) return { state: "external", message: `${domain} is not on a Cloudflare zone Dockify manages. Create ${name} yourself.` };
  const existing = await cf.call<CfRecord[]>(`/zones/${enc(zone.id)}/dns_records?name=${enc(name)}&per_page=20`);
  const tunnel = w.tunnelId;
  if (tunnel !== null && !TUNNEL_ID.test(tunnel)) return { state: "failed", message: "The recorded tunnel id is not valid. Reconnect Cloudflare." };
  if (tunnel === null && !w.serverIpv4) return { state: "failed", message: "The server address is not configured, so the A record cannot be made." };
  const target = tunnel ? `${tunnel}${TUNNEL_SUFFIX}` : w.serverIpv4!;
  if (existing.length > 0) return { state: "external", message: `${name} already has a ${existing[0]?.type ?? "DNS"} record on Cloudflare. Dockify left it alone.` };

  if (tunnel && w.accountId) {
    const path = tunnelConfigPath(w.accountId, tunnel);
    const added = await w.withTunnelLock(async () => {
      const current = await cf.call<CfTunnelConfig>(path);
      const config = current.config ?? {};
      const ingress = Array.isArray(config.ingress) ? config.ingress : [];
      const present = ingress.filter((r) => r.hostname === name);
      if (present.length > 0) return present.length === 1 && isOurRule(present[0]!, name) ? "present" : "conflict";
      await cf.call(path, { method: "PUT", body: { config: { ...config, ingress: withRule(ingress, { hostname: name, service: TUNNEL_SERVICE }) } } });
      return "added";
    });
    if (added === "conflict") return { state: "external", message: `The tunnel already has a rule for ${name}. Dockify left it alone.` };
  }
  const record = await cf.call<CfRecord>(`/zones/${enc(zone.id)}/dns_records`, {
    method: "POST",
    body: { type: tunnel ? "CNAME" : "A", name, content: target, ttl: 1, proxied: !!tunnel, comment: "Managed by Dockify (previews)" },
  });
  return { state: "managed", zoneId: zone.id, recordId: record.id, tunnelId: tunnel ?? "", message: `Created ${name} on Cloudflare.` };
}

/** Removes exactly what wireWildcard made, by the recorded ids, and only while it is unchanged. */
export async function unwireWildcard(u: { cf: CfClient; accountId: string | null; domain: string; zoneId: string; recordId: string; tunnelId: string | null; withTunnelLock: WireInput["withTunnelLock"] }): Promise<{ ok: boolean; message: string }> {
  const name = `*.${normalizeHost(u.domain)}`;
  if (!CF_ID.test(u.zoneId) || !CF_ID.test(u.recordId)) return { ok: false, message: "The recorded Cloudflare ids are not valid." };
  const recordPath = `/zones/${enc(u.zoneId)}/dns_records/${enc(u.recordId)}`;
  let record: CfRecord | null = null;
  try {
    record = await u.cf.call<CfRecord>(recordPath);
  } catch (e) {
    if (!(e instanceof CfError && e.status === 404)) throw e;
  }
  if (record && record.name === name) await u.cf.call(recordPath, { method: "DELETE" });
  if (u.tunnelId && TUNNEL_ID.test(u.tunnelId) && u.accountId) await removeOurRule({ cf: u.cf, accountId: u.accountId, withTunnelLock: u.withTunnelLock }, name, u.tunnelId);
  return { ok: !record || record.name === name, message: record && record.name !== name ? `${name} was edited by hand, so it was left in place.` : `Removed ${name}.` };
}
