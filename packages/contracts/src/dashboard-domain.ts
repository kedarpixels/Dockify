import { z } from "zod";
import { Hostname, Iso, TlsStatus } from "./common.ts";
import { DnsStatus, DomainProbeStatus, IngressMode } from "./resources.ts";

/**
 * DOCKIFY_PUBLIC_URL in .env is the one source of the current address. A new domain waits in
 * instance.dashboardDomain until it answers with a certificate; then the updater rewrites .env. The old
 * address keeps serving /api/v1/ (GitHub does not follow a redirect) and redirects the rest.
 */

export const CfId = z.string().regex(/^[0-9a-f]{32}$/);
export const CfSslMode = z.enum(["off", "flexible", "full", "strict"]);
export const CfRecord = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean(),
  /** Dockify created it: its id is the one recorded for this hostname. Only such a record is ever removed without asking. */
  ours: z.boolean(),
});
export const CfFindingCode = z.enum([
  "not_managed", "no_zone", "zone_pending", "no_record", "wrong_target", "needs_proxy", "extra_record",
  "ssl_flexible", "ssl_off", "ssl_strict_no_cert", "always_https", "dns_denied", "ssl_denied",
]);
export const CfFinding = z.object({ code: CfFindingCode, tone: z.enum(["bad", "warn", "info"]), text: z.string() });
export const CfHostState = z.object({
  hostname: z.string(),
  /** The Cloudflare zone that owns the hostname; null when none this token can see does. */
  zone: z.object({ id: z.string(), name: z.string(), status: z.enum(["active", "pending"]) }).nullable(),
  /** The owner switched this zone on in Settings, Integrations. Nothing else is read or written. */
  managed: z.boolean(),
  /** A, AAAA and CNAME records at exactly this name. */
  records: z.array(CfRecord),
  /** The record this hostname needs in this server's mode; null when the server's address is unknown. */
  expected: z.object({ type: z.string(), content: z.string(), proxied: z.boolean().nullable() }).nullable(),
  correct: z.boolean(),
  /** null when the zone is not managed, or the token cannot read it. */
  sslMode: CfSslMode.nullable(),
  alwaysUseHttps: z.boolean().nullable(),
  findings: z.array(CfFinding),
});
export const CfDomainsPayload = z.object({
  connected: z.boolean(),
  items: z.array(z.object({ domainId: z.string(), state: CfHostState })),
  /** Why the state could not be read at all; the rest of the page carries on. */
  error: z.string().nullable(),
});
export const CfLookupQuery = z.strictObject({ hostname: Hostname });
export const CfLookup = z.object({ connected: z.boolean(), state: CfHostState.nullable(), error: z.string().nullable() });
/**
 * Creates the record a hostname needs. `replace` is the explicit go-ahead to remove exactly these
 * records first: their ids as the page showed them. If what is on Cloudflare differs, nothing changes.
 */
export const CfRecordBody = z.strictObject({
  /** Direct mode only: through Cloudflare's proxy, or DNS only. A tunnel's record is always proxied. */
  proxied: z.boolean().optional(),
  replace: z.array(CfId).max(10).optional(),
});
export const CfRecordResult = z.object({ state: CfHostState });

