/**
 * The domain ownership probe (for domains behind a proxy such as Cloudflare's, whose DNS
 * names the proxy and not this server). The worker asks
 * http://<host>/.well-known/dockify-check/<token> and expects this server's answer for that host
 * and token. Both sides derive the values from the internal channel secret the api and the worker
 * already share, so nothing is stored:
 *
 *   token   per domain, from its id and hostname. Unguessable without the secret, so nobody can
 *           ask this server for an answer about a domain they do not already know the token of.
 *   answer  per host and token. A server the name actually points at can only give it by passing
 *           the request on to this one; echoing the path back is not enough.
 *
 * The secret itself never leaves either process: every value is an HMAC under a key derived from
 * it with its own label.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Where the probe lives on every host; Traefik sends exactly this prefix to the api. */
export const DOMAIN_CHECK_PREFIX = "/.well-known/dockify-check/";

const subkey = (secret: string) => createHmac("sha256", secret).update("dockify-domain-check-v1").digest();
const norm = (host: string) => host.trim().toLowerCase().replace(/\.$/, "");

/** The path token for one domain row. */
export function domainCheckToken(secret: string, domainId: string, hostname: string): string {
  return createHmac("sha256", subkey(secret)).update(`token\0${domainId}\0${norm(hostname)}`).digest("hex");
}

/** What this server answers for a host and a token. */
export function domainCheckAnswer(secret: string, hostname: string, token: string): string {
  return createHmac("sha256", subkey(secret)).update(`answer\0${norm(hostname)}\0${token}`).digest("hex");
}

/** Constant-time comparison of two hex values of the expected length. */
export function sameCheckValue(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
