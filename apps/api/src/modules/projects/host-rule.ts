/**
 * The registry and repository host checks at rest. A repository host follows the address rule in
 * @dockify/net-guard, the one copy the api and the worker share; the worker runs the same rule again
 * against the resolved address at connect time. A registry follows the agent gate's rule
 * (@dockify/contracts, registry-host.ts), so the dashboard takes what a pull takes, a LAN registry
 * included. On top of it this file reads a name's DNS answer, which the gate cannot, and holds that
 * answer to the same rule. dockerd looks the name up again at the pull, from the host's network, so
 * this catches a mistake and nothing cleverer.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { nonPublicHostReason, refusedHost, refusedPull, registryHost } from "@dockify/contracts";
import { isPublicAddress, isPublicHostname, mappedV4 } from "@dockify/net-guard";

/** True when a host must never be contacted: non-global addresses and single-label or internal names. */
export const isBlockedHost = (host: string): boolean => !isPublicHostname(host);

export interface ResolvedAddress {
  address: string;
}
export type RegistryResolver = (host: string) => Promise<ResolvedAddress[]>;

const systemRegistryResolver: RegistryResolver = (host) => dnsLookup(host, { all: true, verbatim: true });

/** IPv6's LAN range, where a registry may answer as one in RFC 1918 may, and the metadata address inside it. */
const V6_LAN = new BlockList();
V6_LAN.addSubnet("fc00::", 7, "ipv6");
const V6_METADATA = new BlockList();
V6_METADATA.addAddress("fd00:ec2::254", "ipv6");

/** Why a registry name may not answer with this address, or null. The gate's rule, with IPv6 added: its form has none. */
function refusedAnswer(address: string): string | null {
  const v4 = isIP(address) === 4 ? address : mappedV4(address);
  if (v4) return refusedHost(v4);
  if (isIP(address) !== 6) return "not an address";
  if (V6_METADATA.check(address, "ipv6")) return "cloud metadata";
  return isPublicAddress(address) || V6_LAN.check(address, "ipv6") ? null : "loopback or link-local";
}

/**
 * The registry rule with DNS. Null means the image may be stored. Docker Hub (no registry host) needs no
 * check. A name is refused when any answer is one the gate would refuse written out, and when it does not
 * resolve at all, but for a LAN name: that may resolve only from the host, through its own /etc/hosts or
 * resolver, and this runs in a container.
 */
export async function registryHostProblem(image: string, resolve: RegistryResolver = systemRegistryResolver): Promise<string | null> {
  const host = registryHost(image);
  if (host === null) return null;
  const spelled = refusedPull(image);
  if (spelled) return spelled;
  if (isIP(host)) return null;
  const unresolved = nonPublicHostReason(host) ? null : `${host} did not resolve`;
  let addrs: ResolvedAddress[];
  try {
    addrs = await resolve(host);
  } catch {
    return unresolved;
  }
  if (addrs.length === 0) return unresolved;
  for (const { address } of addrs) {
    const why = refusedAnswer(address);
    if (why) return `Dockify does not pull from ${host}: it resolves to ${address}, ${why}`;
  }
  return null;
}

/** The host of an https repository URL (already shape-checked by the contract). */
export function repoHostOf(repoUrl: string): string {
  return new URL(repoUrl).hostname;
}
