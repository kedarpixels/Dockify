/**
 * Ownership probe for proxied domains: the worker GETs http://<host>/.well-known/dockify-check/<token>
 * and expects this server's answer. Token and answer are HMACs derived from the internal channel secret,
 * so nothing is stored, and only a server that forwards the request here can answer.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Where the probe lives on every host; Traefik sends exactly this prefix to the api. */
export const DOMAIN_CHECK_PREFIX = "/.well-known/dockify-check/";

const subkey = (secret: string) => createHmac("sha256", secret).update("dockify-domain-check-v1").digest();
const norm = (host: string) => host.trim().toLowerCase().replace(/\.$/, "");

export function domainCheckToken(secret: string, domainId: string, hostname: string): string {
  return createHmac("sha256", subkey(secret)).update(`token\0${domainId}\0${norm(hostname)}`).digest("hex");
}

export function domainCheckAnswer(secret: string, hostname: string, token: string): string {
  return createHmac("sha256", subkey(secret)).update(`answer\0${norm(hostname)}\0${token}`).digest("hex");
}

/** Constant-time comparison of two hex values of the expected length. */
export function sameCheckValue(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
