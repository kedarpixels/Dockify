/**
 * The dashboard's public origin for absolute links built in a route handler. DOCKIFY_PUBLIC_URL
 * wins; otherwise the Host header, which the tunnel and the proxy only hand to this container when
 * it names the dashboard. X-Forwarded-Host is never read: in tunnel mode a visitor's own value
 * arrives untouched, and would plant a foreign link in a publicly cached response. request.url is
 * never used either: behind the proxy it reads localhost. Pure, so it tests without Next.
 */
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
