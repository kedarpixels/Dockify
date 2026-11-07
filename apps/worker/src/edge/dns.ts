import { Resolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { isPublicAddress } from "@dockify/net-guard";
import type { IngressMode } from "./ingress.ts";

/**
 * The DNS check for one domain: resolve its A, AAAA and CNAME records and judge them against what
 * the ingress mode needs. Its "ok" is what lets a domain get a Traefik router (edge/hosts.ts), so
 * Traefik only asks Let's Encrypt for names that lead here.
 *
 *   direct_tls          every A and AAAA record must be one of this server's addresses: the
 *                       configured DOCKIFY_SERVER_IPV4 (and DOCKIFY_SERVER_IPV6), plus whatever the
 *                       dashboard host resolves to, since in direct mode that record already leads
 *                       here (it covers a server behind NAT, where the interface address is
 *                       private). A CNAME chain is fine as long as it ends there. A record that
 *                       names somewhere else, such as a Cloudflare proxied one, is a mismatch here;
 *                       checkDomain (edge/jobs.ts) then asks the domain itself (edge/probe.ts).
 *   cloudflare_tunnel   the record must be proxied by Cloudflare, so public DNS answers with
 *                       Cloudflare edge addresses. An A record at the server itself is a mismatch:
 *                       in tunnel mode the server has no public port.
 */
export type DnsStatus = "ok" | "mismatch" | "missing" | "unchecked";

export interface DnsResult {
  status: DnsStatus;
  /** CNAME targets first ("cname:<target>"), then the A addresses, then the AAAA ones. */
  resolved: string[];
  /** Why the status is unchecked or mismatch, in one line for the UI. */
  detail: string | null;
  /** The A addresses alone, for the TLS probe. */
  addresses: string[];
  /** True when the lookups themselves failed, so the result says nothing about the records. */
  lookupFailed: boolean;
}

export interface DnsLookup {
  resolve4(host: string): Promise<string[]>;
  resolveCname(host: string): Promise<string[]>;
  /** Optional: a lookup without it sees no AAAA records. */
  resolve6?(host: string): Promise<string[]>;
}

/** The addresses that count as this server. */
export interface ServerAddresses {
  v4: string[];
  v6: string[];
}

/** Public resolvers, a short timeout and one retry: the check runs inside a request or a job. */
export function publicResolver(servers = ["1.1.1.1", "8.8.8.8"], timeoutMs = 3000): DnsLookup {
  const r = new Resolver({ timeout: timeoutMs, tries: 2 });
  r.setServers(servers);
  return { resolve4: (h) => r.resolve4(h), resolve6: (h) => r.resolve6(h), resolveCname: (h) => r.resolveCname(h) };
}

/** What finding a zone's own nameservers needs: their names, then their addresses. */
export interface ZoneLookup {
  resolveNs(host: string): Promise<string[]>;
  resolve4(host: string): Promise<string[]>;
}

/** The lookups for finding a zone's nameservers, through the same public resolvers. */
export function publicZoneLookup(servers = ["1.1.1.1", "8.8.8.8"], timeoutMs = 3000): ZoneLookup {
  const r = new Resolver({ timeout: timeoutMs, tries: 2 });
  r.setServers(servers);
  return { resolveNs: (h) => r.resolveNs(h), resolve4: (h) => r.resolve4(h) };
}

/** At most this many nameservers are asked, and at most this many labels walked. */
const MAX_ZONE_SERVERS = 4;
const MAX_LABELS = 12;

/**
 * The public IPv4 addresses of the nameservers of the zone that holds `host`, or [] when they cannot
 * be found. The zone is the deepest of host's parents with NS records, found from the top down. The
 * name itself is never asked about here: a public resolver that heard "no such name" keeps saying it
 * for the zone's negative TTL (30 minutes on Cloudflare), and the record may be minutes from existing.
 * A top-level domain alone is never taken as the zone. Only public addresses are kept, so the
 * question can only go to a public DNS server, whatever a zone's owner set as its nameservers.
 */
export async function zoneServers(lookup: ZoneLookup, host: string): Promise<string[]> {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length < 3 || labels.length > MAX_LABELS) return [];
  let names: string[] = [];
  for (let i = labels.length - 2; i >= 1; i--) {
    const r = await soft(() => lookup.resolveNs(labels.slice(i).join(".")));
    if (r.ok) {
      if (r.value.length) names = r.value;
      continue;
    }
    // No such name: nothing under it exists either. A name with no NS of its own is not a zone.
    if (r.code === "ENODATA") continue;
    if (r.missing) break;
    return [];
  }
  const ips: string[] = [];
  for (const ns of [...new Set(names.map((n) => n.toLowerCase().replace(/\.$/, "")))].sort().slice(0, MAX_ZONE_SERVERS)) {
    const a = await soft(() => lookup.resolve4(ns));
    if (a.ok) for (const ip of a.value) if (isPublicAddress(ip) && !ips.includes(ip)) ips.push(ip);
  }
  return ips.slice(0, MAX_ZONE_SERVERS);
}

