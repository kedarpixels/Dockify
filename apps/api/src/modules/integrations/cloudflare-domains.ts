/**
 * Cloudflare's view of a hostname, and the one record Dockify may write for it. Only zones the owner opted in
 * (managedZoneIds) are read or written. An existing record is removed only with an explicit go-ahead naming its id.
 */
import type { dashboardDomain as D } from "@dockify/contracts";
import { HttpError } from "../../errors.ts";
import { audit } from "../../audit.ts";
import { enqueueEdge } from "../domains/handlers.ts";
import type { Ctx, Handlers } from "../../app.ts";
import { requireActor, who, type IntegrationDeps } from "./deps.ts";
import { cloudflareApiFor, managedZoneIds, type CloudflareApi } from "./cloudflare.ts";
import { findIntegration } from "./store.ts";

type HostState = D.HostState;
type Finding = HostState["findings"][number];
type SslMode = NonNullable<HostState["sslMode"]>;

interface ApiZone { id: string; name: string; status: string }
interface ApiRecord { id: string; type: string; name: string; content: string; proxied?: boolean }

export interface ServerTarget {
  ingress: "cloudflare_tunnel" | "direct_tls";
  ipv4: string | null;
  ipv6: string | null;
  tunnelTarget: string | null;
}

export const serverTarget = (c: Ctx["config"]): ServerTarget => ({ ingress: c.ingress, ipv4: c.serverIpv4, ipv6: c.serverIpv6 ?? null, tunnelTarget: c.tunnelTarget });

/**
 * A proxied CNAME to the tunnel, or an A record to this server (AAAA only when no IPv4 address is known).
 * One record is enough: Cloudflare's proxy answers on both families, and IPv4 reaches every client.
 */
export function expectedRecord(t: ServerTarget): HostState["expected"] {
  if (t.ingress === "cloudflare_tunnel") return t.tunnelTarget ? { type: "CNAME", content: t.tunnelTarget, proxied: true } : null;
  if (t.ipv4) return { type: "A", content: t.ipv4, proxied: null };
  return t.ipv6 ? { type: "AAAA", content: t.ipv6, proxied: null } : null;
}

const bare = (s: string) => s.toLowerCase().replace(/\.$/, "");
const canon = (ip: string) => {
  if (!ip.includes(":")) return ip;
  try {
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return ip.toLowerCase();
  }
};

export interface Judgement {
  host: string;
  target: ServerTarget;
  records: HostState["records"];
  /** The zone's nameservers are not on Cloudflare yet. */
  zonePending: boolean;
  sslMode: SslMode | null;
  sslDenied: boolean;
  alwaysUseHttps: boolean | null;
  /** This server holds a certificate for the name. */
  certActive: boolean;
  /** The last DNS check says the name leads here. */
  dnsOk: boolean;
}

/**
 * Pure. Findings are shown to the owner as written. Behind a tunnel the SSL/TLS mode plays no part; in direct mode a
 * proxied record breaks on Flexible or Off (redirect loop) and on Full (strict) until this server holds a real
 * certificate (526). Always Use HTTPS redirects the ACME http challenge, which can hold the first certificate back.
 */
