/**
 * Strict-Transport-Security for the site, or null when it is not served over https. A browser ignores
 * the header on plain http, so a local run is safe either way; the check keeps a staging deploy on
 * http honest. No includeSubDomains: this page speaks for its own host, not for what else may live
 * under the domain.
 */
export function hstsFor(siteUrl: string): string | null {
  return siteUrl.startsWith("https://") ? "max-age=31536000" : null;
}
