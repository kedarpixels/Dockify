import { nonPublicHostReason } from "@dockify/contracts";
import { normalizeHost } from "./hostnames.ts";

/** A domain row as the route writers see it. */
export interface DomainDns {
  hostname: string;
  /** What the last dns_check found: ok, mismatch, missing or unchecked. */
  dnsStatus: string;
}

/**
 * The hosts that get a Traefik router. A domain is routed only once its DNS points at
 * this server, so Traefik never asks Let's Encrypt for a name that does not lead here and never
 * spends the account's failure budget on it. A domain the check could not judge (unchecked: the
 * resolvers failed, or the server address is unknown) keeps a router it already has, so a lookup
 * failure never takes a live site down, but it does not get a first one. Reserved names and names
 * that can never be public are never routed, whatever a row says. Order is kept, so the caller's
 * primary domain stays first.
 */
export function routableHosts(domains: readonly DomainDns[], opts: { routed?: ReadonlySet<string>; reserved?: ReadonlySet<string> } = {}): string[] {
  const out: string[] = [];
  for (const d of domains) {
    const host = normalizeHost(d.hostname);
    if (out.includes(host) || opts.reserved?.has(host) || nonPublicHostReason(host)) continue;
    if (d.dnsStatus === "ok" || (d.dnsStatus === "unchecked" && opts.routed?.has(host))) out.push(host);
  }
  return out;
}
