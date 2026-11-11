/**
 * The api validates hostnames first; these checks run again so a bad row or a hand-built job payload
 * can never reach Traefik or Cloudflare.
 */
import { nonPublicHostReason } from "@dockify/contracts";

/** Same grammar as the contracts Hostname schema: lowercase labels, an alphabetic TLD. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export class EdgeHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeHostError";
  }
}

export function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, "");
}

export function isValidHost(host: string): boolean {
  return HOSTNAME.test(host);
}

/**
 * The hosts no tenant may claim: the dashboard's own hostname, plus any extra system host. A
 * tenant route, tunnel rule or DNS record naming one would let a tenant app receive the owner's
 * session cookie and step-up password.
 */
export function reservedHosts(dashboardHost: string | null | undefined, extra: string[] = []): Set<string> {
  const out = new Set<string>();
  for (const h of [dashboardHost ?? "", ...extra]) {
    const n = normalizeHost(h);
    if (n) out.add(n);
  }
  return out;
}

export function assertTenantHost(raw: string, reserved: Set<string>): string {
  const host = normalizeHost(raw);
  if (!isValidHost(host)) throw new EdgeHostError(`Not a valid hostname: ${JSON.stringify(raw).slice(0, 80)}`);
  if (reserved.has(host)) throw new EdgeHostError(`${host} is the dashboard hostname and cannot be routed to an app`);
  // A name that can never be public would only make Traefik spend Let's Encrypt's budget.
  const notPublic = nonPublicHostReason(host);
  if (notPublic) throw new EdgeHostError(`${host} cannot be routed: ${notPublic}`);
  return host;
}

/** The literal Traefik rule for one host. Safe because assertTenantHost refused anything but [a-z0-9.-]. */
export const hostRule = (host: string): string => `Host(\`${host}\`)`;
