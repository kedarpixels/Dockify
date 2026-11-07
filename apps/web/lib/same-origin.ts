/*
 * The same-origin rule every write route applies before it forwards anything to the API, so another
 * site cannot ride the session cookie through this dashboard (CSRF). Pure, so it tests without Next;
 * lib/http.ts turns it into the route guard.
 *
 * Sec-Fetch-Site is set by the browser itself and survives proxies that rewrite Host, so when it is
 * there it decides: only "same-origin" passes ("same-site" is a sibling subdomain, such as an app
 * this server hosts, and is refused). A browser that sends no Sec-Fetch-Site is checked by Origin
 * against the forwarded host, then Host. A write with neither header is not a browser request from
 * this dashboard, so it is refused too.
 */

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
