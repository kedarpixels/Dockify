import { BlockList, isIP } from "node:net";
import type { IngressMode } from "./config.ts";

/**
 * Headers are believed only when the TCP peer is a trusted proxy; otherwise the peer is the client.
 * X-Forwarded-For is walked right to left, skipping trusted hops, so entries a client prepended never win.
 * CF-Connecting-IP is read only in tunnel mode, where Cloudflare overwrites it and the origin has no public port.
 */
export type ClientIpResolver = (peer: string | undefined, headers: Record<string, string | string[] | undefined>) => string;

const normalize = (ip: string): string => {
  const v = ip.trim().replace(/^\[|\]$/g, "");
  return v.toLowerCase().startsWith("::ffff:") && isIP(v.slice(7)) === 4 ? v.slice(7) : v;
};

export function buildTrustList(entries: string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [addr = "", bits] = entry.split("/");
    const ip = normalize(addr);
    const family = isIP(ip);
    if (!family) throw new Error(`DOCKIFY_TRUSTED_PROXIES has an invalid entry: ${entry}`);
    const type = family === 4 ? "ipv4" : "ipv6";
    if (bits === undefined) list.addAddress(ip, type);
    else {
      const prefix = Number(bits);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
        throw new Error(`DOCKIFY_TRUSTED_PROXIES has an invalid prefix: ${entry}`);
      }
      list.addSubnet(ip, prefix, type);
    }
  }
  return list;
}

/**
 * `known` is false when a trusted proxy reported no usable client address: `ip` is then the proxy's own,
 * shared by every caller behind it, so it must never key a rate limit.
 */
export interface ResolvedClient {
  ip: string;
  known: boolean;
}

export type ClientResolver = (peer: string | undefined, headers: Record<string, string | string[] | undefined>) => ResolvedClient;

export function createClientResolver(trustedProxies: string[], ingress: IngressMode): ClientResolver {
  const trusted = buildTrustList(trustedProxies);
  const isTrusted = (ip: string): boolean => {
    const family = isIP(ip);
    return family !== 0 && trusted.check(ip, family === 4 ? "ipv4" : "ipv6");
  };
  const single = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? undefined : v);

  return (rawPeer, headers) => {
    const peer = normalize(rawPeer ?? "");
    if (!peer || !isTrusted(peer)) return { ip: peer || "unknown", known: true };

    if (ingress === "cloudflare_tunnel") {
      const cf = single(headers["cf-connecting-ip"]);
      if (cf && !cf.includes(",") && isIP(normalize(cf))) return { ip: normalize(cf), known: true };
    }

    const xff = single(headers["x-forwarded-for"]);
    if (xff) {
      const hops = xff.split(",").map(normalize).filter(Boolean);
      for (let i = hops.length - 1; i >= 0; i--) {
        const hop = hops[i]!;
        if (!isIP(hop)) return { ip: peer, known: false };
        if (!isTrusted(hop)) return { ip: hop, known: true };
      }
      // Every hop is trusted (a browser on the proxy's own host, in development): the first hop is the client.
      if (hops[0]) return { ip: hops[0], known: true };
    }
    return { ip: peer, known: false };
  };
}

export function createClientIp(trustedProxies: string[], ingress: IngressMode): ClientIpResolver {
  const resolve = createClientResolver(trustedProxies, ingress);
  return (peer, headers) => resolve(peer, headers).ip;
}
