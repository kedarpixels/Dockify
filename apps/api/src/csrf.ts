/**
 * Cross-site request check for every state-changing request, applied before auth.
 *
 * Browsers attach Sec-Fetch-Site to every request and Origin to every cross-origin POST, so a forged
 * request always carries one of them with a foreign value. `same-site` is refused too: a tenant app
 * on a sibling subdomain is same-site but must never drive the console. When both headers are absent
 * the caller is not a browser (the web server's own fetch, curl), and there is no ambient credential
 * to abuse; SameSite=Strict on the cookie backs this up. Origins compare by exact equality only.
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