export function judgeHost(j: Judgement): { correct: boolean; findings: Finding[] } {
  const findings: Finding[] = [];
  const add = (code: Finding["code"], tone: Finding["tone"], text: string) => findings.push({ code, tone, text });
  const tunnel = j.target.ingress === "cloudflare_tunnel";
  const exp = expectedRecord(j.target);
  if (j.zonePending) add("zone_pending", "warn", "This zone's nameservers are not on Cloudflare yet, so its records are not public.");
  if (!j.records.length) {
    add("no_record", "warn", `${j.host} has no record on Cloudflare.`);
  }
  const mine = new Set([j.target.ipv4, j.target.ipv6].filter((a): a is string => !!a).map(canon));
  let correct = j.records.length > 0;
  for (const r of j.records) {
    if (tunnel) {
      if (r.type !== "CNAME" || !exp || bare(r.content) !== bare(exp.content)) {
        correct = false;
        add("wrong_target", "bad", `The ${r.type} record names ${r.content}. In tunnel mode it has to be a CNAME to ${exp?.content ?? "the tunnel"}.`);
      } else if (!r.proxied) {
        correct = false;
        add("needs_proxy", "bad", "The record is DNS only. A tunnel only answers through Cloudflare's proxy, so turn the proxy on.");
      }
    } else if (r.type === "CNAME") {
      // A CNAME may well lead here by way of another name: the DNS check has followed it.
      if (!j.dnsOk) {
        correct = false;
        add("wrong_target", "warn", `The CNAME names ${r.content}, which does not lead to this server.`);
      }
    } else if (!mine.has(canon(r.content))) {
      correct = false;
      add("wrong_target", "bad", `The ${r.type} record names ${r.content}, not this server${exp ? ` (${exp.content})` : ""}.`);
    }
  }
  if (!tunnel && j.records.some((r) => r.proxied)) {
    if (j.sslMode === "flexible") add("ssl_flexible", "bad", "SSL/TLS is Flexible: Cloudflare talks http to this server, which redirects to https, so every visitor loops. Set it to Full.");
    if (j.sslMode === "off") add("ssl_off", "bad", "SSL/TLS is Off: Cloudflare talks http to this server, which redirects to https, so every visitor loops. Set it to Full.");
    if (j.sslMode === "strict" && !j.certActive) add("ssl_strict_no_cert", "bad", "SSL/TLS is Full (strict) and this server has no certificate for the name yet, so Cloudflare answers 526. Set it to Full until the certificate is active.");
    if (j.alwaysUseHttps && !j.certActive) add("always_https", "warn", "Always Use HTTPS is on. It can keep Let's Encrypt from reaching this server for the first certificate; if it stays pending, turn it off until the certificate is active.");
    if (j.sslDenied) add("ssl_denied", "info", "This token cannot read the zone's SSL/TLS setting, so Dockify cannot warn about it. Give it Zone, Zone Settings, Read.");
  }
  return { correct, findings };
}

/** The longest zone name the host ends in. */
export function zoneFor<Z extends { name: string }>(zones: readonly Z[], host: string): Z | null {
  let best: Z | null = null;
  for (const z of zones) {
    if ((host === z.name || host.endsWith(`.${z.name}`)) && z.name.length > (best?.name.length ?? 0)) best = z;
  }
  return best;
}

const denied = (e: unknown) => e instanceof HttpError && e.code === "CLOUDFLARE_TOKEN";

/** Read once per request, however many hostnames share the zone. */
interface ZoneSettings { sslMode: SslMode | null; alwaysUseHttps: boolean | null; sslDenied: boolean }
const SSL_MODES = new Set<string>(["off", "flexible", "full", "strict"]);

async function readZoneSettings(api: CloudflareApi, zoneId: string): Promise<ZoneSettings> {
  const enc = encodeURIComponent(zoneId);
  try {
    const ssl = await api.call<{ value?: string }>(`/zones/${enc}/settings/ssl`);
    const always = await api.call<{ value?: string }>(`/zones/${enc}/settings/always_use_https`).catch(() => null);
    const value = ssl.result.value ?? "";
    return { sslMode: SSL_MODES.has(value) ? (value as SslMode) : null, alwaysUseHttps: always ? always.result.value === "on" : null, sslDenied: false };
  } catch (e) {
    if (denied(e)) return { sslMode: null, alwaysUseHttps: null, sslDenied: true };
    return { sslMode: null, alwaysUseHttps: null, sslDenied: false };
  }
}

export interface HostReadContext {
  api: CloudflareApi;
  zones: readonly ApiZone[];
  managed: ReadonlySet<string>;
  target: ServerTarget;
  /** Per-request cache of each zone's settings. */
  settings: Map<string, Promise<ZoneSettings>>;
}

async function recordsAt(api: CloudflareApi, zoneId: string, host: string): Promise<ApiRecord[]> {
  const r = await api.call<ApiRecord[]>(`/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(host)}&per_page=50`);
  // TXT, MX and the like at the same name never get in the way, and are never touched.
  return r.result.filter((x) => bare(x.name) === host && (x.type === "A" || x.type === "AAAA" || x.type === "CNAME"));
}

