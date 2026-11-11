/** Null when the site is not served over https. No includeSubDomains: this site speaks for its own host only. */
export function hstsFor(siteUrl: string): string | null {
  return siteUrl.startsWith("https://") ? "max-age=31536000" : null;
}
