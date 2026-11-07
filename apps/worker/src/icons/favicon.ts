/**
 * Finds a frontend's favicon on its own domains: the page's <link rel=icon> candidates first, then
 * /favicon.ico. Every request goes through the net-guard client (https, public addresses only, no
 * redirect followed by the client), and every URL, the page, each redirect and each icon, must sit
 * on one of the app's attached hostnames. Bytes are accepted only when the magic number says png,
 * ico, webp or jpg; SVG is never taken.
 */
import { checkFavicon, FAVICON_MAX_BYTES, type SniffedImage } from "@dockify/contracts";
import { getFollowing, OutboundError, type HttpClient, type HttpResponse } from "@dockify/net-guard";

const PAGE_MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
const MAX_CANDIDATES = 4;
/** A page needs only a handful of icon links; cap the scan so a crafted page cannot force heavy work. */
const MAX_LINK_TAGS = 64;
/** Only the head's worth of a page holds icon links; scanning past this cannot help and only costs. */
const SCAN_MAX = 64 * 1024;
/** A real <link> tag is short; one longer than this is hostile padding, so it is skipped. */
const MAX_TAG_BYTES = 4096;

export type FaviconResult =
  | { ok: true; url: string; bytes: Buffer; image: SniffedImage }
  | { ok: false; reason: string };

export interface IconLink {
  href: string;
  rel: string;
  sizes: number;
  type: string | null;
}

const ATTR = /([a-zA-Z:-]{1,64})\s*=\s*(?:"([^"]{0,2048})"|'([^']{0,2048})'|([^\s"'>]{1,2048}))/g;
const decode = (s: string) => s.replace(/&amp;/gi, "&").replace(/&#x2f;/gi, "/").replace(/&quot;/gi, '"').trim();

/** The icon links of an HTML page, in document order. */
export function parseIconLinks(html: string): IconLink[] {
  const out: IconLink[] = [];
  // Only scan the head's worth, and bound each tag: a 512 KiB page or one giant <link> tag must
  // not turn the whole-page match or the per-tag attribute scan into quadratic work on this lane.
  const scan = html.length > SCAN_MAX ? html.slice(0, SCAN_MAX) : html;
  for (const tag of (scan.match(new RegExp(`<link\\b[^>]{0,${MAX_TAG_BYTES}}>`, "gi")) ?? []).slice(0, MAX_LINK_TAGS)) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(ATTR)) attrs[m[1]!.toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    if (!attrs.href || !(rel.includes("icon") || rel.includes("apple-touch-icon"))) continue;
    const sizes = Math.max(0, ...(attrs.sizes ?? "").split(/\s+/).map((s) => Number(/^(\d+)x\d+$/i.exec(s)?.[1] ?? 0)));
    out.push({ href: attrs.href, rel: rel.includes("apple-touch-icon") ? "apple-touch-icon" : "icon", sizes, type: attrs.type?.toLowerCase() ?? null });
  }
  return out;
}