/** A refused or failed read becomes a finding, never a thrown error. */
export async function readHost(c: HostReadContext, host: string, o: { ownRecordId: string | null; certActive: boolean; dnsOk: boolean }): Promise<HostState> {
  const base: HostState = { hostname: host, zone: null, managed: false, records: [], expected: expectedRecord(c.target), correct: false, sslMode: null, alwaysUseHttps: null, findings: [] };
  const zone = zoneFor(c.zones, host);
  if (!zone) {
    return { ...base, findings: [{ code: "no_zone", tone: "info", text: `${host} is not on a zone this Cloudflare token can see.` }] };
  }
  const z = { id: zone.id, name: zone.name, status: zone.status === "active" ? ("active" as const) : ("pending" as const) };
  if (!c.managed.has(zone.id)) {
    return { ...base, zone: z, findings: [{ code: "not_managed", tone: "info", text: `Dockify does not manage ${zone.name}. Turn it on in Settings, Integrations, Cloudflare to see and change its records here.` }] };
  }
  let found: ApiRecord[];
  try {
    found = await recordsAt(c.api, zone.id, host);
  } catch (e) {
    const text = denied(e) ? `This token cannot read DNS in ${zone.name}. Give it Zone, DNS, Read, or Edit to let Dockify create records.` : `Cloudflare did not answer for ${host}.`;
    return { ...base, zone: z, managed: true, findings: [{ code: "dns_denied", tone: denied(e) ? "bad" : "warn", text }] };
  }
  let pending = c.settings.get(zone.id);
  if (!pending) {
    pending = readZoneSettings(c.api, zone.id);
    c.settings.set(zone.id, pending);
  }
  const s = await pending;
  const records = found.map((r) => ({ id: r.id, type: r.type, name: bare(r.name), content: r.content, proxied: r.proxied === true, ours: r.id === o.ownRecordId }));
  const j = judgeHost({ host, target: c.target, records, zonePending: z.status === "pending", sslMode: s.sslMode, sslDenied: s.sslDenied, alwaysUseHttps: s.alwaysUseHttps, certActive: o.certActive, dnsOk: o.dnsOk });
  return { ...base, zone: z, managed: true, records, sslMode: s.sslMode, alwaysUseHttps: s.alwaysUseHttps, ...j };
}

/** Null when Cloudflare is not connected. Throws only for the zone list. */
export async function hostReadContext(ctx: Ctx, deps: IntegrationDeps): Promise<HostReadContext | null> {
  const row = await findIntegration(ctx.db, "cloudflare");
  if (!row || row.status === "disconnected") return null;
  const { api } = await cloudflareApiFor(ctx.db, ctx.ring, deps.http);
  const zones = await api.zones();
  return { api, zones, managed: new Set(await managedZoneIds(ctx.db)), target: serverTarget(ctx.config), settings: new Map() };
}

const reasonOf = (e: unknown) => (denied(e) ? "Cloudflare refused this token. Connect it again with a new one in Settings, Integrations." : "Cloudflare did not answer. Try again in a moment.");

/** A few at a time, so a page full of domains never bursts into Cloudflare's rate limit. */
async function mapLimit<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}

export interface PutRecord {
  api: CloudflareApi;
  zones: readonly ApiZone[];
  managed: ReadonlySet<string>;
  target: ServerTarget;
  host: string;
  proxied: boolean;
  /** The ids the owner agreed to remove. Anything else on Cloudflare stops the write. */
  replace: readonly string[];
}

/**
 * Stops when records already sit at the name unless `replace` names exactly those. A create that fails after a
 * removal puts the removed records back. recordId is null when the record was already right and left alone.
 */
export async function putRecord(p: PutRecord): Promise<{ zoneId: string; recordId: string | null; removed: ApiRecord[]; created: boolean }> {
  const zone = zoneFor(p.zones, p.host);
  if (!zone) throw new HttpError(409, `${p.host} is not on a zone this Cloudflare token can see`, "CLOUDFLARE_NO_ZONE");
  if (!p.managed.has(zone.id)) throw new HttpError(409, `Dockify does not manage ${zone.name}. Turn it on in Settings, Integrations, Cloudflare`, "ZONE_NOT_MANAGED");
  const exp = expectedRecord(p.target);
  if (!exp) throw new HttpError(409, "This server's address is not known, so Dockify cannot say what the record should be", "SERVER_ADDRESS_UNKNOWN");
  const proxied = exp.proxied ?? p.proxied;
  const path = `/zones/${encodeURIComponent(zone.id)}/dns_records`;
  const there = await recordsAt(p.api, zone.id, p.host);
  if (there.length === 1 && there[0]!.type === exp.type && bare(there[0]!.content) === bare(exp.content) && (there[0]!.proxied === true) === proxied) {
    return { zoneId: zone.id, recordId: p.replace.includes(there[0]!.id) ? there[0]!.id : null, removed: [], created: false };
  }
  const ids = new Set(there.map((r) => r.id));
  if (there.length && !p.replace.length) {
    throw new HttpError(409, `${p.host} already has a ${there[0]!.type} record on Cloudflare. Dockify left it alone`, "RECORD_EXISTS");
  }
  if (p.replace.length !== ids.size || p.replace.some((id) => !ids.has(id))) {
    throw new HttpError(409, `The records for ${p.host} changed on Cloudflare since this page read them. Nothing was changed`, "RECORD_CHANGED");
  }
  for (const r of there) await p.api.send("DELETE", `${path}/${encodeURIComponent(r.id)}`);
  const body = { type: exp.type, name: p.host, content: exp.content, ttl: 1, proxied, comment: "Managed by Dockify" };
  try {
    const made = await p.api.send<{ id: string }>("POST", path, body);
    return { zoneId: zone.id, recordId: made.id, removed: there, created: true };
  } catch (e) {
    for (const r of there) {
      await p.api.send("POST", path, { type: r.type, name: r.name, content: r.content, ttl: 1, proxied: r.proxied === true }).catch(() => undefined);
    }
    throw e;
  }
}