/** A lookup that asks the zone's own nameservers, which hold no cache; null when they cannot be found. */
export type ZoneDns = (host: string) => Promise<DnsLookup | null>;

export function zoneDns(lookup: ZoneLookup = publicZoneLookup(), timeoutMs = 3000): ZoneDns {
  return async (host) => {
    const servers = await zoneServers(lookup, host);
    if (!servers.length) return null;
    const r = new Resolver({ timeout: timeoutMs, tries: 2 });
    r.setServers(servers);
    return { resolve4: (h) => r.resolve4(h), resolve6: (h) => r.resolve6(h), resolveCname: (h) => r.resolveCname(h) };
  };
}

/**
 * checkDns for a name whose record was made moments ago: the zone's own nameservers answer first, so
 * no negative cache stands between a new record and the check. When they say the name does not exist
 * (NXDOMAIN), that is the answer: asking a public resolver then would only plant "no such name" in its
 * cache, for every visitor, for the zone's negative TTL. When they cannot be found or asked, or have
 * the name but no address for it (a CNAME that leads out of the zone, a name that is a zone of its
 * own), the public resolvers decide, as before.
 */
export async function checkDnsFresh(lookup: DnsLookup, zone: ZoneDns | undefined, host: string, ingress: IngressMode, server: string | null | ServerAddresses): Promise<DnsResult> {
  const at = zone ? await zone(host).catch(() => null) : null;
  if (at) {
    const r = await checkDns(at, host, ingress, server);
    if (!r.lookupFailed && r.status !== "missing") return r;
    if (r.status === "missing" && !r.resolved.length) {
      const asked = await soft(() => at.resolve4(host));
      if (!asked.ok && asked.code === "ENOTFOUND") return r;
    }
  }
  return checkDns(lookup, host, ingress, server);
}

/** Cloudflare's published edge ranges (cloudflare.com/ips). */
const CF_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];
const CF_V6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];
const cloudflareEdge = new BlockList();
for (const cidr of CF_V4) {
  const [net = "", bits = "32"] = cidr.split("/");
  cloudflareEdge.addSubnet(net, Number(bits), "ipv4");
}
for (const cidr of CF_V6) {
  const [net = "", bits = "128"] = cidr.split("/");
  cloudflareEdge.addSubnet(net, Number(bits), "ipv6");
}
export const isCloudflareEdge = (ip: string): boolean => {
  const family = isIP(ip);
  return family === 4 ? cloudflareEdge.check(ip, "ipv4") : family === 6 ? cloudflareEdge.check(ip, "ipv6") : false;
};

const NOT_FOUND = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);
const codeOf = (e: unknown): string => (typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : "");

async function soft(fn: () => Promise<string[]>): Promise<{ ok: true; value: string[] } | { ok: false; missing: boolean; code: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const code = codeOf(e);
    return { ok: false, missing: NOT_FOUND.has(code), code };
  }
}

/** One spelling per address, so a configured address and a resolved one compare equal. */
const canon = (ip: string): string => {
  if (isIP(ip) !== 6) return ip;
  try {
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return ip.toLowerCase();
  }
};

const asServer = (server: string | null | ServerAddresses): ServerAddresses =>
  typeof server === "string" ? { v4: [server], v6: [] } : server ?? { v4: [], v6: [] };

/**
 * Judges one host's records. `server` is this server's addresses; a bare IPv4 string still works
 * for callers that know only DOCKIFY_SERVER_IPV4.
 */
