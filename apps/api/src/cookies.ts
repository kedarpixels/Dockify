import type { FastifyReply, FastifyRequest } from "fastify";

/** The browser-facing origin, derived once from DOCKIFY_PUBLIC_URL. */
export interface WebOrigin {
  origin: string;
  secure: boolean;
  /** `127.0.0.1:<DOCKIFY_PORT>`, the one address the web container publishes on the host. */
  loopback?: string;
}

/**
 * Set by the web only for a request whose Host is that loopback address (lib/forwarded.ts): the SSH
 * tunnel the installer and the docs give for when the dashboard's domain is broken.
 */
export const TUNNEL_HOST_HEADER = "x-dockify-loopback-host";

/**
 * The origin and cookies that request gets: its own, plain http, so `__Host-` cookies (which need
 * https) and the origin check both work through the tunnel. Everything else keeps the public origin.
 *
 * Why this cannot be used against a browser that is not on the tunnel:
 *   - A page cannot set this header on a cross-origin call without a CORS preflight, which the api
 *     never answers, and a plain form or link cannot set it at all.
 *   - The web sets it from the Host the browser sent, so it says what the address bar says. DNS
 *     rebinding gets the attacker's Host, and the public proxy routes only the dashboard's hostnames.
 *   - The csrf check still wants the browser's Origin to equal exactly this one, and Sec-Fetch-Site
 *     to be same-origin. A page on another local port has another Origin.
 *   - Cookies follow the same choice, and the bare name is read only here. A sibling subdomain that
 *     plants a bare cookie over https is still ignored, which is what the prefix is for.
 * A client that forges the header holds no ambient cookie, so it gains nothing a token would not give.
 */
export function webFor(req: Pick<FastifyRequest, "headers">, web: WebOrigin): WebOrigin {
  if (!web.loopback || req.headers[TUNNEL_HOST_HEADER] !== web.loopback) return web;
  return { origin: `http://${web.loopback}`, secure: false };
}

/**
 * `__Host-` forces Secure, forbids Domain and pins Path=/, so a sibling subdomain cannot plant one.
 * Browsers refuse the prefix over plain http, so a localhost dev origin uses the bare names.
 */
export const COOKIE = {
  session: "dockify_sid",
  pending: "dockify_pending",
  trusted: "dockify_trust",
} as const;
export type CookieKind = keyof typeof COOKIE;

export const cookieName = (web: WebOrigin, kind: CookieKind): string => (web.secure ? `__Host-${COOKIE[kind]}` : COOKIE[kind]);

export function readCookie(req: FastifyRequest, web: WebOrigin, kind: CookieKind): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  const name = cookieName(webFor(req, web), kind);
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      const value = decodeURIComponent(part.slice(eq + 1).trim());
      return value || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function serialize(web: WebOrigin, kind: CookieKind, value: string, maxAgeSeconds: number): string {
  const parts = [`${cookieName(web, kind)}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`];
  if (web.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Appends a Set-Cookie line; several cookies can be set on one reply. */
export function setCookie(reply: FastifyReply, web: WebOrigin, kind: CookieKind, value: string, maxAgeMs: number): void {
  appendSetCookie(reply, serialize(webFor(reply.request, web), kind, value, Math.floor(maxAgeMs / 1000)));
}

export function clearCookie(reply: FastifyReply, web: WebOrigin, kind: CookieKind): void {
  appendSetCookie(reply, serialize(webFor(reply.request, web), kind, "", 0));
}

function appendSetCookie(reply: FastifyReply, line: string): void {
  const prev = reply.getHeader("set-cookie");
  const list = prev === undefined ? [] : Array.isArray(prev) ? prev.map(String) : [String(prev)];
  reply.header("set-cookie", [...list, line]);
}
