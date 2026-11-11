/** DOCKIFY_PUBLIC_URL wins, else Host. Never X-Forwarded-Host (in tunnel mode a visitor's value arrives
 * untouched and would poison a cached response) and never request.url (localhost behind the proxy). */
export function requestOrigin(request: Pick<Request, "headers">): string | null {
  const env = process.env.DOCKIFY_PUBLIC_URL;
  if (env) {
    try {
      return new URL(env).origin;
    } catch {
      return null;
    }
  }
  const host = request.headers.get("host") ?? "";
  if (!/^[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(host)) return null;
  // Plain http only on the SSH tunnel's loopback port; never from a header a visitor can set.
  return `${/^127\.0\.0\.1:\d+$/.test(host) ? "http" : "https"}://${host}`;
}
