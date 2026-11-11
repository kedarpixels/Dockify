import { nonPublicHostReason } from "@dockify/contracts";
import { normalizeHost } from "./hostnames.ts";

export interface DomainDns {
  hostname: string;
  dnsStatus: string;
}

/**
 * A domain is routed only once its DNS points here, so Traefik never spends Let's Encrypt's failure
 * budget on it. An unchecked domain keeps a router it already has (a lookup failure never takes a live
 * site down) but gets no first one. Reserved and non-public names are never routed. Order is kept.
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
