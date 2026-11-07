import { z } from "zod";
import { EnvName, Hostname, Iso, Resource, ServiceName, StatefulKind, TlsStatus, Uuid } from "./common.ts";

export const ResourceRow = Resource.extend({
  image: z.string(),
  version: z.string().optional(),
  cpu: z.object({ usedPct: z.number(), limitCores: z.number() }),
  memory: z.object({ usedBytes: z.number(), reservedBytes: z.number() }),
  volume: z.object({ name: z.string(), sizeBytes: z.number() }).nullable(),
  startedAt: Iso.nullable(),
});
export const CreateResourceBody = z.strictObject({ kind: StatefulKind, name: ServiceName, projectId: Uuid, environment: EnvName });

export const DnsStatus = z.enum(["ok", "mismatch", "missing", "unchecked"]);
/** The ownership probe: untried while DNS alone settled it, passed when asking the domain reached this server. */
export const DomainProbeStatus = z.enum(["untried", "passed", "failed"]);
/** none: tunnel off or no Cloudflare; managed: Dockify owns the record and rule; external: left alone. */
export const CfDomainState = z.enum(["none", "pending", "managed", "external", "failed"]);
/**
 * A domain gets its route and certificate only once it points here (dns.status ok): its DNS names
 * this server, or, behind a proxy such as Cloudflare's, asking the domain itself reached this
 * server (probe passed). Until then it is waiting for DNS.
 */
export const DomainRow = z.object({
  id: z.string(),
  hostname: z.string(),
  appId: z.string(),
  appName: z.string(),
  /** The app's display name, when it has one. */
  appDisplayName: z.string().optional(),
  projectSlug: z.string(),
  environment: z.string(),
  tls: z.object({ status: TlsStatus, issuer: z.string().nullable(), expiresAt: Iso.nullable() }),
  /** detail: the last check in one line, why the domain does not point here; null when it does. */
  dns: z.object({ status: DnsStatus, resolved: z.array(z.string()), checkedAt: Iso.nullable(), detail: z.string().nullable() }),
  probe: z.object({ status: DomainProbeStatus, detail: z.string().nullable(), checkedAt: Iso.nullable() }),
  cloudflare: z.object({ state: CfDomainState, message: z.string().nullable() }),
  /** A free test domain Dockify generated on its sslip.io name: for trying things out. */
  test: z.boolean(),
  /** The app's port. Null: no route can exist for this domain, whatever its DNS says, until there is one. */
  appPort: z.number().int().nullable(),
  createdAt: Iso,
});
export const IngressMode = z.enum(["cloudflare_tunnel", "direct_tls"]);
export const DomainsPayload = z.object({
  items: z.array(DomainRow),
  ingress: IngressMode,
  /** The record targets: ipv4 is null when DOCKIFY_SERVER_IPV4 is not set, ipv6 when the server has none. */
  server: z.object({ ipv4: z.string().nullable(), ipv6: z.string().nullable(), tunnelTarget: z.string().nullable() }),
});
export const CreateDomainBody = z.strictObject({ hostname: Hostname, appId: Uuid });
/** keepRecord=1: leave the Cloudflare record Dockify made for this domain in place. */
export const TestDomainOffer = z.object({ available: z.boolean(), reason: z.string().nullable(), suffix: z.string().nullable() });
export const CreateTestDomainBody = z.strictObject({ appId: Uuid });
export const DeleteDomainQuery = z.strictObject({ keepRecord: z.enum(["1"]).optional() });
