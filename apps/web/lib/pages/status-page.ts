import "server-only";
import { cache } from "react";
import { apiRequest, plainError } from "@/lib/api";
import { buildPreviewOverview } from "@/lib/preview-fixture";
import type { AppStatus } from "@/lib/types";
import {
  DAYS, worst,
  type DayState, type Incident, type IncidentImpact, type IncidentStatus, type IncidentUpdate, type PublicStatus, type StatusComponent, type StatusDay,
  type StatusResult, type StatusState,
} from "./status-page-shared";
import { isPreviewMode } from "@/lib/preview-mode";

export * from "./status-page-shared";

/*
 * Public status page loader. API contract (packages/contracts/src/endpoints.ts).
 *
 *   -> PublicStatus. 404 when the project does not exist OR has not published a status page; the
 *   two must be indistinguishable, so a stranger cannot probe which project slugs exist.
 *   The API sends only what the project chose to publish: its display name, an optional logo,
 *   and one entry per published app under the display name the project gave it. Never internal
 *   ids, hostnames, IPs, container names, environments, commit data or owner details.
 *   `days` is the last 90 UTC days, oldest first, the last one being today so far.
 *   `incidents` covers the same 90 days, newest first.
 *
 * Whatever the API answers, `clean` below rebuilds the page from an allowlist of fields with
 * length caps, so a field the API adds by mistake never reaches a public page.
 *
 * Same-origin routes (public too).
 */

/** Public and identical for every visitor, so shared caches may keep it a minute. */
export const PUBLIC_CACHE = { "cache-control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300" };
const REVALIDATE = 60;

/** Project slugs: lowercase letters, digits and inner dashes, 1 to 63 characters. */
const isSlug = (v: string) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v);

// -------------- Cleaning --------------

const STATES: StatusState[] = ["operational", "degraded", "outage"];
const DAY_STATES: DayState[] = ["ok", "minor", "major", "none"];
const IMPACTS: IncidentImpact[] = ["minor", "major"];
const INCIDENT_STATUSES: IncidentStatus[] = ["investigating", "identified", "monitoring", "resolved"];

const oneOf = <T extends string>(list: T[], v: unknown): T | undefined =>
  typeof v === "string" && (list as string[]).includes(v) ? (v as T) : undefined;

/** A trimmed, single-spaced string capped at `max`, or undefined when empty. */
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim().slice(0, max);
  return t || undefined;
}

/** Multi-line update text: keeps paragraph breaks, caps the length. */
function para(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
  return t || undefined;
}

function iso(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 40) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

const minutes = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1440, Math.max(0, Math.round(v))) : 0);

/** Only an https URL or a same-origin path; never javascript:, data:, http: or protocol relative. */
function logo(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 512) return null;
  if (v.startsWith("/") && !v.startsWith("//") && !v.includes("\\")) return v;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

