import "server-only";
import { cache } from "react";
import { apiRequest, apiStream } from "@/lib/api";
import { NO_STORE } from "@/lib/http";
import { EMPTY_ICONS, type IconBody, type IconMap, type IconResult, type IconState, type IconTarget } from "@/lib/icons";
import { isPreviewMode } from "@/lib/preview-mode";

/* Server side of app and project icons: the map the console layout reads once, the one write the
   Icon control sends (app/api/icons), and the image proxy (app/api/icons/apps|projects). */

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const SLUG = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const VERSION = /^[a-f0-9]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const pathOf = (t: IconTarget) => (t.target === "app" ? `/api/v1/apps/${t.id}/icon` : `/api/v1/projects/${t.slug}/icon`);

export const getIcons = cache(async (): Promise<IconMap> => {
  if (process.env.DOCKIFY_API_URL) {
    // Icons are cosmetic: a slow or failed read gives every icon its default, never a broken layout.
    const r = await apiRequest<Partial<IconMap>>("/api/v1/icons", { timeoutMs: 5_000 });
    return r.ok && r.data ? { apps: r.data.apps ?? {}, projects: r.data.projects ?? {} } : EMPTY_ICONS;
  }
  // The design preview has no fetched favicons and no uploads, so every icon is its default.
  return EMPTY_ICONS;
});

/** The target and body of a request, or null when any part could steer the path or is malformed. */
function parseIconRequest(raw: unknown): { target: IconTarget; body: IconBody } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const target: IconTarget | null =
    r.target === "app" && typeof r.id === "string" && ID.test(r.id) ? { target: "app", id: r.id }
      : r.target === "project" && typeof r.slug === "string" && SLUG.test(r.slug) ? { target: "project", slug: r.slug }
        : null;
  const b = r.body as Record<string, unknown> | undefined;
  if (!target || !b || typeof b !== "object") return null;
  if (b.choice === "auto") {
    // Only a project borrows a favicon from one of its apps; an app's automatic is its own.
    if (b.appId === undefined || b.appId === null) return { target, body: target.target === "project" && b.appId === null ? { choice: "auto", appId: null } : { choice: "auto" } };
    return target.target === "project" && typeof b.appId === "string" && UUID.test(b.appId) ? { target, body: { choice: "auto", appId: b.appId } } : null;
  }
  if (b.choice === "upload" && typeof b.image === "string" && b.image.length <= 174_764 && BASE64.test(b.image)) {
    return { target, body: { choice: "upload", image: b.image } };
  }
  return null;
}

/** Sends one icon write; the design preview accepts it and changes nothing. */
export async function runIconMutation(raw: unknown): Promise<IconResult> {
  const base = process.env.DOCKIFY_API_URL;
  const req = parseIconRequest(raw);
  if (!req) return { ok: false, source: base ? "api" : "none", error: "That request is not valid" };
  if (base) {
    const r = await apiRequest<IconState>(pathOf(req.target), { method: "PUT", body: req.body });
    return r.ok ? { ok: true, source: "api", data: r.data } : { ok: false, source: "api", error: r.error, status: r.status };
  }
  if (isPreviewMode()) {
    const data: IconState = { choice: req.body.choice, image: null, favicon: null };
    return { ok: true, source: "preview", data };
  }
  return { ok: false, source: "none", error: "No data source, set DOCKIFY_API_URL for this dashboard" };
}

const IMAGE_HEADERS = ["content-type", "cache-control", "etag", "content-length"];
const notFound = () => new Response(null, { status: 404, headers: NO_STORE });

/** Streams one image from the API with the headers that matter, or 404 for anything that is not a 200 or 304. */
async function relayImage(path: string, ifNoneMatch: string | null, opts: { cookie: boolean }): Promise<Response> {
  const safety = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
  const r = await apiStream(path, { accept: "image/*", cookie: opts.cookie, timeoutMs: 5_000, headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : undefined });
  // A 304 is no failure: the browser keeps the image it has.
  if (!r.ok) return r.status === 304 ? new Response(null, { status: 304, headers: safety }) : notFound();
  if (r.res.status !== 200) return notFound();
  const out = new Headers(safety);
  for (const h of IMAGE_HEADERS) {
    const value = r.res.headers.get(h);
    if (value) out.set(h, value);
  }
  return new Response(r.res.body, { status: 200, headers: out });
}

/** Streams one icon image from the API. Without one there is no image, and the icon shows its default. */
export async function proxyIcon(t: IconTarget, v: string | null, ifNoneMatch: string | null): Promise<Response> {
  if (t.target === "app" ? !ID.test(t.id) : !SLUG.test(t.slug)) return notFound();
  const version = v && VERSION.test(v) ? v : null;
  if (!process.env.DOCKIFY_API_URL) return notFound();
  return relayImage(version ? `${pathOf(t)}?v=${version}` : pathOf(t), ifNoneMatch, { cookie: true });
}

/** The shape of a signed mail icon token (crypto's signMailIcon): the owner, the icon version and the MAC. */
const MAIL_TOKEN = /^[ap][0-9a-f]{44}[A-Za-z0-9_-]{43}$/;

/**
 * Streams one signed mail icon from the API, without the visitor's cookie: the email's reader has
 * no session here, and the token is the whole credential, which the API checks. The API answers
 * with public, immutable caching, relayed as it is.
 */
export async function proxyMailIcon(token: string, ifNoneMatch: string | null): Promise<Response> {
  if (!MAIL_TOKEN.test(token)) return notFound();
  if (!process.env.DOCKIFY_API_URL) return notFound();
  return relayImage(`/api/v1/icons/mail/${token}`, ifNoneMatch, { cookie: false });
}
