import "server-only";
import { connection } from "next/server";
import { cache } from "react";
import { apiRequest, plainError, UNREADABLE } from "@/lib/api";
import { domainTargets } from "@/lib/domain-targets";
import { json, readJsonBody, refuse, upstreamStatus } from "@/lib/http";
import { buildPreviewOverview } from "@/lib/preview-fixture";
import type { AppKind, Overview, OverviewSource, Resource } from "@/lib/types";
import { isPreviewMode } from "@/lib/preview-mode";

/*
 * Resources and Domains pages. The routes are in packages/contracts/src/endpoints.ts (all JSON, session
 * cookie auth, every read sent with cache: no-store).
 *
 *   Connection details are never listed here: an app reads a service's credentials through an
 *   env reference (see project-detail.ts, EnvRef), which the API resolves at deploy time.
 *
 * The browser never calls the API directly: it goes through the same-origin route handlers in
 * app/api/domains, which guard the origin (`guardWrite`), validate ids and bodies, and forward the
 * cookie with `forward()` below.
 */

/* -------------- Types -------------- */

export type StatefulKind = Extract<AppKind, "postgres" | "redis" | "s3">;

export interface ResourceRow extends Resource {
  /** Image reference the container runs, for example "postgres:16-alpine". */
  image: string;
  /** Engine version for services ("16.4"); absent for built apps, whose image tag is the commit. */
  version?: string;
  cpu: { usedPct: number; limitCores: number };
  memory: { usedBytes: number; reservedBytes: number };
  /** Persistent volume, for stateful services only. */
  volume: { name: string; sizeBytes: number } | null;
  /** When the current container started; null while stopped. */
  startedAt: string | null;
}

export type TlsStatus = "active" | "pending" | "failed";
export type DnsStatus = "ok" | "mismatch" | "missing" | "unchecked";
export type ProbeStatus = "untried" | "passed" | "failed";
export type IngressMode = "direct_tls" | "cloudflare_tunnel";

export interface DomainRow {
  id: string;
  hostname: string;
  appId: string;
  appName: string;
  projectSlug: string;
  environment: string;
  /** "expiring" is derived in the UI from expiresAt, it is never sent. */
  tls: { status: TlsStatus; issuer: string | null; expiresAt: string | null };
  /**
   * `resolved` holds what the last lookup found (CNAME targets as "cname:<name>", then addresses).
   * `detail` says in one line why the domain does not point here; null when it does, absent from
   * an API older than the field.
   */
  dns: { status: DnsStatus; resolved: string[]; checkedAt: string | null; detail?: string | null };
  /** The ownership probe, for records that name a proxy; absent from an API older than it. */
  probe?: { status: ProbeStatus; detail: string | null; checkedAt: string | null };
  /** A free test domain Dockify generated. Absent from an API older than it. */
  test?: boolean;
  /** The app's port. Null: no route exists until there is one. Absent from an API older than it. */
  appPort?: number | null;
  createdAt: string;
}

/**
 * The list and an app's Domains tab. getDomains hands the server's targets on as strings ("" when
 * unknown); an app's tab gets the API's payload as it is, where an unknown target is null and an
 * older API sends neither the mode nor the IPv6 address. Read both through domainTargets
 * (lib/domain-targets.ts).
 */
export interface DomainsPayload {
  items: DomainRow[];
  ingress: IngressMode;
  server: { ipv4: string | null; ipv6?: string | null; tunnelTarget?: string | null };
}

/** Whether this server can offer free test domains. */
export interface TestDomainOffer {
  available: boolean;
  reason: string | null;
  suffix: string | null;
}

export interface PageResult<T> {
  source: OverviewSource;
  data: T | null;
  error?: string;
  fetchedAt: string;
}

/* -------------- API access -------------- */

/** One read (lib/api.ts, bounded): a line for the status on a failure, never the API's wording. */
async function apiGet<T>(path: string): Promise<{ data: T | null; error?: string; status: number }> {
  const r = await apiRequest<T>(path);
  if (!r.ok) return { data: null, error: plainError(r), status: r.status };
  return r.data === null ? { data: null, error: UNREADABLE, status: 502 } : { data: r.data, status: r.status };
}

