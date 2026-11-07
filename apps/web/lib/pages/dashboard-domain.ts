import "server-only";
import { previewDomainsForCloudflare } from "@/lib/pages/resources-domains";
import { previewElevated } from "@/lib/preview-step-up";
import { STEP_UP_MESSAGE, STEP_UP_REQUIRED } from "@/lib/step-up";
import type { CfDomains, CfHostState, CfLookup, DashboardDomain, PendingDomain } from "@/lib/dashboard-domain";
import { json, refuse } from "@/lib/http";
import { PREVIEW_ZONES } from "./integrations";

/*
 * The design preview's answers for the dashboard's address and for hostnames on Cloudflare. Nothing is
 * real and nothing reaches Cloudflare: a small state machine in this process walks the same steps the
 * API does, so every screen of the flow can be seen. Only behind DOCKIFY_PREVIEW (the route handlers
 * ask), and server only, so no fixture reaches a client bundle.
 */

const IPV4 = "203.0.113.24";
const IPV6 = "2001:db8::24";
const CURRENT = "203-0-113-24.sslip.io";

const ID = (c: string) => c.repeat(32);

type Stored = { pending: PendingDomain | null; previous: string[]; records: Map<string, CfHostState["records"]>; url: string };
const slot = globalThis as unknown as { __dockifyPreviewDomain?: Stored };
const store = (): Stored => (slot.__dockifyPreviewDomain ??= { pending: null, previous: [], records: new Map(), url: `https://${CURRENT}` });

const zoneOf = (host: string) => {
  let best: (typeof PREVIEW_ZONES)[number] | null = null;
  for (const z of PREVIEW_ZONES) if ((host === z.name || host.endsWith(`.${z.name}`)) && z.name.length > (best?.name.length ?? 0)) best = z;
  return best;
};

/** What the preview's Cloudflare says about a hostname, shaped like the API's readHost. */
function hostState(host: string, certActive: boolean): CfHostState {
  const expected = { type: "A", content: IPV4, proxied: null };
  const base: CfHostState = { hostname: host, zone: null, managed: false, records: [], expected, correct: false, sslMode: null, alwaysUseHttps: null, findings: [] };
  const zone = zoneOf(host);
  if (!zone) return { ...base, findings: [{ code: "no_zone", tone: "info", text: `${host} is not on a zone this Cloudflare token can see.` }] };
  const z = { id: zone.id, name: zone.name, status: "active" as const };
  if (!zone.managed) return { ...base, zone: z, findings: [{ code: "not_managed", tone: "info", text: `Dockify does not manage ${zone.name}. Turn it on in Settings, Integrations, Cloudflare to see and change its records here.` }] };
  const records = store().records.get(host) ?? [];
  const findings: CfHostState["findings"] = [];
  if (!records.length) findings.push({ code: "no_record", tone: "warn", text: `${host} has no record on Cloudflare.` });
  const sslMode = zone.name === "brightlane.example" ? ("strict" as const) : ("full" as const);
  if (records.some((r) => r.proxied) && sslMode === "strict" && !certActive) {
    findings.push({ code: "ssl_strict_no_cert", tone: "bad", text: "SSL/TLS is Full (strict) and this server has no certificate for the name yet, so Cloudflare answers 526. Set it to Full until the certificate is active." });
  }
  for (const r of records) {
    if (r.content !== IPV4) findings.push({ code: "wrong_target", tone: "bad", text: `The ${r.type} record names ${r.content}, not this server (${IPV4}).` });
  }
  return { ...base, zone: z, managed: true, records, correct: records.length > 0 && records.every((r) => r.content === IPV4), sslMode, alwaysUseHttps: false, findings };
}

function seedRecords() {
  const s = store();
  if (s.records.size) return;
  const a = (id: string, name: string, content: string, proxied: boolean, ours: boolean) => ({ id: ID(id), type: "A", name, content, proxied, ours });
  s.records.set("horseai.example", [a("a", "horseai.example", IPV4, true, true)]);
  s.records.set("www.horseai.example", [a("b", "www.horseai.example", IPV4, true, true)]);
  s.records.set("api.horseai.example", [a("c", "api.horseai.example", IPV4, false, false)]);
  s.records.set("admin.horseai.example", [a("d", "admin.horseai.example", "198.51.100.40", false, false)]);
  s.records.set("inkwell.example", [a("e", "inkwell.example", IPV4, false, true)]);
  s.records.set("www.brightlane.example", [a("f", "www.brightlane.example", IPV4, true, true)]);
}

/** Every domain's state, for GET /api/domains/cloudflare. */
export function previewCfDomains(): Response {
  seedRecords();
  const domains = previewDomainsForCloudflare();
  // A domain that points here has a record: the fixture's few special ones above, a plain one otherwise.
  const s = store();
  for (const d of domains) {
    if (d.dns.status === "ok" && zoneOf(d.hostname)?.managed && !s.records.has(d.hostname)) s.records.set(d.hostname, [{ id: ID("7"), type: "A", name: d.hostname, content: IPV4, proxied: false, ours: false }]);
  }
  const items = domains.map((d) => ({ domainId: d.id, state: hostState(d.hostname, d.tls.status === "active") }));
  const body: CfDomains = { connected: true, items, error: null };
  return json(body);
}

export function previewCfLookup(hostname: string): Response {
  seedRecords();
  const body: CfLookup = { connected: true, state: hostState(hostname, false), error: null };
  return json(body);
}

