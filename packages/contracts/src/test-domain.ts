/**
 * Free test domains: <app>-<short id>.<ip-with-dashes>.sslip.io, which resolves to the address it spells.
 * Only Dockify generates them, and only for this server's own address: on sslip.io anyone can spell any
 * address, so a typed name that spells another one is refused.
 */

/** Hosts that answer with the address they spell. */
const IP_HOST_SUFFIX = /\.(?:sslip|nip|xip)\.io$/;
/**
 * All dashes or all dots, between label or dash boundaries, the way these services read it: so
 * a1b2c3.203-0-113-10 spells only 203.0.113.10, and never 3.203.0.113.
 */
const SPELLED_ADDRESS = /(?<![\da-z])(\d{1,3})([.-])(\d{1,3})\2(\d{1,3})\2(\d{1,3})(?![\da-z])/g;

/** Every IPv4 address a name on one of those services spells; empty for any other name. */
export function spelledAddresses(host: string): string[] {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!IP_HOST_SUFFIX.test(h)) return [];
  const prefix = h.replace(IP_HOST_SUFFIX, "");
  return [...prefix.matchAll(SPELLED_ADDRESS)].map((m) => `${m[1]}.${m[3]}.${m[4]}.${m[5]}`);
}

/** The first address a name spells that is not this server's, or null. */
export function foreignSpelledAddress(host: string, serverIpv4: string | null): string | null {
  return spelledAddresses(host).find((a) => a !== serverIpv4) ?? null;
}

/** True for a public IPv4 address in dotted form: what sslip.io must spell for the world to reach it. */
export function isPublicIpv4(ip: string | null | undefined): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip ?? "");
  if (!m) return false;
  const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

export const testDomainSuffix = (serverIpv4: string): string => `${serverIpv4.replace(/\./g, "-")}.sslip.io`;

/**
 * The label from an app's name: letters, digits and dashes, short enough to leave room for the id, and
 * never something that spells an address of its own, which sslip.io would answer with instead.
 */
export function testDomainLabel(appName: string, shortId: string): string {
  const safe = appName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/\d{1,3}(?:-\d{1,3}){3}/g, "app")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${safe || "app"}-${shortId}`;
}

export const testDomainName = (appName: string, shortId: string, serverIpv4: string): string => `${testDomainLabel(appName, shortId)}.${testDomainSuffix(serverIpv4)}`;

/** Tunnel mode has no public port for the name to reach. */
export function testDomainOffer(o: { ingress: "cloudflare_tunnel" | "direct_tls"; serverIpv4: string | null }): { available: boolean; reason: string | null; suffix: string | null } {
  if (o.ingress !== "direct_tls") return { available: false, reason: "A server behind a Cloudflare tunnel has no public port for a test domain to reach.", suffix: null };
  if (!isPublicIpv4(o.serverIpv4)) return { available: false, reason: "This server's public IPv4 address is not known, so it has no test domain to offer.", suffix: null };
  return { available: true, reason: null, suffix: testDomainSuffix(o.serverIpv4!) };
}

export const SSLIP_DOWN_MESSAGE = "sslip.io did not answer for this test domain. It is a free third-party service, so it may be down: the domain cannot be reached or get a certificate until it is back. Dockify checks again on its own.";