/** Lists may come back bare or wrapped, the same tolerance as the deployments day feed. */
const rows = <T,>(body: T[] | { items?: T[]; data?: T[] }) => (Array.isArray(body) ? body : (body.items ?? body.data ?? []));

export const getResources = cache(async (): Promise<PageResult<ResourceRow[]>> => {
  await connection();
  const fetchedAt = new Date().toISOString();
  if (process.env.DOCKIFY_API_URL) {
    const r = await apiGet<ResourceRow[] | { items?: ResourceRow[] }>("/api/v1/resources");
    return { source: "api", data: r.data ? rows(r.data) : null, error: r.error, fetchedAt };
  }
  if (isPreviewMode()) return { source: "preview", data: previewResources(new Date()), fetchedAt };
  return { source: "none", data: null, fetchedAt };
});

export const getDomains = cache(async (): Promise<PageResult<DomainsPayload>> => {
  await connection();
  const fetchedAt = new Date().toISOString();
  if (process.env.DOCKIFY_API_URL) {
    const r = await apiGet<DomainsPayload>("/api/v1/domains");
    if (!r.data) return { source: "api", data: null, error: r.error, fetchedAt };
    const t = domainTargets(r.data);
    return { source: "api", data: { items: rows(r.data.items ?? []), ingress: t.ingress, server: { ipv4: t.ipv4, ipv6: t.ipv6, tunnelTarget: t.tunnelTarget } }, error: r.error, fetchedAt };
  }
  if (isPreviewMode()) return { source: "preview", data: previewDomains(new Date()), fetchedAt };
  return { source: "none", data: null, fetchedAt };
});

/* -------------- Route helpers -------------- */

/** Ids are opaque API tokens. Anything else, ".." above all, never reaches an upstream path. */
export const isId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);

/** A JSON object body (at most 256 KB), or null for anything else. */
async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const r = await readJsonBody(request);
  return r.ok && r.value && typeof r.value === "object" && !Array.isArray(r.value) ? (r.value as Record<string, unknown>) : null;
}

/** The add-domain body with only the fields the API takes, or the reason it is refused. */
export async function readAddDomain(request: Request): Promise<{ hostname: string; appId: string } | string> {
  const b = await readBody(request);
  if (!b) return "Body must be a JSON object";
  const { hostname, appId } = b;
  if (typeof hostname !== "string" || hostname.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(hostname)) return "Invalid hostname";
  if (!isId(appId)) return "Invalid app";
  return { hostname, appId };
}

/**
 * Forwards a write from a same-origin route handler to the API (lib/api.ts) with the caller's cookie
 * and hands the API's answer back. A refusal keeps the API's 4xx and code (401 ends the session, a
 * step-up refusal asks for one; removing a domain is elevated), and an answer this dashboard cannot
 * read becomes `{ ok: false, error }`, so the browser always reads one shape. Without an API there is
 * nothing to write to: the preview applies its writes in local state and never calls these routes.
 */
export async function forward(method: "POST" | "DELETE", path: string, body?: unknown): Promise<Response> {
  if (!process.env.DOCKIFY_API_URL) return refuse(503, "No data source");
  const r = await apiRequest<unknown>(path, { method, body });
  // A 204 carries no body; the browser still reads one shape.
  if (r.ok) return json(r.data ?? { ok: true }, r.status === 204 ? 200 : r.status);
  return refuse(upstreamStatus(r.status), r.error, r.code ? { code: r.code } : {});
}

/* -------------- Preview fixture -------------- */
// Derived from buildPreviewOverview so ids, projects, statuses and the domain count agree with
// the overview. Stats are seeded per resource, so every refresh shows the same numbers.

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** Reserved memory and CPU limit per kind, in a size a small VPS tenant would really get. */
const SIZING: Record<AppKind, { mem: number; cores: number }> = {
  frontend: { mem: 512 * MB, cores: 1 },
  backend: { mem: 1 * GB, cores: 2 },
  bot: { mem: 256 * MB, cores: 0.5 },
  postgres: { mem: 2 * GB, cores: 2 },
  redis: { mem: 512 * MB, cores: 1 },
  s3: { mem: 1 * GB, cores: 1 },
};