/** Refuses a preview write without its step-up, as the API would. */
const needsStepUp = () => (previewElevated() ? null : refuse(403, STEP_UP_MESSAGE, { code: STEP_UP_REQUIRED }));

/** The same rules putRecord applies: no overwrite without the exact ids. */
function putPreviewRecord(host: string, body: { proxied?: boolean; replace?: string[] }): Response | null {
  const zone = zoneOf(host);
  if (!zone?.managed) return refuse(409, `Dockify does not manage ${zone?.name ?? host}. Turn it on in Settings, Integrations, Cloudflare`, { code: "ZONE_NOT_MANAGED" });
  const s = store();
  const there = s.records.get(host) ?? [];
  const replace = body.replace ?? [];
  if (there.length && !replace.length) return refuse(409, `${host} already has a ${there[0]!.type} record on Cloudflare. Dockify left it alone`, { code: "RECORD_EXISTS" });
  s.records.set(host, [{ id: ID("9"), type: "A", name: host, content: IPV4, proxied: body.proxied === true, ours: true }]);
  return null;
}

export function previewCfRecord(hostname: string, body: { proxied?: boolean; replace?: string[] }): Response {
  seedRecords();
  const denied = needsStepUp() ?? putPreviewRecord(hostname, body);
  return denied ?? json({ state: hostState(hostname, false) });
}

const fresh = (host: string): PendingDomain => ({
  host,
  phase: "waiting",
  requestedAt: new Date().toISOString(),
  requestedBy: "Sam",
  dns: { status: "missing", resolved: [], detail: `No A or AAAA record for ${host} yet.`, checkedAt: new Date().toISOString() },
  probe: { status: "untried", detail: null, checkedAt: null },
  tls: { status: "pending", issuer: null, expiresAt: null, detail: null },
  error: null,
  cfRecord: null,
});

function state(): DashboardDomain {
  const s = store();
  const host = new URL(s.url).hostname;
  const github = { slug: "dockify-preview", settingsUrl: "https://github.com/settings/apps/dockify-preview" };
  const origin = s.pending ? `https://${s.pending.host}` : s.url;
  return {
    url: s.url,
    host,
    ingress: "direct_tls",
    server: { ipv4: IPV4, ipv6: IPV6, tunnelTarget: null },
    previousHosts: s.previous,
    previousRecords: [],
    pending: s.pending,
    cloudflareConnected: true,
    cloudflare: s.pending ? hostState(s.pending.host, s.pending.tls.status === "active") : null,
    github: { ...github, homepageUrl: origin, callbackUrl: `${origin}/api/v1/git/app/callback`, setupUrl: `${origin}/api/v1/git/setup`, webhookUrl: `${origin}/api/v1/webhooks/github` },
    lastChange: s.previous[0] ? { from: s.previous[0], to: host, at: new Date().toISOString(), webhook: "updated", webhookError: null } : null,
  };
}

/** One step of the preview's flow. `path` is what follows /api/settings/domain. */
export function previewDashboardDomain(method: string, path: string[], body: Record<string, unknown>): Response {
  seedRecords();
  const s = store();
  const [leaf, arg] = path;
  if (method === "GET" && !leaf) return json(state());
  if (method === "POST" && !leaf) {
    const denied = needsStepUp();
    if (denied) return denied;
    s.pending = fresh(String(body.hostname ?? ""));
    return json(state());
  }
  if (method === "DELETE" && !leaf) {
    s.pending = null;
    return json(state());
  }
  if (method === "POST" && leaf === "record") {
    const denied = needsStepUp() ?? (s.pending ? putPreviewRecord(s.pending.host, body) : refuse(409, "No new domain is being set up"));
    if (denied) return denied;
    if (s.pending) s.pending.cfRecord = { zoneId: ID("a"), recordId: ID("9") };
    return json(state());
  }
  if (method === "POST" && leaf === "check") {
    if (!s.pending) return refuse(409, "No new domain is being set up", { code: "NOT_PENDING" });
    const at = new Date().toISOString();
    const has = (s.records.get(s.pending.host) ?? []).length > 0 || !zoneOf(s.pending.host)?.managed;
    s.pending = has
      ? {
          ...s.pending,
          phase: "ready",
          dns: { status: "ok", resolved: [IPV4], detail: null, checkedAt: at },
          tls: { status: "active", issuer: "Let's Encrypt", expiresAt: new Date(Date.now() + 89 * 86_400_000).toISOString(), detail: null },
        }
      : { ...s.pending, dns: { ...s.pending.dns, checkedAt: at } };
    return json(state());
  }
  if (method === "POST" && leaf === "switch") {
    const denied = needsStepUp();
    if (denied) return denied;
    if (s.pending?.phase !== "ready") return refuse(409, `${s.pending?.host ?? "The domain"} has to answer and have its certificate before the dashboard can move to it`, { code: "NOT_READY" });
    s.previous = [new URL(s.url).hostname, ...s.previous].slice(0, 3);
    s.url = `https://${s.pending.host}`;
    s.pending = null;
    return json(state());
  }
  if (method === "DELETE" && leaf === "previous" && arg) {
    const denied = needsStepUp();
    if (denied) return denied;
    s.previous = s.previous.filter((h) => h !== arg);
    return json(state());
  }
  return refuse(404, "Not found");
}
