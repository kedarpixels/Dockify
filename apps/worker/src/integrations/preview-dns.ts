/**
 * The preview_dns job for one preview domain (instance-wide or a project's override):
 *
 *   wanted     some project with previews on uses it: with Cloudflare connected, Dockify creates
 *              ONE wildcard record *.<domain> (and the tunnel rule in tunnel mode), recorded by id
 *   unwanted   nobody uses it any more: only what Dockify recorded is deleted
 *   check      then *.<domain> is resolved through public DNS (a fixed label under the wildcard)
 *              and judged like a custom domain; previews refuse to start until it says ok
 *
 * Nothing here calls any Dockify-run service: Cloudflare (when connected) and public resolvers only.
 */
import { projects as P } from "@dockify/contracts";
import type { Db, SecretVault } from "@dockify/db";
import { cfClient, unwireWildcard, wireWildcard, type Fetch } from "../edge/cloudflare.ts";
import { checkDns, type DnsLookup } from "../edge/dns.ts";
import { reservedHosts } from "../edge/hostnames.ts";
import type { EdgeSettings } from "../edge/ingress.ts";
import { loadCloudflare, tunnelLock } from "../edge/integration.ts";

/** The label the check resolves; any name under the wildcard proves it. */
export const CHECK_LABEL = "dockify-dns-check";

export interface PreviewDnsDeps {
  db: Db;
  vault: SecretVault;
  settings: EdgeSettings;
  dns: DnsLookup;
  fetch?: Fetch;
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Every preview domain some project with previews on uses right now. */
export async function wantedPreviewDomains(db: Db): Promise<Set<string>> {
  const inst = await db.instance.findUnique({ where: { id: 1 }, select: { previewDomain: true, publicUrl: true } });
  const projects = await db.project.findMany({ where: { previewEnabled: true, archivedAt: null }, select: { previewDomain: true } });
  const out = new Set<string>();
  for (const p of projects) {
    const d = P.effectivePreviewDomain(p.previewDomain, inst?.previewDomain ?? null, inst?.publicUrl ?? "").domain;
    if (d) out.add(d);
  }
  return out;
}

export async function runPreviewDns(deps: PreviewDnsDeps, payload: unknown): Promise<void> {
  const raw = (payload as { domain?: unknown } | null)?.domain;
  if (typeof raw !== "string" || !DOMAIN.test(raw.toLowerCase())) return;
  const domain = raw.toLowerCase();
  const { db, settings } = deps;
  const wanted = (await wantedPreviewDomains(db)).has(domain);
  const row = await db.previewDomain.upsert({ where: { domain }, create: { domain }, update: {} });
  const tunnel = settings.mode.ingress === "cloudflare_tunnel";

  const loaded = await loadCloudflare(db, deps.vault);
  if (loaded.ok) {
    const cf = cfClient(loaded.conn.token, deps.fetch);
    if (!wanted && row.cfState === "managed" && row.cfZoneId && row.cfRecordId) {
      const out = await unwireWildcard({ cf, accountId: loaded.conn.accountId, domain, zoneId: row.cfZoneId, recordId: row.cfRecordId, tunnelId: row.cfTunnelId, withTunnelLock: tunnelLock(db) });
      await db.previewDomain.update({ where: { domain }, data: { cfState: "none", cfMessage: out.message, cfZoneId: null, cfRecordId: null, cfTunnelId: null } });
      return;
    }
    if (wanted && row.cfState !== "managed") {
      const out = await wireWildcard({
        cf, accountId: loaded.conn.accountId, tunnelId: tunnel ? loaded.conn.tunnelId : null, serverIpv4: settings.serverIpv4, domain,
        reserved: reservedHosts(settings.dashboardHost), managedZoneIds: loaded.conn.managedZoneIds, withTunnelLock: tunnelLock(db),
      });
      await db.previewDomain.update({
        where: { domain },
        data: out.state === "managed"
          ? { cfState: "managed", cfMessage: out.message, cfZoneId: out.zoneId, cfRecordId: out.recordId, cfTunnelId: out.tunnelId || null }
          : { cfState: out.state, cfMessage: out.message },
      });
    }
  } else if (wanted) {
    await db.previewDomain.update({ where: { domain }, data: { cfState: "none", cfMessage: loaded.reason } });
  }
  if (!wanted) return;

  const r = await checkDns(deps.dns, `${CHECK_LABEL}.${domain}`, settings.mode.ingress, settings.serverIpv4);
  await db.previewDomain.update({
    where: { domain },
    data: { dnsStatus: r.status, dnsDetail: r.detail, dnsResolved: r.resolved.slice(0, 10), checkedAt: new Date() },
  });
}

/** Domains the reconcile should look at again: wanted ones not checked lately, and unwanted ones Dockify still holds a record for. */
export async function staleDnsDomains(db: Db, now = Date.now(), everyMs = 30 * 60_000): Promise<string[]> {
  const wanted = await wantedPreviewDomains(db);
  const rows = await db.previewDomain.findMany({ select: { domain: true, checkedAt: true, dnsStatus: true, cfState: true } });
  const byDomain = new Map(rows.map((r) => [r.domain, r]));
  const out: string[] = [];
  for (const d of wanted) {
    const r = byDomain.get(d);
    if (!r || !r.checkedAt || (r.dnsStatus !== "ok" && now - r.checkedAt.getTime() > 5 * 60_000) || now - r.checkedAt.getTime() > everyMs) out.push(d);
  }
  for (const r of rows) if (!wanted.has(r.domain) && r.cfState === "managed") out.push(r.domain);
  return out;
}
