// The password gate in front of a preview's URL. Traefik asks here about every preview request
// (forwardAuth), so a preview is never served without it: when the api is down the gate stays shut.
// The cookie is an HMAC under a master-key subkey over the preview, its expiry and the current hash:
// a rotation ends every cookie, a database reader cannot mint one, and a cookie opens one preview only.
import { randomInt, timingSafeEqual } from "node:crypto";
import { hash as argonHash } from "@node-rs/argon2";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { PREVIEW_GATE_CHECK_PATH, PREVIEW_GATE_PATH } from "@dockify/contracts";
import { keyedHash } from "@dockify/crypto";
import type { Ctx } from "../../app.ts";
import { passwordMatches } from "../../passwords.ts";
import { INFRA_POLICIES } from "../../policy.ts";
import { Limiter, networkKey } from "../../ratelimit.ts";

export const GATE_ROUTES = { check: `${PREVIEW_GATE_CHECK_PATH}/:id`, form: `${PREVIEW_GATE_PATH}/:id` } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COOKIE = "__Host-dockify_preview";
const COOKIE_MS = 24 * 3600_000;
const CACHE_MS = 5_000;
const CACHE_MAX = 2_000;
const FORM_BYTES = 4 * 1024;
const PASSWORD_MAX = 200;

/** No look-alike characters, because people read this one out and retype it. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const GROUPS = 4;
const GROUP = 5;

/** Twenty characters of 31 in four groups: about 99 bits. */
export function newPreviewPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let s = "";
    for (let i = 0; i < GROUP; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join("-");
}

export const hashPreviewPassword = (password: string): Promise<string> => argonHash(password);

interface GateRow {
  access: "public" | "password";
  hash: string | null;
  at: number;
}

export function gateToken(sign: (value: string) => string, id: string, hash: string, expires: number): string {
  return `${expires}.${sign(`${id}|${expires}|${hash}`)}`;
}