export async function checkDns(lookup: DnsLookup, host: string, ingress: IngressMode, server: string | null | ServerAddresses): Promise<DnsResult> {
  const here = asServer(server);
  const [a, aaaa, cname] = await Promise.all([
    soft(() => lookup.resolve4(host)),
    lookup.resolve6 ? soft(() => lookup.resolve6!(host)) : Promise.resolve({ ok: true as const, value: [] as string[] }),
    soft(() => lookup.resolveCname(host)),
  ]);
  const cnames = cname.ok ? cname.value.map((c) => c.toLowerCase().replace(/\.$/, "")) : [];
  const v4 = a.ok ? [...new Set(a.value)].sort() : [];
  const v6 = aaaa.ok ? [...new Set(aaaa.value.map(canon))].sort() : [];
  const resolved = [...cnames.map((c) => `cname:${c}`), ...v4, ...v6];
  const base = { resolved, addresses: v4, lookupFailed: false };

  const failed = [a, aaaa].find((r) => !r.ok && !r.missing) as { code: string } | undefined;
  if (failed) {
    return { ...base, status: "unchecked", lookupFailed: true, detail: `DNS lookup failed (${failed.code || "error"}). Try again shortly.` };
  }
  if (v4.length === 0 && v6.length === 0) {
    return { ...base, status: "missing", detail: `No A or AAAA record for ${host} yet.` };
  }
  const all = [...v4, ...v6];

  if (ingress === "direct_tls") {
    const mine = new Set([...here.v4, ...here.v6.map(canon)]);
    if (mine.size === 0) return { ...base, status: "unchecked", detail: "The server address is not configured, so DNS cannot be compared." };
    const wrong = all.filter((ip) => !mine.has(ip));
    if (wrong.length === 0) return { ...base, status: "ok", detail: null };
    const target = [...here.v4, ...here.v6].join(" or ");
    const v6Unknown = here.v6.length === 0 && wrong.every((ip) => isIP(ip) === 6);
    return {
      ...base,
      status: "mismatch",
      detail: wrong.every(isCloudflareEdge)
        ? `${host} is proxied by Cloudflare, so its records name Cloudflare, not ${target}.`
        : v6Unknown
          ? `${host} has an AAAA record (${wrong.join(", ")}), and this server's IPv6 address is not known. Remove the AAAA record, or set DOCKIFY_SERVER_IPV6.`
          : `${host} points at ${wrong.join(", ")}, not ${target}.`,
    };
  }

  if (all.every(isCloudflareEdge)) return { ...base, status: "ok", detail: null };
  if (here.v4.some((ip) => v4.includes(ip)) || here.v6.some((ip) => v6.includes(canon(ip)))) {
    return { ...base, status: "mismatch", detail: `${host} points straight at the server. Tunnel mode needs a proxied CNAME to the tunnel.` };
  }
  return { ...base, status: "mismatch", detail: `${host} is not proxied through Cloudflare.` };
}

/**
 * How long a domain that does not point here yet waits before its next check: a tenth of its age,
 * between 30 seconds and 15 minutes (the full sweep's interval). A record is usually added minutes
 * after the domain, so a new domain is retried quickly and an old one slowly.
 */
export function dnsRecheckDelayMs(ageMs: number): number {
  return Math.min(15 * 60_000, Math.max(30_000, Math.floor(ageMs / 10)));
}

/**
 * This server's addresses for the direct-mode check: the configured ones plus what the dashboard
 * host resolves to. A dashboard lookup that fails adds nothing; the configured ones still count.
 * A Cloudflare edge address never counts: thousands of unrelated sites share it.
 */
export async function serverAddresses(lookup: DnsLookup, o: { serverIpv4: string | null; serverIpv6: string | null; dashboardHost: string | null }): Promise<ServerAddresses> {
  const v4 = new Set<string>(o.serverIpv4 ? [o.serverIpv4] : []);
  const v6 = new Set<string>(o.serverIpv6 ? [canon(o.serverIpv6)] : []);
  if (o.dashboardHost) {
    const [a, aaaa] = await Promise.all([soft(() => lookup.resolve4(o.dashboardHost!)), lookup.resolve6 ? soft(() => lookup.resolve6!(o.dashboardHost!)) : Promise.resolve(null)]);
    if (a?.ok) for (const ip of a.value) if (isIP(ip) === 4 && !isCloudflareEdge(ip)) v4.add(ip);
    if (aaaa?.ok) for (const ip of aaaa.value) if (isIP(ip) === 6 && !isCloudflareEdge(ip)) v6.add(canon(ip));
  }
  return { v4: [...v4], v6: [...v6] };
}
