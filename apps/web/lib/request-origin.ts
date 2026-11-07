import "server-only";
/**
 * The dashboard's public origin for absolute links built in a route handler. DOCKIFY_PUBLIC_URL
 * wins; otherwise the forwarded host, accepted only when it looks like a hostname, so a forged Host
 * header cannot plant a foreign link in a cached response. request.url is never used: behind the
 * proxy it reads localhost.
 */
export function requestOrigin(request: Request): string | null {
  const env = process.env.DOCKIFY_PUBLIC_URL;
  if (env) {
    try {
      return new URL(env).origin;
    } catch {
      return null;
    }
  }
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  if (!/^[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(host)) return null;
  const proto = request.headers.get("x-forwarded-proto") === "http" ? "http" : "https";
  return `${proto}://${host}`;
}