export function gateTokenValid(sign: (value: string) => string, id: string, hash: string, token: string, now: number): boolean {
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return false;
  const expires = Number(m[1]);
  if (expires <= now) return false;
  const want = Buffer.from(sign(`${id}|${expires}|${hash}`));
  const got = Buffer.from(m[2]!);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Strips the gate's own cookie, so a preview's code never holds it. */
export function withoutGateCookie(header: string | undefined): string | null {
  if (!header) return null;
  const kept = header.split(";").map((p) => p.trim()).filter((p) => p && p.slice(0, p.indexOf("=") >>> 0) !== COOKIE);
  return kept.length ? kept.join("; ") : null;
}

function readGateCookie(header: string | undefined): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Only a path on this same host: never a scheme, another host, or a backslash a browser reads as a slash. */
export function safeNext(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2000) return "/";
  return /^\/(?![/\\])[^\s\\]*$/.test(raw) ? raw : "/";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Shown to anyone with the link, crawlers included, so it names no project, pull request or person. */
export function gatePage(o: { next: string; note?: string; form?: boolean }): string {
  const form = o.form ?? true;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>This preview is password protected</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box; font: 16px/24px system-ui, sans-serif; }
main { width: 100%; max-width: 400px; }
h1 { margin: 0 0 8px; font-size: 24px; line-height: 32px; font-weight: 600; }
p { margin: 0 0 16px; opacity: .7; }
p.note { opacity: 1; color: #d93025; }
label { display: block; margin-bottom: 4px; font-size: 14px; }
input, button { box-sizing: border-box; width: 100%; height: 40px; font: inherit; border-radius: 6px; }
input { padding: 0 12px; border: 1px solid #8888; background: transparent; color: inherit; margin-bottom: 12px; }
button { border: 0; background: #2396ed; color: #fff; font-weight: 500; cursor: pointer; }
</style>
</head>
<body>
<main>
<h1>This preview is password protected</h1>
${form ? "<p>Ask a project admin for the password. It is in the project's preview settings.</p>" : "<p>Its password has not been set yet. A project admin can make one in the project's preview settings.</p>"}
${o.note ? `<p class="note" role="alert">${esc(o.note)}</p>` : ""}
${form ? `<form method="post" action="${PREVIEW_GATE_PATH}">
<input type="hidden" name="next" value="${esc(o.next)}">
<label for="p">Password</label>
<input id="p" name="password" type="password" autocomplete="current-password" required autofocus maxlength="${PASSWORD_MAX}">
<button type="submit">Continue</button>
</form>` : ""}
</main>
</body>
</html>
`;
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
/** Not the api's default no-referrer: under that a browser sends "Origin: null" on the page's own form post. */
const PAGE_REFERRER = "same-origin";

export function registerPreviewGate(app: FastifyInstance, ctx: Pick<Ctx, "db" | "ring" | "config">): void {
  const { db, ring, config } = ctx;
  const sign = (value: string) => keyedHash(ring, "preview-gate", value);
  const cache = new Map<string, GateRow>();
  // Per preview and client network, then a ceiling per preview against guessing from many networks.
  const perClient = new Limiter({ perMinute: 6, burst: 10 });
  const perPreview = new Limiter({ perMinute: 30, burst: 60 });

  const load = async (id: string): Promise<GateRow | null> => {
    const now = Date.now();
    const hit = cache.get(id);
    if (hit && now - hit.at < CACHE_MS) return hit;
    const row = await db.previewDeployment.findUnique({ where: { id }, select: { env: { select: { project: { select: { previewAccess: true, previewPasswordHash: true } } } } } });
    if (!row) {
      cache.delete(id);
      return null;
    }
    if (cache.size >= CACHE_MAX) cache.clear();
    const fresh: GateRow = { access: row.env.project.previewAccess, hash: row.env.project.previewPasswordHash, at: now };
    cache.set(id, fresh);
    return fresh;
  };

  const page = (reply: import("fastify").FastifyReply, status: number, html: string) =>
    reply.code(status).header("content-security-policy", PAGE_CSP).header("referrer-policy", PAGE_REFERRER).header("cache-control", "no-store").header("x-robots-tag", "noindex, nofollow").type("text/html; charset=utf-8").send(html);

  // forwardAuth: 200 lets the request through, anything else goes to the visitor. Edge network only.
  app.get(GATE_ROUTES.check, { config: { policy: INFRA_POLICIES["GET /internal/preview-gate/:id"] } }, async (req, reply) => {
    const id = (req.params as { id?: unknown }).id;
    const next = safeNext(req.headers["x-forwarded-uri"]);
    if (typeof id !== "string" || !UUID.test(id)) return page(reply, 404, gatePage({ next, form: false }));
    const row = await load(id);
    if (!row) return page(reply, 404, gatePage({ next, form: false }));
    const cookieHeader = typeof req.headers.cookie === "string" ? req.headers.cookie : undefined;
    if (row.access === "public" || (row.hash && gateTokenValid(sign, id, row.hash, readGateCookie(cookieHeader) ?? "", Date.now()))) {
      // Traefik replaces the request's Cookie with this answer's (authResponseHeaders), and removes it when there is none.
      const rest = withoutGateCookie(cookieHeader);
      if (rest) void reply.header("cookie", rest);
      return reply.code(200).send();
    }
    return page(reply, 401, gatePage({ next, form: !!row.hash }));
  });

  // Its own scope, so the form body parser applies to this route alone. Traefik sets the id with replacePath.
  void app.register(async (scope) => {
    scope.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: FORM_BYTES }, (_req, body, done) => done(null, body));
    scope.post(GATE_ROUTES.form, { config: { policy: INFRA_POLICIES["POST /.well-known/dockify-preview-gate/:id"] }, bodyLimit: FORM_BYTES }, async (req, reply) => {
      const id = (req.params as { id?: unknown }).id;
      const form = new URLSearchParams(typeof req.body === "string" ? req.body : "");
      const next = safeNext(form.get("next"));
      if (typeof id !== "string" || !UUID.test(id)) return page(reply, 404, gatePage({ next, form: false }));
      // A form on another site must not be able to sign a visitor in, or spend their guesses.
      if (!gateFormAllowed(req.headers)) return page(reply, 403, gatePage({ next, note: "That request came from another site." }));
      const key = `${id}|${networkKey(gateClient(req, config.ingress))}`;
      const wait = perClient.take(key) ?? perPreview.take(id);
      if (wait !== null) {
        return page(reply.header("retry-after", String(wait)), 429, gatePage({ next, note: `Too many tries. Wait ${wait} seconds and try again.` }));
      }
      const row = await load(id);
      if (!row) return page(reply, 404, gatePage({ next, form: false }));
      if (row.access === "public") return reply.code(303).header("location", next).send();
      if (!row.hash) return page(reply, 401, gatePage({ next, form: false }));
      const password = (form.get("password") ?? "").trim().slice(0, PASSWORD_MAX);
      if (!password || !(await passwordMatches(row.hash, password))) return page(reply, 401, gatePage({ next, note: "That password is not right." }));
      const expires = Date.now() + COOKIE_MS;
      return reply
        .code(303)
        .header("set-cookie", `${COOKIE}=${gateToken(sign, id, row.hash, expires)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MS / 1000}`)
        .header("location", next)
        .send();
    });
  });
}

/**
 * Whether the form post came from the gate page itself. "Origin: null" can also be a sandboxed frame
 * on any site, so it passes only when Sec-Fetch-Site says same-origin. A caller with neither header
 * is not a browser, so it has no visitor's session to abuse.
 */
export function gateFormAllowed(headers: { "sec-fetch-site"?: string | string[] | undefined; origin?: string | string[] | undefined; host?: string | undefined }): boolean {
  const site = headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  if (origin === "null") return site === "same-origin";
  try {
    return typeof origin === "string" && new URL(origin).host === headers.host;
  } catch {
    return false;
  }
}

/**
 * The address to count guesses against. In tunnel mode clientIp is Traefik's, so Cloudflare's header
 * is used. A tenant can forge it to get fresh buckets; the per-preview ceiling still holds, and
 * this value must never decide anything else.
 */
function gateClient(req: FastifyRequest, ingress: string): string {
  const cf = req.headers["cf-connecting-ip"];
  return ingress === "cloudflare_tunnel" && typeof cf === "string" && cf.length <= 64 ? cf : req.clientIp;
}
