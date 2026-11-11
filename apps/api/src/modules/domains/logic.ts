import type { Domain } from "@dockify/db";

export const ROUTABLE_KINDS = new Set(["frontend", "backend"]);

export const normalizeHost = (h: string): string => h.trim().toLowerCase().replace(/\.$/, "");

/**
 * The dashboard hostname and the hosts in DOCKIFY_RESERVED_HOSTS can never be a tenant domain: a
 * tenant route for one would hand the owner's session cookie and step-up password to a tenant container.
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

export type DomainWithApp = Omit<Domain, "testDomain"> & {
  testDomain?: boolean;
  app: { id: string; name: string; displayName?: string | null; port?: number | null; environment: { name: string; project: { slug: string } } };
};

export function toDomainRow(d: DomainWithApp) {
  // When appPort is null the domain has no route, even if its DNS reads ok.
  return {
    id: d.id,
    hostname: d.hostname,
    appId: d.app.id,
    appName: d.app.name,
    ...(d.app.displayName ? { appDisplayName: d.app.displayName } : {}),
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

export type EdgeJob =
  | { kind: "edge_route_sync"; payload: { appId: string }; dedupeKey: string }
  | { kind: "edge_cf_wire"; payload: { domainId: string }; dedupeKey: string }
  | { kind: "edge_cf_unwire"; payload: { hostname: string; zoneId: string; recordId: string; tunnelId: null }; dedupeKey: string }
  | { kind: "dns_check"; payload: { domainId: string }; dedupeKey: string; runAfterMs?: number };

/**
 * A route sync is a quick file write: on the server's maintenance lane it never waits behind a build
 * (the worker's ROUTE_SYNC_LANE; it keeps a sync off its own app's swap with a lock, not with the lane).
 */
export const edgeLane = (kind: EdgeJob["kind"]): "maintenance" | "deploy" => (kind === "dns_check" || kind === "edge_route_sync" ? "maintenance" : "deploy");

/**
 * The worker routes a domain only once a DNS check passes. In direct mode the first check runs at
 * once; in tunnel mode it waits 30 s for the wire job to create the record.
 */
export function jobsForCreate(d: { id: string; appId: string }, ingress: "cloudflare_tunnel" | "direct_tls"): EdgeJob[] {
  const jobs: EdgeJob[] = [{ kind: "edge_route_sync", payload: { appId: d.appId }, dedupeKey: `edge.route:${d.appId}` }];
  // The worker skips this when Cloudflare is not connected or the zone is not marked managed.
  if (ingress === "cloudflare_tunnel") jobs.push({ kind: "edge_cf_wire", payload: { domainId: d.id }, dedupeKey: `edge.cf:${d.id}` });
  jobs.push({ kind: "dns_check", payload: { domainId: d.id }, dedupeKey: `edge.dns:${d.id}`, runAfterMs: ingress === "direct_tls" ? 0 : 30_000 });
  return jobs;
}

/** Removes only what the row recorded: with no recorded ids, nothing on Cloudflare is touched. */
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
