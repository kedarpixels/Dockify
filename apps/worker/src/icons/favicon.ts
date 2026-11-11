/**
 * Finds a frontend's favicon on its own domains. Every request goes through the net-guard client and
 * every URL (page, redirect, icon) must sit on one of the app's attached hostnames. Bytes are accepted
 * only by magic number (png, ico, webp, jpg) or as the SVG document sanitizeSvg rebuilds.
 */
import { checkFavicon, sniffImage, type SniffedLogo } from "@dockify/contracts";
import { getFollowing, OutboundError, type HttpClient, type HttpResponse } from "@dockify/net-guard";

const PAGE_MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
const MAX_CANDIDATES = 4;
/** A page needs only a handful of icon links; cap the scan so a crafted page cannot force heavy work. */
const MAX_LINK_TAGS = 64;
const SCAN_MAX = 64 * 1024;
const MAX_TAG_BYTES = 4096;

export type FaviconResult =
  /** `bytes` are the ones to store: the image as it arrived, or for an SVG the rebuilt document. */
  | { ok: true; url: string; bytes: Buffer; image: SniffedLogo }
  | { ok: false; reason: string };

export interface IconLink {
  href: string;
  rel: string;
  sizes: number;
  type: string | null;
}

const ATTR = /([a-zA-Z:-]{1,64})\s*=\s*(?:"([^"]{0,2048})"|'([^']{0,2048})'|([^\s"'>]{1,2048}))/g;
const decode = (s: string) => s.replace(/&amp;/gi, "&").replace(/&#x2f;/gi, "/").replace(/&quot;/gi, '"').trim();

export function parseIconLinks(html: string): IconLink[] {
  const out: IconLink[] = [];
  // Bounded scan and tag length: a huge page or one giant <link> must not make matching quadratic.
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

/** Rasters of 64px or more first, smallest ahead, then SVG: an email or PR comment can only show a raster. */
export function rankIconLinks(links: IconLink[]): IconLink[] {
  const size = (l: IconLink) => l.sizes || (l.rel === "apple-touch-icon" ? 180 : 32);
  const score = (l: IconLink) => (isSvg(l) ? 20_000 : size(l) >= 64 ? size(l) : 10_000 - size(l));
  return links.filter((l) => !l.href.startsWith("data:")).sort((a, b) => score(a) - score(b));
}

const onHosts = (u: URL, hosts: ReadonlySet<string>): boolean =>
  u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") && hosts.has(u.hostname.toLowerCase());

function allowed(raw: string, base: string, hosts: ReadonlySet<string>): string | null {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  return onHosts(u, hosts) ? u.toString() : null;
}

function get(http: HttpClient, url: string, hosts: ReadonlySet<string>, maxBytes: number, accept: string): Promise<{ url: string; res: HttpResponse }> {
  return getFollowing(http, url, {
    headers: { accept }, timeoutMs: TIMEOUT_MS, maxBytes, maxRedirects: MAX_REDIRECTS,
    allow: (u) => onHosts(u, hosts), refused: "A redirect left the app's domains",
  });
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Only a size or redirect refusal names its URL; the rest is about the host, the same for every URL. */
function thrown(what: string, e: unknown): string {
  if (e instanceof OutboundError && e.code === "TOO_LARGE") return `${what} is too large to read`;
  if (e instanceof OutboundError && e.code === "REDIRECT_REFUSED") return `${what}: ${e.message}`;
  return message(e);
}

/** A missing favicon is often a 200 page. The body decides first, so an icon behind a wrong header is taken. */
function isPage(res: HttpResponse): boolean {
  const head = res.body.subarray(0, 512).toString("utf8").replace(/^\uFEFF/, "");
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(head)) return true;
  const type = String(res.headers["content-type"] ?? "");
  return /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(type) && !sniffImage(res.body);
}

async function tryIcon(http: HttpClient, url: string, hosts: ReadonlySet<string>): Promise<FaviconResult> {
  const path = new URL(url).pathname;
  try {
    // Read up to a page's worth, not a favicon's: a missing icon is often answered with a whole
    // page, and its status and body must be seen to say so. checkFavicon holds the 64 KB limit.
    const got = await get(http, url, hosts, PAGE_MAX_BYTES, "image/png,image/x-icon,image/webp,image/svg+xml,image/jpeg;q=0.9,*/*;q=0.1");
    const what = got.url === url ? path : `${path} (redirected to ${new URL(got.url).pathname})`;
    if (got.res.status !== 200) return { ok: false, reason: `${what} answered ${got.res.status}` };
    if (isPage(got.res)) return { ok: false, reason: `${what} is a web page, not an image` };
    const check = checkFavicon(got.res.body);
    return check.ok ? { ok: true, url: got.url, bytes: Buffer.from(check.bytes), image: check.image } : { ok: false, reason: `${what}: ${check.reason}` };
  } catch (e) {
    return { ok: false, reason: thrown(path, e) };
  }
}

/** Own host, then the site above it; a parent that is only a public suffix such as co.uk is never tried. */
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

export async function findWebhookFavicon(http: HttpClient, host: string): Promise<FaviconResult> {
  let last: FaviconResult = { ok: false, reason: "No favicon found" };
  for (const hosts of webhookSiteHosts(host)) {
    last = await findFavicon(http, hosts);
    if (last.ok) return last;
  }
  return last;
}

/** `hosts` are the app's attached hostnames, primary first; nothing outside them is ever requested. */
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
    first = thrown("The home page", e);
  }

  const fallback = `https://${primary}/favicon.ico`;
  // Every candidate's reason, in the order tried: the last alone (always /favicon.ico) hides the rest.
  const reasons = first ? [first] : [];
  for (const url of [...new Set([...candidates, fallback])]) {
    const r = await tryIcon(http, url, allow);
    if (r.ok) return r;
    reasons.push(r.reason);
  }
  return { ok: false, reason: [...new Set(reasons)].join(". ") };
}