export function cloudflareDomainHandlers(deps: IntegrationDeps): Handlers {
  return {
    "integrations.cloudflare.domains": async ({ ctx }) => {
      let c: HostReadContext | null;
      try {
        c = await hostReadContext(ctx, deps);
      } catch (e) {
        return { connected: true, items: [], error: reasonOf(e) };
      }
      if (!c) return { connected: false, items: [], error: null };
      const rows = await ctx.db.domain.findMany({ orderBy: { hostname: "asc" }, take: 2000, select: { id: true, hostname: true, cfRecordId: true, tlsStatus: true, dnsStatus: true } });
      const read = c;
      const items = await mapLimit(rows, 4, async (d) => ({
        domainId: d.id,
        state: await readHost(read, d.hostname, { ownRecordId: d.cfRecordId, certActive: d.tlsStatus === "active", dnsOk: d.dnsStatus === "ok" }),
      }));
      return { connected: true, items, error: null };
    },

    /** For a hostname not added yet: the add-domain dialog's second step. */
    "integrations.cloudflare.lookup": async ({ query, ctx }) => {
      try {
        const c = await hostReadContext(ctx, deps);
        if (!c) return { connected: false, state: null, error: null };
        return { connected: true, state: await readHost(c, query.hostname, { ownRecordId: null, certActive: false, dnsOk: false }), error: null };
      } catch (e) {
        return { connected: true, state: null, error: reasonOf(e) };
      }
    },

    "integrations.cloudflare.record": async ({ params, body, actor, req, ctx }) => {
      const a = requireActor(actor);
      const d = await ctx.db.domain.findUnique({ where: { id: params.id }, select: { id: true, hostname: true, cfRecordId: true, tlsStatus: true, dnsStatus: true } });
      if (!d) throw new HttpError(404, "Domain not found", "NOT_FOUND");
      const c = await hostReadContext(ctx, deps);
      if (!c) throw new HttpError(409, "Cloudflare is not connected", "NOT_CONNECTED");
      const out = await putRecord({ api: c.api, zones: c.zones, managed: c.managed, target: c.target, host: d.hostname, proxied: body.proxied ?? false, replace: body.replace ?? [] });
      const recordId = out.recordId ?? d.cfRecordId;
      await ctx.db.$transaction(async (tx) => {
        if (out.recordId) await tx.domain.update({ where: { id: d.id }, data: { cfZoneId: out.zoneId, cfRecordId: out.recordId, cfState: "managed", cfMessage: null } });
        await enqueueEdge(tx, { kind: "dns_check", payload: { domainId: d.id }, dedupeKey: `edge.dns.now:${d.id}` });
        await audit(tx, {
          category: "config",
          action: out.removed.length ? "domain.cloudflare.replace" : "domain.cloudflare.create",
          verb: out.removed.length ? "replaced the Cloudflare record for" : "created a Cloudflare record for",
          targetType: "domain",
          targetId: d.id,
          targetLabel: d.hostname,
          suffix: out.removed.length ? `, removing ${out.removed.map((r) => `${r.type} ${r.content}`).join(", ")}`.slice(0, 300) : null,
          ...who(a, req),
        });
      });
      return { state: await readHost(c, d.hostname, { ownRecordId: recordId, certActive: d.tlsStatus === "active", dnsOk: d.dnsStatus === "ok" }) };
    },
  };
}
