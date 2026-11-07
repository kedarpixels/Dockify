import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { SITE_URL } from "@/components/seo/config";
import { hstsFor } from "./lib/hsts";

/*
 * Security headers for every response on the marketing and docs site. The site takes no input and
 * holds no session, but it is still framed-clickjacking and MIME-sniffing surface, and the install
 * page shows commands people paste as root, so it must not be embeddable or sniffable.
 *
 * Every page is prerendered at build time, so the CSP allows scripts by hash instead of by nonce:
 * a nonce has to be fresh per response, which would force every page to render on each request.
 * The first request reads the prerendered pages (.next/server/app/**.html) once, hashes each page's
 * inline scripts (the pre-paint theme script and Next's own inline bootstrap), and every response
 * then lists exactly its page's hashes: no 'unsafe-inline', no nonce, nothing else can run.
 * Client-side navigation keeps the document it started on, and fetches no inline script.
 *
 * A path with no prerendered page is answered by the prerendered 404, so it gets that page's hashes.
 * Development renders on demand, so `next dev` gets 'unsafe-inline' and 'unsafe-eval' instead.
 */

const BASE = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
];

const policy = (scriptSrc: string) => [...BASE.slice(0, 1), `script-src 'self'${scriptSrc}`, ...BASE.slice(1)].join("; ");

const INLINE = /<script(?![^>]*\ssrc=)(?![^>]*type="application\/(?:ld\+)?json")[^>]*>([\s\S]*?)<\/script>/g;

/** route ("/", "/docs/backups", "/_not-found") to its CSP, built on first use. */
let table: Map<string, string> | null = null;

function build(): Map<string, string> {
  const root = path.join(/* turbopackIgnore: true */ process.cwd(), ".next", "server", "app");
  const out = new Map<string, string>();
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(/* turbopackIgnore: true */ dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}/${e.name}`);
      else if (e.name.endsWith(".html")) {
        const html = readFileSync(/* turbopackIgnore: true */ path.join(dir, e.name), "utf8");
        const hashes = new Set<string>();
        for (const m of html.matchAll(INLINE)) {
          if (m[1]) hashes.add(`'sha256-${createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
        }
        const name = e.name.slice(0, -".html".length);
        const route = name === "index" && prefix === "" ? "/" : `${prefix}/${name}`;
        out.set(route, policy(hashes.size ? ` ${[...hashes].join(" ")}` : ""));
      }
    }
  };
  try {
    walk(root, "");
  } catch {
    /* no build output (an unusual start): fall through to the strict default below */
  }
  return out;
}

function cspFor(pathname: string): string {
  if (process.env.NODE_ENV === "development") return policy(" 'unsafe-inline' 'unsafe-eval'");
  table ??= build();
  const route = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return table.get(route) ?? table.get("/_not-found") ?? policy("");
}

export function proxy(req: NextRequest) {
  const res = NextResponse.next();
  res.headers.set("Content-Security-Policy", cspFor(req.nextUrl.pathname));
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  const hsts = process.env.NODE_ENV === "development" ? null : hstsFor(SITE_URL);
  if (hsts) res.headers.set("Strict-Transport-Security", hsts);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
