/**
 * Names that can never point at a public server, so a certificate request for one can only fail and spend
 * Let's Encrypt's failure budget. The api refuses them when a domain is added; the worker never routes one.
 */
export const NON_PUBLIC_SUFFIXES: readonly string[] = [
  "localhost", "local", "internal", "test", "invalid", "example", "onion", "alt", "arpa",
  "lan", "localdomain", "intranet", "corp", "home", "private",
];

/** Why `host` can never be a public site, or null when it can. */
export function nonPublicHostReason(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || /^\[.*\]$/.test(h)) return "Use a domain name, not an IP address";
  if (!h.includes(".")) return "Use a full domain name, for example app.example.com";
  const suffix = NON_PUBLIC_SUFFIXES.find((s) => h === s || h.endsWith(`.${s}`));
  return suffix ? `.${suffix} names never point at a public server, so this one could never get a certificate` : null;
}