/** The last 90 UTC days ending today, filled from `raw` and "none" where it has no entry. */
function cleanDays(raw: unknown, now: number): StatusDay[] {
  const byDate = new Map<string, StatusDay>();
  for (const d of list(raw, 400)) {
    const r = rec(d);
    const date = typeof r?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : undefined;
    const state = oneOf(DAY_STATES, r?.state);
    if (!date || !state) continue;
    byDate.set(date, { date, state, downMinutes: minutes(r?.downMinutes), degradedMinutes: minutes(r?.degradedMinutes) });
  }
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return Array.from({ length: DAYS }, (_, i) => {
    const date = new Date(today - (DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return byDate.get(date) ?? { date, state: "none", downMinutes: 0, degradedMinutes: 0 };
  });
}

/** Rebuilds a PublicStatus from an allowlist of fields. Null when the answer is not usable. */
function clean(raw: unknown, slug: string, now = Date.now()): PublicStatus | null {
  const r = rec(raw);
  const name = text(r?.name, 80);
  if (!r || !name || r.slug !== slug) return null;

  const seen = new Set<string>();
  const components: StatusComponent[] = [];
  for (const c of list(r.components, 50)) {
    const cr = rec(c);
    const cname = text(cr?.name, 60);
    if (!cname || seen.has(cname)) continue;
    seen.add(cname);
    components.push({ name: cname, state: oneOf(STATES, cr?.state) ?? "operational", days: cleanDays(cr?.days, now) });
  }

  const keys = new Set<string>();
  const incidents: Incident[] = [];
  for (const i of list(r.incidents, 50)) {
    const ir = rec(i);
    const key = typeof ir?.key === "string" && /^[\w-]{1,64}$/.test(ir.key) ? ir.key : undefined;
    const title = text(ir?.title, 140);
    const startedAt = iso(ir?.startedAt);
    if (!key || keys.has(key) || !title || !startedAt) continue;
    keys.add(key);
    const updates: IncidentUpdate[] = [];
    for (const u of list(ir?.updates, 20)) {
      const ur = rec(u);
      const at = iso(ur?.at);
      const status = oneOf(INCIDENT_STATUSES, ur?.status);
      const body = para(ur?.body, 2000);
      if (at && status && body) updates.push({ at, status, body });
    }
    updates.sort((a, b) => b.at.localeCompare(a.at));
    const status = oneOf(INCIDENT_STATUSES, ir?.status) ?? updates[0]?.status ?? "investigating";
    incidents.push({
      key,
      title,
      impact: oneOf(IMPACTS, ir?.impact) ?? "minor",
      status,
      startedAt,
      resolvedAt: status === "resolved" ? (iso(ir?.resolvedAt) ?? updates[0]?.at ?? null) : null,
      // Only names that are on the page, so an unpublished app's name never slips through here.
      affects: list(ir?.affects, 50).filter((a): a is string => typeof a === "string" && seen.has(a)),
      updates,
    });
  }
  incidents.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return {
    slug,
    name,
    logoUrl: logo(r.logoUrl),
    state: oneOf(STATES, r.state) ?? worst(components.map((c) => c.state)),
    updatedAt: iso(r.updatedAt) ?? new Date(now).toISOString(),
    components,
    incidents,
  };
}

// -------------- API --------------

/**
 * One public status page. Sends no cookie on purpose: the endpoint is public, and an operator's
 * session must never change what a public, cached page shows. Deduplicated per request, so
 * generateMetadata and the page share one call.
 */
export const getStatusPage = cache(async (slug: string): Promise<StatusResult> => {
  if (!isSlug(slug)) return { kind: "missing" };

  if (process.env.DOCKIFY_API_URL) {
    // Cached and anonymous (lib/api.ts): nothing of the visitor is forwarded, and the call is bounded.
    const r = await apiRequest<unknown>(`/api/v1/public/status/${encodeURIComponent(slug)}`, { revalidate: { seconds: REVALIDATE, tags: [`status:${slug}`] } });
    if (!r.ok) return r.status === 404 ? { kind: "missing" } : { kind: "error", error: plainError(r) };
    const data = clean(r.data, slug);
    return data ? { kind: "ok", source: "api", data } : { kind: "error", error: "The API sent a status page this dashboard cannot read" };
  }

  if (isPreviewMode()) {
    const data = previewStatus(slug, new Date());
    return data ? { kind: "ok", source: "preview", data } : { kind: "missing" };
  }

  return { kind: "missing" };
});

// -------------- Preview fixture --------------

/*
 * Only horseai publishes a status page; inkwell, brightlane and fieldnote answer 404. The components
 * are horseai's apps from the shared fixture under the display names horseai chose; admin and redis
 * are not published. Current states follow the fixture's app statuses.
 */
const PUBLISHED: Record<string, { name: string; apps: Array<[app: string, display: string, since?: number]> }> = {
  horseai: {
    name: "horseai",
    apps: [
      ["web", "Website"],
      ["api", "API"],
      ["discord-bot", "Discord bot", 64],
      ["postgres", "Database"],
    ],
  },
};

/** The API's rule (modules/observe/status.ts componentState): nothing serving is an outage. */
const FROM_STATUS: Record<AppStatus, StatusState> = {
  running: "operational",
  deploying: "operational",
  degraded: "degraded",
  restarting: "degraded",
  stopped: "outage",
  exited: "outage",
  missing: "outage",
  failed: "outage",
  unknown: "outage",
};

/** Past incidents: days ago, minutes, impact, the display name hit, then the update texts. */
const PAST: Array<[key: string, daysAgo: number, startMin: number, mins: number, impact: IncidentImpact, affects: string, title: string, updates: Array<[IncidentStatus, number, string]>]> = [
  ["api-errors-oct", 12, 14 * 60 + 5, 38, "minor", "API", "Elevated API errors", [
    ["investigating", 0, "Some requests to the API are failing. We are looking into it."],
    ["identified", 14, "A slow database query is holding connections. A fix is rolling out."],
    ["resolved", 38, "The fix is live and error rates are back to normal."],
  ]],
  ["website-down-sep", 41, 9 * 60 + 40, 22, "major", "Website", "Website unreachable", [
    ["investigating", 0, "The website is not loading for most visitors."],
    ["monitoring", 17, "A bad release was rolled back. We are watching the recovery."],
    ["resolved", 22, "The website is fully available again."],
  ]],
  ["bot-delays-aug", 58, 20 * 60 + 15, 75, "minor", "Discord bot", "Discord bot replies delayed", [
    ["investigating", 0, "Slash commands are answering slowly."],
    ["resolved", 75, "Discord rate limits eased and replies are back to normal speed."],
  ]],
];

function previewStatus(slug: string, at: Date): PublicStatus | null {
  const pub = PUBLISHED[slug];
  if (!pub) return null;
  const now = Math.floor(at.getTime() / 60_000) * 60_000;
  const today = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  const { resources } = buildPreviewOverview(at);

  const incidents: Incident[] = PAST.map(([key, daysAgo, startMin, mins, impact, affects, title, ups]) => {
    const start = today - daysAgo * 86_400_000 + startMin * 60_000;
    const stamp = (m: number) => new Date(start + m * 60_000).toISOString();
    return {
      key,
      title,
      impact,
      status: "resolved",
      startedAt: stamp(0),
      resolvedAt: stamp(mins),
      affects: [affects],
      updates: ups.map(([status, m, body]) => ({ at: stamp(m), status, body })).reverse(),
    };
  });

  const components: StatusComponent[] = pub.apps.map(([app, name, since]) => {
    const res = resources.find((r) => r.projectSlug === slug && r.name === app && r.environment === "production");
    const days: StatusDay[] = Array.from({ length: DAYS }, (_, i) => {
      const ago = DAYS - 1 - i;
      const date = new Date(today - ago * 86_400_000).toISOString().slice(0, 10);
      if (since !== undefined && ago > since) return { date, state: "none", downMinutes: 0, degradedMinutes: 0 };
      const hit = PAST.find((p) => p[1] === ago && p[5] === name);
      if (!hit) return { date, state: "ok", downMinutes: 0, degradedMinutes: 0 };
      const major = hit[4] === "major";
      return { date, state: major ? "major" : "minor", downMinutes: major ? hit[3] : 0, degradedMinutes: major ? 0 : hit[3] };
    });
    return { name, state: res ? FROM_STATUS[res.status] : "operational", days };
  });

  return {
    slug,
    name: pub.name,
    logoUrl: null,
    state: worst(components.map((c) => c.state)),
    updatedAt: new Date(now).toISOString(),
    components,
    incidents,
  };
}
