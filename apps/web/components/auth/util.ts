/* Server-safe helpers for the auth pages (no "use client", so server pages can call them). */

import type { AuthResult } from "@/lib/pages/auth";

/* A throwaway origin to resolve `next` against: whatever leaves it is another site. */
const SELF = "http://dockify.invalid";

/**
 * Only same-origin paths survive as a post sign-in destination; anything else lands on Overview.
 * The value is resolved the way the browser will resolve it, so tricks such as "/\evil.com" or
 * "/<tab>/evil.com" (the URL parser drops tabs and reads a backslash as a slash) cannot escape.
 */
export function safeNext(next: string | string[] | undefined | null): string {
  const v = Array.isArray(next) ? next[0] : next;
  if (!v || !v.startsWith("/")) return "/";
  try {
    const url = new URL(v, SELF);
    if (url.origin !== SELF) return "/";
    // Dot segments collapse while parsing ("/..//evil.com" has pathname "//evil.com"), so the
    // result is checked again: it must still be a single-slash path that stays on this origin.
    const out = `${url.pathname}${url.search}${url.hash}`;
    return isLocalPath(out) ? out : "/";
  } catch {
    return "/";
  }
}

/**
 * True for a path the browser resolves on this origin: one leading slash, no "//" or "/\"
 * opening (protocol-relative), and nothing that leaves the origin when resolved.
 */
export function isLocalPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return false;
  try {
    return new URL(path, SELF).origin === SELF;
  } catch {
    return false;
  }
}

/** The destination the client may navigate to after sign in: `next` when it is local, else Overview. */
export function localDestination(next: string): string {
  return isLocalPath(next) ? next : "/";
}

/** Appends ?next= only when it leads somewhere other than Overview. */
export function withNext(path: string, next: string): string {
  return next === "/" ? path : `${path}${path.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}`;
}

/**
 * Awaits a server action and turns a thrown call (the web server restarting, the network
 * dropping) into an ordinary error, so a failed request never reaches the error boundary.
 */
export async function settle<T extends object>(action: Promise<AuthResult<T>>): Promise<AuthResult<T>> {
  try {
    return await action;
  } catch {
    // The words of OFFLINE in lib/client-api, which this server-safe module cannot import.
    return { ok: false, error: "Could not reach the dashboard. Check your connection" };
  }
}
