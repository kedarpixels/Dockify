/** Addresses Vercel sends that end up as links in the dashboard: each is checked before it is stored. */

/** The deployment's own address: only a bare hostname from Vercel becomes a link. */
export function httpsOfHost(host: string | null | undefined): string | null {
  if (typeof host !== "string") return null;
  const h = host.trim().toLowerCase();
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) ? `https://${h}` : null;
}

/** Vercel's inspector page, https on vercel.com only. */
export function safeInspectorUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.hostname === "vercel.com" || u.hostname.endsWith(".vercel.com") ? u.toString() : null;
  } catch {
    return null;
  }
}
