import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { safeNext } from "@/components/auth/util";
import { PATH_HEADER, SESSION_COOKIES } from "@/lib/forwarded";
import { isPreviewMode } from "@/lib/preview-mode";
import { contentSecurityPolicy, makeNonce, NONCE_HEADER, securityHeaders } from "@/lib/security-headers";

/*
 * Keeps signed-out visitors out of the console and sets the security headers on every response.
 *
 * A request without the session cookie goes to /login?next=<path>, or gets a 401 for a same-origin
 * API route; the signed-out pages, public status pages (and their /api/status feeds) and static
 * files pass. This only checks that a cookie is present: the Dockify API still validates the
 * session on every call, and a loader that gets 401 sends the visitor to sign in again. Refusing
 * cookieless /api calls here means anonymous traffic never reaches the API through the web.
 *
 * The cookie names are the ones the API issues (`__Host-dockify_sid` on https, `dockify_sid` on
 * plain http), unless DOCKIFY_SESSION_COOKIE names another.
 *
 * Every request that passes carries its path in `x-dockify-path` (PATH_HEADER, lib/forwarded.ts),
 * set here so a client cannot choose it, which loaders use as ?next= when a session ends, and the
 * per-request CSP nonce in `x-nonce`, which the root layout puts on its inline script.
 *
 * A few bare paths that only make sense with an id or a token after them go somewhere useful
 * instead of a 404: /apps lists projects, /invite and /reset start from sign in and forgot.
 */

const COOKIES: readonly string[] = process.env.DOCKIFY_SESSION_COOKIE ? [process.env.DOCKIFY_SESSION_COOKIE] : SESSION_COOKIES;

/* Exact paths and path prefixes that never need a session. /api/icons/mail serves the signed icon
   links in emails, which a mail client fetches with no cookie; the token itself is the credential. */
const OPEN = ["/login", "/recover", "/forgot", "/reset", "/setup", "/invite", "/status", "/api/status", "/api/icons/mail"];

/* Files served as they are: the public folder and the app icons. */
const STATIC_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|txt|xml|webmanifest|json|woff2?|ttf|otf|mp3|wav|ogg|css|js|map)$/i;

/* Public asset folders. A nested static path is exempt only here; elsewhere a path ending in an
   extension is a dynamic route (e.g. /projects/x.css hits /projects/[slug]) and must be gated. */
const ASSET_PREFIX = ["/preview/"];
const isStaticAsset = (path: string): boolean =>
  STATIC_FILE.test(path) && (path.indexOf("/", 1) === -1 || ASSET_PREFIX.some((p) => path.startsWith(p)));

/** Paths that need an id or a token after them, and where the bare path goes instead. */
const BARE: Record<string, string> = { "/apps": "/projects", "/invite": "/login", "/reset": "/forgot" };

const isOpen = (path: string) => OPEN.some((p) => path === p || path.startsWith(`${p}/`));
const isApi = (path: string) => path === "/api" || path.startsWith("/api/");

function hasSession(req: Pick<NextRequest, "cookies">): boolean {
  return COOKIES.some((name) => !!req.cookies.get(name)?.value);
}

/*
 * The Server Action ids this build has, from Next's own manifest (the server runs from the app
 * folder, so the path is relative to it). An id it does not have (a tab left open across an update,
 * or a probe) answers 404 here with Next's not-found header, which its client reads as an action
 * that is gone; Next itself would answer 409, and older builds 500. Read once. Without a readable
 * manifest the check stands aside and Next decides.
 */
let actionIds: ReadonlySet<string> | null | undefined;
function knownActions(): ReadonlySet<string> | null {
  if (actionIds !== undefined) return actionIds;
  try {
    const m = JSON.parse(readFileSync(join(process.cwd(), ".next", "server", "server-reference-manifest.json"), "utf8")) as { node?: object; edge?: object };
    actionIds = new Set([...Object.keys(m.node ?? {}), ...Object.keys(m.edge ?? {})]);
  } catch {
    actionIds = null;
  }
  return actionIds;
}

function secure(res: NextResponse, nonce: string, dev: boolean, https: boolean): NextResponse {
  for (const [k, v] of Object.entries(securityHeaders(nonce, dev, https))) res.headers.set(k, v);
  return res;
}

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const preview = isPreviewMode();
  const dev = process.env.NODE_ENV === "development";
  const nonce = makeNonce();
  // HSTS rides only on responses to an https request (direct TLS or behind Cloudflare/Traefik).
  const https = (req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.nextUrl.protocol.replace(":", "")) === "https";

  const bare = BARE[pathname.replace(/\/+$/, "")];
  if (bare) return secure(NextResponse.redirect(new URL(bare, req.url)), nonce, dev, https);

  const action = req.method === "POST" ? req.headers.get("next-action") : null;
  if (action !== null && knownActions()?.has(action) === false) {
    return secure(new NextResponse("Server Action not found", { status: 404, headers: { "content-type": "text/plain", "x-nextjs-action-not-found": "1" } }), nonce, dev, https);
  }

  // Static files never carry the API path rule (an /api path ending in .json is still an API call).
  const gated = !preview && !isOpen(pathname) && (isApi(pathname) || !isStaticAsset(pathname));
  if (gated && !hasSession(req)) {
    if (isApi(pathname)) return secure(NextResponse.json({ error: "Sign in again" }, { status: 401 }), nonce, dev, https);
    const to = new URL("/login", req.url);
    const next = safeNext(`${pathname}${search}`);
    if (next !== "/") to.searchParams.set("next", next);
    return secure(NextResponse.redirect(to), nonce, dev, https);
  }

  const headers = new Headers(req.headers);
  headers.set(PATH_HEADER, `${pathname}${search}`);
  headers.set(NONCE_HEADER, nonce);
  // Next reads the nonce from the request's CSP header and puts it on its own inline scripts.
  headers.set("content-security-policy", contentSecurityPolicy(nonce, dev));
  return secure(NextResponse.next({ request: { headers } }), nonce, dev, https);
}

export const config = {
  // Next's own build output never needs the check.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
