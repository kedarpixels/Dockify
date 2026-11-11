// Sec-Fetch-Site decides when present: only "same-origin" passes, since "same-site" is a sibling
// subdomain such as a hosted app. Otherwise Origin must match the host. Neither header: refused.

const CROSS_SITE = "Cross-site request refused";

/** Null when the request comes from this origin, else the reason it is refused. */
export function crossSiteRefusal(headers: Pick<Headers, "get">): string | null {
  const site = headers.get("sec-fetch-site");
  if (site) return site === "same-origin" ? null : CROSS_SITE;
  const origin = headers.get("origin");
  if (!origin) return CROSS_SITE;
  let from: string;
  try {
    from = new URL(origin).host;
  } catch {
    return CROSS_SITE;
  }
  const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim() || headers.get("host");
  return host && from === host ? null : CROSS_SITE;
}