const SERVICE: Record<StatefulKind, { image: string; version: string }> = {
  postgres: { image: "postgres:16-alpine", version: "16.4" },
  redis: { image: "redis:7.4-alpine", version: "7.4.1" },
  s3: { image: "minio/minio:RELEASE.2025-09-07", version: "2025-09-07" },
};

/** Volume sizes for the stateful services, by project. */
const VOLUME_GB: Record<string, number> = {
  "horseai/postgres": 18.4,
  "horseai/redis": 0.3,
  "inkwell/postgres": 9.6,
  "brightlane/postgres": 6.2,
  "brightlane/redis": 0.2,
  "fieldnote/postgres": 4.1,
  "fieldnote/minio": 42.7,
};

function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** A stable fraction in [0, 1) for a key. */
const frac = (key: string) => (hash(key) % 10_000) / 10_000;

const isStateful = (k: AppKind): k is StatefulKind => k === "postgres" || k === "redis" || k === "s3";

function previewResources(now: Date): ResourceRow[] {
  const o: Overview = buildPreviewOverview(now);
  const booted = now.getTime() - (o.host?.uptimeSeconds ?? 0) * 1000;
  return o.resources.map((r) => {
    const size = SIZING[r.kind];
    const last = o.recentDeployments.find((d) => d.appId === r.id && d.status === "ready");
    const stopped = r.status === "stopped";
    const key = `${r.projectSlug}/${r.name}/${r.environment}`;
    const commit = last?.commit ?? hash(key).toString(16).padStart(7, "0").slice(0, 7);
    const svc = isStateful(r.kind) ? SERVICE[r.kind] : null;
    const vol = VOLUME_GB[`${r.projectSlug}/${r.name}`];
    // A degraded service is busy and near its limits; a running one sits in a calm band.
    const load = r.status === "degraded" ? 0.78 + frac(`${key}c`) * 0.15 : 0.03 + frac(`${key}c`) * 0.32;
    const mem = r.status === "degraded" ? 0.88 : 0.25 + frac(`${key}m`) * 0.45;
    return {
      ...r,
      image: svc ? svc.image : `dockify/${r.projectSlug}-${r.name}:${commit}`,
      version: svc?.version,
      cpu: { usedPct: stopped ? 0 : Math.round(load * 1000) / 10, limitCores: size.cores },
      memory: { usedBytes: stopped ? 0 : Math.round(size.mem * mem), reservedBytes: size.mem },
      volume: vol ? { name: `${r.projectSlug}_${r.name}_data`, sizeBytes: Math.round(vol * GB) } : null,
      startedAt: stopped ? null : new Date(last?.finishedAt ? Date.parse(last.finishedAt) : booted).toISOString(),
    };
  });
}

/** Documentation range addresses (RFC 5737, RFC 3849), never the real server. */
const PREVIEW_IPV4 = "203.0.113.24";
const PREVIEW_IPV6 = "2001:db8::24";
/** Two addresses in Cloudflare's published edge ranges, as a proxied record resolves. */
const PREVIEW_CF_EDGE = ["104.21.48.12", "172.67.181.40"];

/**
 * The domains that wait for DNS, and why: one added minutes ago with no record yet, and one behind
 * Cloudflare whose check cannot get through while Cloudflare insists on a certificate this server
 * only asks for once the check passes. The rest point here.
 */
const WAITING: Record<string, { resolved: string[]; detail: string; probe?: string }> = {
  "devapi.fieldnote.example": { resolved: [], detail: "No A or AAAA record for devapi.fieldnote.example yet." },
  "www.brightlane.example": {
    resolved: PREVIEW_CF_EDGE,
    detail: `www.brightlane.example is proxied by Cloudflare, so its records name Cloudflare, not ${PREVIEW_IPV4}.`,
    probe: "Asking www.brightlane.example did not reach this server: Cloudflare refused this server's certificate (526). Set SSL/TLS to Full until the certificate is active.",
  },
};