const isSvg = (l: IconLink) => l.type === "image/svg+xml" || /\.svgz?(?:[?#]|$)/i.test(l.href);

/**
 * Raster candidates, best first: the smallest declared size of 64px or more (crisp at 40px on a
 * 2x screen), then larger ones, then smaller or unsized ones. SVG links are dropped.
 */
export function rankIconLinks(links: IconLink[]): IconLink[] {
  const size = (l: IconLink) => l.sizes || (l.rel === "apple-touch-icon" ? 180 : 32);
  const score = (l: IconLink) => (size(l) >= 64 ? size(l) : 10_000 - size(l));
  return links.filter((l) => !isSvg(l) && !l.href.startsWith("data:")).sort((a, b) => score(a) - score(b));
}

/** True for an https URL on one of the allowed hosts, on the default port. */
const onHosts = (u: URL, hosts: ReadonlySet<string>): boolean =>
  u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") && hosts.has(u.hostname.toLowerCase());

/** The URL if it is https on one of the allowed hosts, else null. */
function allowed(raw: string, base: string, hosts: ReadonlySet<string>): string | null {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  return onHosts(u, hosts) ? u.toString() : null;
}

/** GETs a URL, following at most three redirects that stay on the allowed hosts (net-guard's getFollowing). */
function get(http: HttpClient, url: string, hosts: ReadonlySet<string>, maxBytes: number, accept: string): Promise<{ url: string; res: HttpResponse }> {
  return getFollowing(http, url, {
    headers: { accept }, timeoutMs: TIMEOUT_MS, maxBytes, maxRedirects: MAX_REDIRECTS,
    allow: (u) => onHosts(u, hosts), refused: "A redirect left the app's domains",
  });
}

const why = (e: unknown) =>
  e instanceof OutboundError ? (e.code === "TOO_LARGE" ? "The favicon is larger than 64 KB" : e.message) : e instanceof Error ? e.message : String(e);

async function tryIcon(http: HttpClient, url: string, hosts: ReadonlySet<string>): Promise<FaviconResult> {
  try {
    const got = await get(http, url, hosts, FAVICON_MAX_BYTES, "image/png,image/x-icon,image/webp,image/jpeg;q=0.9,*/*;q=0.1");
    if (got.res.status !== 200) return { ok: false, reason: `${new URL(got.url).pathname} answered ${got.res.status}` };
    const check = checkFavicon(got.res.body);
    return check.ok ? { ok: true, url: got.url, bytes: got.res.body, image: check.image } : { ok: false, reason: check.reason };
  } catch (e) {
    return { ok: false, reason: why(e) };
  }
}

/**
 * Where a generic webhook's favicon may come from: its own host, then the site above it
 * (hooks.example.com, then example.com and www.example.com). A parent that is only a public
 * suffix such as co.uk is never tried.
 */
export function webhookSiteHosts(host: string): string[][] {
  const h = host.toLowerCase();
  const labels = h.split(".");
  const out = [[h]];
  if (labels.length >= 3) {
    const parent = labels.slice(1).join(".");
    const suffixOnly = labels.length === 3 && labels[1]!.length <= 3 && labels[2]!.length === 2;
    if (!suffixOnly) out.push([parent, `www.${parent}`]);
  }
  return out;
}

/** A generic webhook's favicon, from its own host first; nothing outside webhookSiteHosts is requested. */
export async function findWebhookFavicon(http: HttpClient, host: string): Promise<FaviconResult> {
  let last: FaviconResult = { ok: false, reason: "No favicon found" };
  for (const hosts of webhookSiteHosts(host)) {
    last = await findFavicon(http, hosts);
    if (last.ok) return last;
  }
  return last;
}

/**
 * The favicon of the first host (the primary domain), or the reason there is none. `hosts` are the
 * app's attached hostnames; nothing outside them is ever requested.
 */
export async function findFavicon(http: HttpClient, hosts: string[]): Promise<FaviconResult> {
  const primary = hosts[0]?.toLowerCase();
  if (!primary) return { ok: false, reason: "No domain is attached" };
  const allow = new Set(hosts.map((h) => h.toLowerCase()));
  const home = `https://${primary}/`;

  let candidates: string[] = [];
  let first: string | null = null;
  try {
    const page = await get(http, home, allow, PAGE_MAX_BYTES, "text/html");
    if (page.res.status === 200) {
      const html = page.res.body.toString("utf8");
      candidates = rankIconLinks(parseIconLinks(html))
        .map((l) => allowed(l.href, page.url, allow))
        .filter((u): u is string => u !== null)
        .slice(0, MAX_CANDIDATES);
    } else {
      first = `The home page answered ${page.res.status}`;
    }
  } catch (e) {
    first = why(e);
  }

  const fallback = `https://${primary}/favicon.ico`;
  let last: string | null = null;
  for (const url of [...new Set([...candidates, fallback])]) {
    const r = await tryIcon(http, url, allow);
    if (r.ok) return r;
    last = r.reason;
  }
  return { ok: false, reason: last ?? first ?? "No favicon found" };
}
