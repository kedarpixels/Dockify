/*
 * What the browser knows about the dashboard's address and about a hostname on Cloudflare. The shapes
 * are the API's (packages/contracts/src/dashboard-domain.ts), read through this dashboard's own routes:
 *
 *   GET    /api/settings/domain                  -> DashboardDomain
 *   POST   /api/settings/domain                  { hostname } starts setting a new domain up
 *   POST   /api/settings/domain/check            a fresh check, waited for
 *   POST   /api/settings/domain/record           { proxied, replace } creates its Cloudflare record
 *   POST   /api/settings/domain/switch           moves the dashboard, once the domain is ready
 *   DELETE /api/settings/domain                  stops setting it up
 *   DELETE /api/settings/domain/previous/:host   stops an old address answering
 *   GET    /api/domains/cloudflare               every domain's state on Cloudflare
 *   GET    /api/domains/cloudflare/lookup?hostname=  one hostname's, before it is added
 *   POST   /api/domains/:id/cloudflare           { proxied, replace } creates or fixes its record
 *
 * Pure, so the rules test without Next, and it holds no fixture: previews build theirs on the server.
 */

export type CfSslMode = "off" | "flexible" | "full" | "strict";

export interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  /** Dockify created it. */
  ours: boolean;
}

export interface CfFinding {
  code: string;
  tone: "bad" | "warn" | "info";
  text: string;
}

export interface CfHostState {
  hostname: string;
  zone: { id: string; name: string; status: "active" | "pending" } | null;
  managed: boolean;
  records: CfRecord[];
  expected: { type: string; content: string; proxied: boolean | null } | null;
  correct: boolean;
  sslMode: CfSslMode | null;
  alwaysUseHttps: boolean | null;
  findings: CfFinding[];
}

export interface CfDomains {
  connected: boolean;
  items: Array<{ domainId: string; state: CfHostState }>;
  error: string | null;
}

export interface CfLookup {
  connected: boolean;
  state: CfHostState | null;
  error: string | null;
}

export type DomainPhase = "waiting" | "ready" | "switching" | "failed";

export interface PendingDomain {
  host: string;
  phase: DomainPhase;
  requestedAt: string;
  requestedBy: string | null;
  dns: { status: "ok" | "mismatch" | "missing" | "unchecked"; resolved: string[]; detail: string | null; checkedAt: string | null };
  probe: { status: "untried" | "passed" | "failed"; detail: string | null; checkedAt: string | null };
  tls: { status: "active" | "pending" | "failed"; issuer: string | null; expiresAt: string | null; detail: string | null };
  error: string | null;
  cfRecord: { zoneId: string; recordId: string } | null;
  /** On a zone Dockify manages, with no record yet: nothing is looked up until Dockify makes it. */
  recordFirst?: boolean;
}

export interface GitHubSteps {
  slug: string;
  settingsUrl: string;
  homepageUrl: string;
  callbackUrl: string;
  setupUrl: string;
  webhookUrl: string;
}

export interface LastChange {
  from: string;
  to: string;
  at: string;
  webhook: "updated" | "failed" | "none";
  webhookError: string | null;
}

export interface DashboardDomain {
  url: string;
  host: string;
  ingress: "cloudflare_tunnel" | "direct_tls";
  server: { ipv4: string | null; ipv6: string | null; tunnelTarget: string | null };
  previousHosts: string[];
  /** Old addresses with a Cloudflare record Dockify made, which Stop answering removes. */
  previousRecords: string[];
  pending: PendingDomain | null;
  cloudflareConnected: boolean;
  cloudflare: CfHostState | null;
  github: GitHubSteps | null;
  lastChange: LastChange | null;
}

/** A hostname as typed: no scheme, no path, no trailing dot, lowercase. */
export const cleanHost = (raw: string): string => raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");

export const HOST_RE = /^(?=.{4,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

/** A name sslip.io answers with its own address: the address an install starts on. */
export const isSslipHost = (host: string): boolean => /^\d{1,3}(?:-\d{1,3}){3}\.(?:sslip|nip)\.io$/i.test(host);

/** Any name under such an address: its DNS answers by itself, so there is never a record to create. */
export const resolvesItself = (host: string): boolean => /(?:^|\.)\d{1,3}(?:-\d{1,3}){3}\.(?:sslip|nip)\.io$/i.test(host);

/** How one proxied or DNS-only record reads. */
export const recordMode = (r: Pick<CfRecord, "proxied">): string => (r.proxied ? "Proxied" : "DNS only");

export const SSL_LABEL: Record<CfSslMode, string> = { off: "Off", flexible: "Flexible", full: "Full", strict: "Full (strict)" };

/** A name and a zone, as the picker holds them: "@" or empty is the zone's apex. A pasted full hostname is taken as it is. */
export function joinHost(name: string, zone: string): string {
  const n = cleanHost(name).replace(/^@$/, "");
  const z = cleanHost(zone);
  if (!n || n === z) return zone;
  return n.endsWith(`.${z}`) ? n : `${n}.${zone}`;
}

/** The worst of a hostname's findings, for its chip; null when there is nothing to say. */
export function worstFinding(s: Pick<CfHostState, "findings"> | null | undefined): CfFinding["tone"] | null {
  if (!s?.findings.length) return null;
  return s.findings.some((f) => f.tone === "bad") ? "bad" : s.findings.some((f) => f.tone === "warn") ? "warn" : "info";
}

/** The step the setup of a new domain is on, for the checks' list. */
export function domainChecks(p: PendingDomain): Array<{ key: string; label: string; state: "ok" | "wait" | "bad"; detail: string | null }> {
  const pointed = p.dns.status === "ok";
  const asked = p.probe.status === "failed" ? p.probe.detail : null;
  return [
    {
      key: "dns",
      label: "Points at this server",
      state: pointed ? "ok" : p.dns.status === "mismatch" ? "bad" : "wait",
      detail: pointed
        ? null
        : (p.dns.detail ?? (p.dns.status !== "unchecked" ? "No record found yet." : p.recordFirst ? "Checked once the record is created on Cloudflare." : "Not checked yet.")),
    },
    {
      key: "answer",
      label: "Answers from this server",
      state: pointed ? "ok" : asked ? "bad" : "wait",
      detail: asked,
    },
    {
      key: "tls",
      label: "Has its certificate",
      state: p.tls.status === "active" ? "ok" : p.tls.status === "failed" ? "bad" : "wait",
      detail: p.tls.status === "active" ? (p.tls.issuer ? `Issued by ${p.tls.issuer}.` : null) : pointed ? (p.tls.detail ?? "Being issued.") : "Requested once the domain points here.",
    },
  ];
}