const DOMAINS: Array<[hostname: string, project: string, app: string, env: string, tls: TlsStatus, expiresInDays: number | null, dns: DnsStatus, addedDaysAgo: number]> = [
  ["horseai.example", "horseai", "web", "production", "active", 61, "ok", 142],
  ["www.horseai.example", "horseai", "web", "production", "active", 61, "ok", 142],
  ["api.horseai.example", "horseai", "api", "production", "active", 47, "ok", 142],
  ["admin.horseai.example", "horseai", "admin", "production", "active", 74, "ok", 96],
  ["inkwell.example", "inkwell", "web", "production", "active", 38, "ok", 88],
  ["www.inkwell.example", "inkwell", "web", "production", "active", 38, "ok", 88],
  ["api.inkwell.example", "inkwell", "api", "production", "active", 52, "ok", 88],
  ["admin.inkwell.example", "inkwell", "admin", "production", "active", 9, "ok", 81],
  ["brightlane.example", "brightlane", "web", "production", "active", 66, "ok", 54],
  ["www.brightlane.example", "brightlane", "web", "production", "pending", null, "mismatch", 3],
  ["api.brightlane.example", "brightlane", "api", "production", "active", 66, "ok", 54],
  ["fieldnote.example", "fieldnote", "web", "production", "active", 83, "ok", 38],
  ["www.fieldnote.example", "fieldnote", "web", "production", "active", 83, "ok", 38],
  ["api.fieldnote.example", "fieldnote", "api", "production", "active", 79, "ok", 38],
  ["admin.fieldnote.example", "fieldnote", "admin", "production", "active", 71, "ok", 31],
  ["devapi.fieldnote.example", "fieldnote", "api", "development", "pending", null, "missing", 0],
  ["cdn.fieldnote.example", "fieldnote", "minio", "production", "active", 57, "ok", 38],
];

/** The preview's domains, for its Cloudflare answers (lib/pages/dashboard-domain.ts). */
export const previewDomainsForCloudflare = (): DomainRow[] => previewDomains(new Date()).items;

function previewDomains(now: Date): DomainsPayload {
  const o = buildPreviewOverview(now);
  const t = now.getTime();
  const items = DOMAINS.map(([hostname, project, app, environment, tls, expires, dns, added], i): DomainRow => {
    const target = o.resources.find((r) => r.projectSlug === project && r.name === app && r.environment === environment);
    const checked = new Date(t - (5 + i * 3) * 60_000).toISOString();
    const waiting = WAITING[hostname];
    return {
      id: `dom_${i}`,
      hostname,
      appId: target?.id ?? "app_x",
      appName: app,
      projectSlug: project,
      environment,
      tls: {
        status: tls,
        issuer: tls === "active" ? "Let's Encrypt" : null,
        // Expiry lands at a fixed hour so "in 9 days" stays true across the day.
        expiresAt: expires === null ? null : new Date(t + expires * 86_400_000 + 3_600_000).toISOString(),
      },
      dns: { status: dns, resolved: waiting?.resolved ?? (dns === "ok" ? [PREVIEW_IPV4] : []), checkedAt: checked, detail: dns === "ok" ? null : (waiting?.detail ?? null) },
      probe: waiting?.probe ? { status: "failed", detail: waiting.probe, checkedAt: checked } : { status: "untried", detail: null, checkedAt: null },
      createdAt: new Date(t - added * 86_400_000 - 40 * 60_000).toISOString(),
    };
  });
  // Keeps the page and the overview's domain count in agreement.
  return { items: items.slice(0, o.counts.domains), ingress: "direct_tls", server: { ipv4: PREVIEW_IPV4, ipv6: PREVIEW_IPV6, tunnelTarget: "" } };
}
