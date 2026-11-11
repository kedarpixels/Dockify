// Host checks at rest, when a repository or image is stored. Not a security boundary: the worker
// re-checks a repository's resolved address at connect time, and dockerd resolves a registry name
// again at the pull, so the DNS check here catches a mistake and nothing cleverer.
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { nonPublicHostReason, refusedHost, refusedPull, registryHost } from "@dockify/contracts";
import { isPublicAddress, isPublicHostname, mappedV4 } from "@dockify/net-guard";

export const isBlockedHost = (host: string): boolean => !isPublicHostname(host);

export interface ResolvedAddress {
  address: string;
}
export type RegistryResolver = (host: string) => Promise<ResolvedAddress[]>;

const systemRegistryResolver: RegistryResolver = (host) => dnsLookup(host, { all: true, verbatim: true });

/** A LAN registry is allowed (as RFC 1918 is for IPv4), but not the cloud metadata address inside that range. */
const V6_LAN = new BlockList();
V6_LAN.addSubnet("fc00::", 7, "ipv6");
const V6_METADATA = new BlockList();
V6_METADATA.addAddress("fd00:ec2::254", "ipv6");

function refusedAnswer(address: string): string | null {
  const v4 = isIP(address) === 4 ? address : mappedV4(address);
  if (v4) return refusedHost(v4);
  if (isIP(address) !== 6) return "not an address";
  if (V6_METADATA.check(address, "ipv6")) return "cloud metadata";
  return isPublicAddress(address) || V6_LAN.check(address, "ipv6") ? null : "loopback or link-local";
}

/**
 * Null means the image may be stored. A name is refused when any DNS answer is a refused address, or
 * when it does not resolve. A LAN name may fail to resolve: only the host's resolver may know it, and this runs in a container.
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

export function repoHostOf(repoUrl: string): string {
  return new URL(repoUrl).hostname;
}
