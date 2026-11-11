/**
 * Cross-site check for state-changing requests, applied before auth. A forged browser request always carries
 * a foreign Sec-Fetch-Site or Origin. `same-site` is refused too: a tenant app on a sibling subdomain must never
 * drive the console. Both headers absent means a non-browser caller, which holds no ambient credential.
 */
export type CsrfVerdict = { ok: true } | { ok: false; reason: string };

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function checkCsrf(method: string, headers: Record<string, string | string[] | undefined>, origin: string): CsrfVerdict {
  if (SAFE_METHODS.has(method.toUpperCase())) return { ok: true };

  const site = headers["sec-fetch-site"];
  if (site !== undefined) {
    if (Array.isArray(site) || (site !== "same-origin" && site !== "none")) return { ok: false, reason: "cross-site request" };
  }
  const got = headers.origin;
  if (got !== undefined) {
    if (Array.isArray(got) || got !== origin) return { ok: false, reason: "foreign origin" };
  }
  return { ok: true };
}
