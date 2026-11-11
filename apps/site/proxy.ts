import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { SITE_URL } from "@/components/seo/config";
import { hstsFor } from "./lib/hsts";

/*
 * Pages are prerendered, so the CSP allows inline scripts by hash: a nonce must be fresh per response, which
 * would force every page to render per request. The first request hashes each prerendered page's scripts once.
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
  // A host that runs the proxy apart from the build output (Vercel) leaves nothing to hash. A hash-only policy
  // would block Next's own bootstrap there, so inline scripts are allowed instead.
  if (table.size === 0) return policy(" 'unsafe-inline'");
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
