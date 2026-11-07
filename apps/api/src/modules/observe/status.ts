/**
 * Status pages. The public endpoint needs no auth, so it is built from a whitelist: the page title
 * and logo, each item's public label (never an internal app name), its state (componentState), day
 * bars from app_uptime_days, and the incidents the operator wrote. The result is parsed through the contract schema, which
 * strips anything not in it, and cached for 30 seconds per slug. A missing and an unpublished page
 * both answer the same 404, so the endpoint does not reveal which projects exist.
 */
import { server as S } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import type { Actor } from "../../actor.ts";
import { assertProjectScope } from "../../actor.ts";
import { audit } from "../../audit.ts";
import { HttpError } from "../../errors.ts";
import { dayState, incidentUpdates, lastDays, safeLogoUrl, worst, type CompState } from "./logic.ts";
import { notFound } from "./scope.ts";

export const CACHE_MS = 30_000;
const DAYS = 90;
const DAY_MS = 86_400_000;
const MAX_CACHE = 1_000;

type Public = ReturnType<typeof S.PublicStatus.parse>;
const cache = new Map<string, { at: number; value: Public | null }>();

export const clearStatusCache = (slug?: string): void => {
  if (slug) cache.delete(slug);
  else cache.clear();
};

/** App statuses where nothing serves: the page says outage, alert rule or not. */
const OUTAGE: ReadonlySet<string> = new Set(["exited", "missing", "failed", "stopped", "unknown"]);
const DEGRADED: ReadonlySet<string> = new Set(["degraded", "restarting"]);
/** The worker probes every minute; a verdict older than this no longer speaks for the app. */
export const REACH_FRESH_MS = 5 * 60_000;

/**
 * One component's state: the app's observed status (the worker's observe pass writes it
 * from the daemon), the worker's last request through the proxy (a running container behind a
 * broken route is still an outage for a visitor), then any open alert: a down alert is an outage,
 * anything else degrades it.
 */
export function componentState(openMetrics: string[], app: { status: string; reachable: boolean | null; reachableAt: Date | null }, now: number): CompState {
  if (openMetrics.includes("down") || OUTAGE.has(app.status)) return "outage";
  if (app.reachable === false && app.reachableAt && now - app.reachableAt.getTime() <= REACH_FRESH_MS) return "outage";
  if (openMetrics.length > 0 || DEGRADED.has(app.status)) return "degraded";
  return "operational";
}

/**
 * What the page lists until someone chooses: every app with a verified public domain, under that
 * domain's name, which the world can already see. An internal app name never appears this way.
 */
async function defaultItems(db: Db, projectId: string) {
  const apps = await db.app.findMany({
    where: { environment: { projectId }, domains: { some: { dnsStatus: "ok" } } },
    orderBy: { createdAt: "asc" },
    select: { id: true, status: true, reachable: true, reachableAt: true, domains: { where: { dnsStatus: "ok" }, orderBy: { createdAt: "asc" }, take: 1, select: { hostname: true } } },
  });
  return apps.map((a) => ({ label: a.domains[0]?.hostname ?? "", appId: a.id, app: { status: a.status, reachable: a.reachable, reachableAt: a.reachableAt } })).filter((i) => i.label);
}

async function build(db: Db, slug: string, now: number): Promise<Public | null> {
  const project = await db.project.findUnique({
    where: { slug },
    select: {
      id: true, slug: true, name: true, archivedAt: true,
      statusPage: {
        select: {
          id: true, enabled: true, title: true, logoUrl: true,
          items: { orderBy: [{ position: "asc" }, { label: "asc" }], select: { label: true, appId: true, app: { select: { status: true, reachable: true, reachableAt: true } } } },
          incidents: {
            where: { OR: [{ resolvedAt: null }, { startedAt: { gte: new Date(now - DAYS * DAY_MS) } }] },
            orderBy: { startedAt: "desc" },
            take: 50,
          },
        },
      },
    },
  });
  const page = project?.statusPage;
  if (!project || project.archivedAt || !page?.enabled) return null;

  const items = page.items.length ? page.items : await defaultItems(db, project.id);
  const appIds = items.map((i) => i.appId);
  const since = new Date(Math.floor(now / DAY_MS) * DAY_MS - (DAYS - 1) * DAY_MS);
  const [days, open] = await Promise.all([
    db.appUptimeDay.findMany({ where: { appId: { in: appIds }, day: { gte: since } } }),
    db.alertEvent.findMany({ where: { appId: { in: appIds }, state: "firing" }, select: { appId: true, metric: true } }),
  ]);
  const dates = lastDays(DAYS, now);
  const components = items.map((item) => {
    const mine = new Map(days.filter((d) => d.appId === item.appId).map((d) => [d.day.toISOString().slice(0, 10), d]));
    return {
      name: item.label,
      state: componentState(open.filter((e) => e.appId === item.appId).map((e) => e.metric), item.app, now),
      days: dates.map((date) => {
        const d = mine.get(date);
        return { date, state: dayState(d), downMinutes: d?.downMinutes ?? 0, degradedMinutes: d?.degradedMinutes ?? 0 };
      }),
    };
  });
  const labels = new Set(items.map((i) => i.label));
  return S.PublicStatus.parse({
    slug: project.slug,
    name: page.title ?? project.name,
    logoUrl: safeLogoUrl(page.logoUrl),
    state: worst(components.map((c) => c.state)),
    updatedAt: new Date(now).toISOString(),
    components,
    incidents: page.incidents.map((i) => ({
      key: i.id,
      title: i.title,
      impact: i.impact,
      status: i.status,
      startedAt: i.startedAt.toISOString(),
      resolvedAt: i.resolvedAt?.toISOString() ?? null,
      // Only names that are on the page: an incident cannot leak another component's name.
      affects: i.affects.filter((a) => labels.has(a)),
      updates: incidentUpdates(i.updates),
    })),
  });
}

