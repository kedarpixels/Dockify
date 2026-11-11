// frame-ancestors 'none' stops a tenant app on a sibling subdomain (same site, so the session cookie
// rides along) from framing the console. Next applies the nonce it finds in the request's CSP header.

export const NONCE_HEADER = "x-nonce";

export function contentSecurityPolicy(nonce: string, dev = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    // github.com for one form: Create GitHub App posts its manifest there, the only way GitHub takes it.
    "form-action 'self' https://github.com",
  ].join("; ");
}

export function securityHeaders(nonce: string, dev = false, https = false): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(nonce, dev),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // Only once the request already arrived over https, so the http://127.0.0.1:3000 escape hatch
    // (and the first plain-http redirect to https) still work; it pins https for a year after that.
    ...(https ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
  };
}

export function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
