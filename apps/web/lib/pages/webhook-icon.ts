import "server-only";
import { apiStream } from "@/lib/api";
import { NO_STORE } from "@/lib/http";

/*
 * A generic webhook's logo or site icon, relayed from the API the way app icons are
 * (lib/pages/icons.ts): same origin, so the console never loads the API or a third-party host
 * directly; only the type the API's check found, with nosniff and a sandboxing CSP, which matters
 * for an SVG logo even though the API stores one only as its sanitised rebuild.
 */

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[a-f0-9]{12}$/;
const IMAGE_HEADERS = ["content-type", "cache-control", "etag", "content-length"];
const SAFETY = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
const notFound = () => new Response(null, { status: 404, headers: NO_STORE });

/** Streams one webhook icon from the API, or 404 so the row shows the provider's mark instead. */
export async function proxyWebhookIcon(id: string, v: string | null, ifNoneMatch: string | null): Promise<Response> {
  if (!ID.test(id) || !process.env.DOCKIFY_API_URL) return notFound();
  const version = v && VERSION.test(v) ? v : null;
  const path = `/api/v1/integrations/webhooks/${id}/icon${version ? `?v=${version}` : ""}`;
  const r = await apiStream(path, { accept: "image/*", timeoutMs: 5_000, headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : undefined });
  // A 304 is no failure: the browser keeps the image it has.
  if (!r.ok) return r.status === 304 ? new Response(null, { status: 304, headers: SAFETY }) : notFound();
  if (r.res.status !== 200) return notFound();
  const out = new Headers(SAFETY);
  for (const h of IMAGE_HEADERS) {
    const value = r.res.headers.get(h);
    if (value) out.set(h, value);
  }
  return new Response(r.res.body, { status: 200, headers: out });
}