export async function publicStatus(db: Db, slug: string, now = Date.now()): Promise<Public> {
  const hit = cache.get(slug);
  let value: Public | null;
  if (hit && now - hit.at < CACHE_MS) {
    value = hit.value;
  } else {
    value = await build(db, slug, now);
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
    cache.set(slug, { at: now, value });
  }
  if (!value) throw notFound();
  return value;
}

async function projectFor(db: Db, actor: Actor | null, slug: string) {
  const p = await db.project.findUnique({
    where: { slug },
    select: { id: true, slug: true, statusPage: { select: { enabled: true, _count: { select: { items: true } } } } },
  });
  if (!p) throw notFound();
  if (actor) assertProjectScope(actor, p.id);
  return p;
}

const pageState = async (db: Db, p: { id: string; slug: string }, sp: { enabled: boolean; _count: { items: number } } | null) => ({
  enabled: sp?.enabled ?? false,
  path: `/status/${p.slug}`,
  publicApps: sp?._count.items || (await defaultItems(db, p.id)).length,
});

export async function statusPageGet(db: Db, actor: Actor | null, slug: string) {
  const p = await projectFor(db, actor, slug);
  return pageState(db, p, p.statusPage);
}

export interface StatusPagePatchInput {
  enabled?: boolean;
  title?: string | null;
  logoUrl?: string | null;
  items?: Array<{ appId: string; label: string }>;
}

export async function statusPagePatch(db: Db, actor: Actor | null, slug: string, patch: StatusPagePatchInput, ip: string, ua: string | undefined) {
  const p = await projectFor(db, actor, slug);
  const fields = {
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.title !== undefined ? { title: patch.title || null } : {}),
    ...(patch.logoUrl !== undefined ? { logoUrl: patch.logoUrl } : {}),
  };
  const row = await db.$transaction(async (tx) => {
    const page = await tx.statusPage.upsert({ where: { projectId: p.id }, create: { projectId: p.id, ...fields }, update: fields, select: { id: true } });
    if (patch.items) {
      const ids = [...new Set(patch.items.map((i) => i.appId))];
      if (ids.length !== patch.items.length) throw new HttpError(400, "Each app can appear once", "INVALID_REQUEST", { field: "items" });
      // Only this project's apps can be listed; anything else reads as not found.
      const owned = await tx.app.count({ where: { id: { in: ids }, environment: { projectId: p.id } } });
      if (owned !== ids.length) throw new HttpError(400, "An app is not part of this project", "INVALID_REQUEST", { field: "items" });
      await tx.statusPageItem.deleteMany({ where: { statusPageId: page.id } });
      await tx.statusPageItem.createMany({ data: patch.items.map((i, position) => ({ statusPageId: page.id, appId: i.appId, label: i.label, position })) });
    }
    return tx.statusPage.findUniqueOrThrow({ where: { id: page.id }, select: { enabled: true, _count: { select: { items: true } } } });
  });
  clearStatusCache(slug);
  const was = p.statusPage?.enabled ?? false;
  const toggled = patch.enabled !== undefined && was !== patch.enabled;
  if (toggled || patch.items || patch.title !== undefined || patch.logoUrl !== undefined) {
    const enabled = row.enabled;
    await audit(db, {
      category: "config",
      action: toggled ? (enabled ? "status_page.publish" : "status_page.unpublish") : "status_page.update",
      verb: toggled ? (enabled ? "published the status page of" : "unpublished the status page of") : "updated the status page of",
      targetType: "project", targetId: p.id, targetLabel: slug,
      actorType: actor?.kind === "token" ? "token" : "user",
      actorId: actor ? (actor.kind === "token" ? actor.tokenId : actor.userId) : null,
      actorName: actor?.name ?? null, ip, userAgent: ua ?? null,
    });
  }
  return pageState(db, p, row);
}