export const DashboardDomainPhase = z.enum(["waiting", "ready", "switching", "failed"]);
export const PendingDashboardDomain = z.object({
  host: z.string(),
  phase: DashboardDomainPhase,
  requestedAt: Iso,
  requestedBy: z.string().nullable(),
  dns: z.object({ status: DnsStatus, resolved: z.array(z.string()), detail: z.string().nullable(), checkedAt: Iso.nullable() }),
  probe: z.object({ status: DomainProbeStatus, detail: z.string().nullable(), checkedAt: Iso.nullable() }),
  tls: z.object({ status: TlsStatus, issuer: z.string().nullable(), expiresAt: Iso.nullable(), detail: z.string().nullable() }),
  /** Why the last switch stopped; the old address kept working. */
  error: z.string().nullable(),
  /** The record Dockify made for this domain, so a cancel can offer to remove it. */
  cfRecord: z.object({ zoneId: z.string(), recordId: z.string() }).nullable(),
  /**
   * On a managed Cloudflare zone with no record yet, no lookup runs until Dockify has made the record, so no
   * resolver caches the name as missing first.
   */
  recordFirst: z.boolean().optional(),
});
export const DashboardLastChange = z.object({
  from: z.string(),
  to: z.string(),
  at: Iso,
  /** The GitHub App's webhook URL followed the change, could not, or there is no App. */
  webhook: z.enum(["updated", "failed", "none"]),
  webhookError: z.string().nullable(),
});
/** What the owner has to change on GitHub by hand: the API has no way to set the first three. */
export const DashboardGitHubSteps = z.object({
  slug: z.string(),
  settingsUrl: z.string(),
  homepageUrl: z.string(),
  callbackUrl: z.string(),
  setupUrl: z.string(),
  webhookUrl: z.string(),
});
export const DashboardDomainState = z.object({
  url: z.string(),
  host: z.string(),
  ingress: IngressMode,
  server: z.object({ ipv4: z.string().nullable(), ipv6: z.string().nullable(), tunnelTarget: z.string().nullable() }),
  /** Earlier addresses that still answer and redirect here. */
  previousHosts: z.array(z.string()),
  /** Those of them with a Cloudflare record Dockify made, which Stop answering removes. */
  previousRecords: z.array(z.string()),
  pending: PendingDashboardDomain.nullable(),
  /** Tunnel mode changes the tunnel's rules through Cloudflare's API, so it needs Cloudflare connected. */
  cloudflareConnected: z.boolean(),
  /** What Cloudflare says about the pending domain; null when it is not connected or nothing is pending. */
  cloudflare: CfHostState.nullable(),
  github: DashboardGitHubSteps.nullable(),
  lastChange: DashboardLastChange.nullable(),
});
export const DashboardDomainBody = z.strictObject({ hostname: Hostname });
export const DashboardPreviousParams = z.strictObject({ host: Hostname });

/** instance.dashboardCfRecords: the Cloudflare record Dockify made for each dashboard address, by host. */
export const DashboardCfRecords = z.record(z.string(), z.object({ zoneId: z.string(), recordId: z.string() }));
export type DashboardCfRecords = z.infer<typeof DashboardCfRecords>;
export function readCfRecords(raw: unknown): DashboardCfRecords {
  const r = DashboardCfRecords.safeParse(raw);
  return r.success ? r.data : {};
}

export type PendingDomain = z.infer<typeof PendingDashboardDomain>;
export type LastChange = z.infer<typeof DashboardLastChange>;
export type HostState = z.infer<typeof CfHostState>;

/** Stands in for a domain row's id in the check token of the dashboard's pending domain. */
export const DASHBOARD_CHECK_ID = "dashboard-domain";

export function freshPendingDomain(host: string, requestedBy: string | null, now: Date): PendingDomain {
  return {
    host,
    phase: "waiting",
    requestedAt: now.toISOString(),
    requestedBy,
    dns: { status: "unchecked", resolved: [], detail: null, checkedAt: null },
    probe: { status: "untried", detail: null, checkedAt: null },
    tls: { status: "pending", issuer: null, expiresAt: null, detail: null },
    error: null,
    cfRecord: null,
  };
}

/** The stored value when it still reads, else null: a row an older version wrote never breaks a page. */
export function readPendingDomain(raw: unknown): PendingDomain | null {
  const r = PendingDashboardDomain.safeParse(raw);
  return r.success ? r.data : null;
}
export function readLastChange(raw: unknown): LastChange | null {
  const r = DashboardLastChange.safeParse(raw);
  return r.success ? r.data : null;
}

/** A name sslip.io or nip.io answers with the address it spells: 203-0-113-4.sslip.io is 203.0.113.4. */
const IP_HOST = /^\d{1,3}(?:-\d{1,3}){3}\.(?:sslip|nip)\.io$/;
