/*
 * The request headers every call from this server to the Dockify API carries on the visitor's
 * behalf. Pure, so it tests without Next.
 *
 * The API rate limits, audits and labels sessions by the client address. It trusts the web
 * container to report that address, and refuses a signed-in call that arrives without one, since
 * every visitor would otherwise share this container's address and one bucket. Next always sets
 * x-forwarded-for on the incoming request (from the socket when no proxy did), so it is always
 * there to pass on; cf-connecting-ip is what the API prefers in Cloudflare Tunnel mode.
 */

// origin and sec-fetch-site carry the visitor's real browser context so the API's checkCsrf can
// fire; without them it is blind and CSRF rests on the web's per-handler guards alone.
const PASS = ["x-forwarded-for", "cf-connecting-ip", "user-agent", "origin", "sec-fetch-site"] as const;

const TUNNEL_HOST_HEADER = "x-dockify-loopback-host";
const LOOPBACK_HOST = /^127\.0\.0\.1:\d+$/;

export interface ForwardOptions {
  /** Pass the visitor's cookies (the session). Off for anonymous, cached reads. */
  cookie?: boolean;
}

export function forwardedHeaders(incoming: Pick<Headers, "get">, opts: ForwardOptions = {}): Record<string, string> {
  const out: Record<string, string> = {};
  if (opts.cookie !== false) {
    const cookie = incoming.get("cookie");
    if (cookie) out.cookie = cookie;
  }
  for (const name of PASS) {
    const v = incoming.get(name);
    if (v) out[name] = v;
  }
  // The browser is on the SSH tunnel: the API gives it this origin and bare cookies (apps/api/src/cookies.ts).
  const host = incoming.get("host");
  if (host && LOOPBACK_HOST.test(host)) out[TUNNEL_HOST_HEADER] = host;
  return out;
}

/** One Set-Cookie line from the API, as the pieces cookies().set() takes. */
export interface ParsedCookie {
  name: string;
  value: string;
  opts: {
    httpOnly?: boolean;
    secure?: boolean;
    path?: string;
    domain?: string;
    maxAge?: number;
    expires?: Date;
    sameSite?: "lax" | "strict" | "none";
  };
}

/** Parses a Set-Cookie line, or null when it has no name. A cleared cookie comes back as Max-Age 0. */
export function parseSetCookie(line: string): ParsedCookie | null {
  const [pair = "", ...attrs] = line.split(";");
  const eq = pair.indexOf("=");
  if (eq < 1) return null;
  const name = pair.slice(0, eq).trim();
  let value = pair.slice(eq + 1).trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep the raw value */
  }
  const opts: ParsedCookie["opts"] = {};
  for (const attr of attrs) {
    const [k = "", v = ""] = attr.split("=").map((s) => s.trim());
    const key = k.toLowerCase();
    if (key === "httponly") opts.httpOnly = true;
    else if (key === "secure") opts.secure = true;
    else if (key === "path") opts.path = v;
    else if (key === "domain") opts.domain = v;
    else if (key === "max-age" && Number.isFinite(Number(v))) opts.maxAge = Number(v);
    else if (key === "expires" && !Number.isNaN(Date.parse(v))) opts.expires = new Date(v);
    else if (key === "samesite") {
      const same = v.toLowerCase();
      if (same === "lax" || same === "strict" || same === "none") opts.sameSite = same;
    }
  }
  return { name, value, opts };
}

/** The session cookie names the API issues: `__Host-` on https, the bare name on plain http. */
export const SESSION_COOKIES = ["__Host-dockify_sid", "dockify_sid"] as const;

/** The request header proxy.ts sets to the page path, so a loader knows where to come back to (lib/data.ts). */
export const PATH_HEADER = "x-dockify-path";
