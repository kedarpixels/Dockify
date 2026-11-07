import type { Domain } from "@dockify/db";

/**
 * Pure pieces of the domains module, kept apart from the handlers so they test without a database.
 */

export const ROUTABLE_KINDS = new Set(["frontend", "backend"]);

/** Lowercase, no trailing dot. The contracts Hostname schema already lowercases and trims. */
export const normalizeHost = (h: string): string => h.trim().toLowerCase().replace(/\.$/, "");

/**
 * The dashboard hostname, and any extra hosts the operator lists in DOCKIFY_RESERVED_HOSTS, can
 * never be a tenant domain: a tenant route or tunnel rule for it would hand the owner's session
 * cookie and step-up password to a tenant container.
 */
export function reservedHosts(publicUrl: URL, extra = ""): Set<string> {
  const out = new Set<string>([normalizeHost(publicUrl.hostname)]);
  for (const h of extra.split(",")) {
    const n = normalizeHost(h);
    if (n) out.add(n);
  }
  return out;
}

export const isReserved = (host: string, reserved: Set<string>): boolean => reserved.has(normalizeHost(host));

/** What a domain row looks like on the wire (contracts DomainRow). */
export type DomainWithApp = Omit<Domain, "testDomain"> & {
  testDomain?: boolean;
  app: { id: string; name: string; port?: number | null; environment: { name: string; project: { slug: string } } };
};

export function toDomainRow(d: DomainWithApp) {
  // appPort: the route's other half. A domain's DNS can read ok with no route at all when this is null.
  return {
    id: d.id,
    hostname: d.hostname,
    appId: d.app.id,
    appName: d.app.name,
    projectSlug: d.app.environment.project.slug,
    environment: d.app.environment.name,
    tls: { status: d.tlsStatus, issuer: d.tlsIssuer, expiresAt: d.tlsExpiresAt?.toISOString() ?? null },
    dns: { status: d.dnsStatus, resolved: d.dnsResolved, checkedAt: d.dnsCheckedAt?.toISOString() ?? null, detail: d.dnsStatus === "ok" ? null : d.dnsDetail },
    probe: { status: d.probeStatus, detail: d.probeDetail, checkedAt: d.probeCheckedAt?.toISOString() ?? null },
    cloudflare: { state: d.cfState, message: d.cfMessage },
    test: d.testDomain === true,
    appPort: d.app.port ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}

/** The edge jobs a domain change asks the worker for. */
export type EdgeJob =
  | { kind: "edge_route_sync"; payload: { appId: string }; dedupeKey: string }
  | { kind: "edge_cf_wire"; payload: { domainId: string }; dedupeKey: string }
  | { kind: "edge_cf_unwire"; payload: { hostname: string; zoneId: string; recordId: string; tunnelId: null }; dedupeKey: string }
  | { kind: "dns_check"; payload: { domainId: string }; dedupeKey: string; runAfterMs?: number };

/**
 * A new domain gets no router until its DNS points at this server: the worker routes it
 * when a DNS check passes, and checks a waiting domain again on a backoff. So the first check is
 * the one that matters. In direct mode it runs at once, since the record is often made before the
 * domain is added. In tunnel mode it waits a little for the wire job to create the record.
 */
export function jobsForCreate(d: { id: string; appId: string }, ingress: "cloudflare_tunnel" | "direct_tls"): EdgeJob[] {
  const jobs: EdgeJob[] = [{ kind: "edge_route_sync", payload: { appId: d.appId }, dedupeKey: `edge.route:${d.appId}` }];
  // In tunnel mode Dockify can create the DNS record and tunnel rule; the worker skips it when
  // Cloudflare is not connected or the zone is not one the owner marked managed.
  if (ingress === "cloudflare_tunnel") jobs.push({ kind: "edge_cf_wire", payload: { domainId: d.id }, dedupeKey: `edge.cf:${d.id}` });
  jobs.push({ kind: "dns_check", payload: { domainId: d.id }, dedupeKey: `edge.dns:${d.id}`, runAfterMs: ingress === "direct_tls" ? 0 : 30_000 });
  return jobs;
}

/** Teardown removes only what the row recorded. No recorded ids, nothing on Cloudflare is touched. */
export function jobsForDelete(d: { id: string; appId: string; hostname: string; cfZoneId: string | null; cfRecordId: string | null }): EdgeJob[] {
  const jobs: EdgeJob[] = [{ kind: "edge_route_sync", payload: { appId: d.appId }, dedupeKey: `edge.route:${d.appId}` }];
  if (d.cfZoneId && d.cfRecordId) {
    jobs.push({
      kind: "edge_cf_unwire",
      payload: { hostname: d.hostname, zoneId: d.cfZoneId, recordId: d.cfRecordId, tunnelId: null },
      dedupeKey: `edge.cf.unwire:${d.cfRecordId}`,
    });
  }
  return jobs;
}
