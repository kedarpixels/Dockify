import type { IngressMode } from "@/lib/pages/resources-domains";

/** Where a domain's record points: the server's addresses in direct mode, the tunnel in tunnel mode. "" when unknown. */
export interface DomainTargets {
  ingress: IngressMode;
  ipv4: string;
  ipv6: string;
  tunnelTarget: string;
}

/** An API older than these fields sends no mode, which then reads as direct, and no IPv6 address. */
export function domainTargets(p: { ingress?: unknown; server?: { ipv4?: unknown; ipv6?: unknown; tunnelTarget?: unknown } | null } | null | undefined): DomainTargets {
  const s = p?.server ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return { ingress: p?.ingress === "cloudflare_tunnel" ? "cloudflare_tunnel" : "direct_tls", ipv4: str(s.ipv4), ipv6: str(s.ipv6), tunnelTarget: str(s.tunnelTarget) };
}
