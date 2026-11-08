/**
 * GET /api/v1/overview: counts, the latest deployments, every app as a resource tile, a daily deploy
 * trend for the calendar year (from Jan 1 through Dec 31, reaching back 59 days before today in
 * January and February so the 30 day comparisons stay whole), a 30 day app health strip from
 * app_uptime_days, and the host card. A token limited to some projects sees only those projects'
 * rows; host data is server-wide by nature.
 *
 * The trend counts calendar days in `trendZone` (the viewer's saved zone, else the `tz` their
 * browser sent, else UTC), the same days the dashboard groups its deployment lists by, so "today"
 * means one day everywhere on the page. The health strip stays on UTC days: app_uptime_days stores
 * whole UTC days, which cannot be split by another zone.
 */
import type { Db, Prisma } from "@dockify/db";
import type { Actor } from "../../actor.ts";
import { actorRef, deploymentSource, loadPeople } from "../../actor-view.ts";
import { externalOf } from "../deployments/mapping.ts";
import { dayIn, lastDays, trendDays, trendStart, trendZone } from "./logic.ts";
import { hostSnapshot } from "./metrics.ts";
import { projectLimit } from "./scope.ts";
import { updateNotices } from "../platform/updates/notices.ts";
import { runningVersion } from "@dockify/contracts";

const RECENT = 10;
const DEPLOYMENT_ROW = { app: { select: { id: true, name: true, displayName: true, kind: true, image: true, gitRepository: true, environment: { select: { name: true, project: { select: { slug: true } } } } } } } as const;
const HEALTH_DAYS = 30;
const DAY_MS = 86_400_000;
const KINDS = ["frontend", "backend", "bot", "postgres", "redis", "s3"] as const;
const STATUSES = ["running", "stopped", "deploying", "degraded", "unknown", "restarting", "exited", "missing", "failed"] as const;
/** The contract has no "cancelling": it reads as still deploying. */
const DEPLOY_STATUS = { queued: "queued", building: "building", deploying: "deploying", ready: "ready", failed: "failed", cancelling: "deploying", cancelled: "cancelled" } as const;

/** `tz` is the zone the browser reads times in; it counts only for a viewer who saved no zone of their own. */
export async function overview(db: Db, actor: Actor | null, now = Date.now(), opts: { tz?: string } = {}) {
  const limit = projectLimit(actor);
  const projectWhere: Prisma.ProjectWhereInput = limit ? { id: { in: limit } } : {};
  const appWhere: Prisma.AppWhereInput = { environment: { project: { archivedAt: null, ...projectWhere } } };
  const depWhere: Prisma.DeploymentWhereInput = limit ? { app: { environment: { projectId: { in: limit } } } } : {};
  const healthStart = new Date(Math.floor(now / DAY_MS) * DAY_MS - (HEALTH_DAYS - 1) * DAY_MS);

  // The viewer's saved zone decides which calendar days the trend counts, so only the trend query
  // waits for that row; everything else runs alongside it.
  const viewerRow = actor
    ? db.user.findUnique({ where: { id: actor.userId }, select: { name: true, email: true, avatarUrl: true, timeZone: true, hour12: true } })
    : Promise.resolve(null);
  const zoneOf = viewerRow.then((v) => trendZone(v?.timeZone, opts.tz));
  // One start for the query and the zero-fill below, so neither can drift from the other.
  const trendRows = zoneOf.then((zone) =>
    db.deployment.findMany({ where: { ...depWhere, createdAt: { gte: new Date(trendStart(now, zone)) } }, select: { createdAt: true, status: true } }),
  );

  const [
    projectsTotal, projectsActive, environments, appsTotal, byKindRows, byStatusRows, domains,
    deploymentsTotal, deployments24h, inFlight, recent, apps, trend, uptime, instance, viewer, zone, system, projectRows,
  ] = await Promise.all([
    db.project.count({ where: projectWhere }),
    db.project.count({ where: { ...projectWhere, archivedAt: null } }),
    db.environment.count({ where: limit ? { projectId: { in: limit } } : {} }),
    db.app.count({ where: appWhere }),
    db.app.groupBy({ by: ["kind"], where: appWhere, _count: { _all: true } }),
    db.app.groupBy({ by: ["status"], where: appWhere, _count: { _all: true } }),
    db.domain.count({ where: limit ? { app: { environment: { projectId: { in: limit } } } } : {} }),
    db.deployment.count({ where: depWhere }),
    db.deployment.count({ where: { ...depWhere, createdAt: { gte: new Date(now - DAY_MS) } } }),
    db.deployment.count({ where: { ...depWhere, status: { in: ["queued", "building", "deploying", "cancelling"] } } }),
    db.deployment.findMany({ where: depWhere, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: RECENT, include: DEPLOYMENT_ROW }),
    db.app.findMany({
      where: appWhere,
      select: { id: true, name: true, displayName: true, kind: true, status: true, deployTarget: true, environment: { select: { name: true, project: { select: { id: true, slug: true } } } } },
      orderBy: [{ environment: { project: { slug: "asc" } } }, { environment: { name: "asc" } }, { name: "asc" }],
      take: 500,
    }),
    trendRows,
    db.appUptimeDay.findMany({
      where: { day: { gte: healthStart }, ...(limit ? { app: { environment: { projectId: { in: limit } } } } : {}) },
      select: { day: true, downMinutes: true, sampledMinutes: true },
    }),
    db.instance.findUnique({ where: { id: 1 }, select: { name: true } }),
    viewerRow,
    zoneOf,
    // The bell's update notices; no dependency on the rows above, so it rides the same batch.
    updateNotices(db, runningVersion(), now).catch(() => []),
    // Every active project, apps or not: a new project starts empty and must still be listed.
    db.project.findMany({ where: { ...projectWhere, archivedAt: null }, select: { slug: true, name: true }, orderBy: { slug: "asc" }, take: 500 }),
  ]);

  // RECENT is across the install, so it cannot say what a quieter app last did. One index read per app.
  const lastIds = apps.length
    ? await db.$queryRaw<Array<{ id: string }>>`
        SELECT l.id FROM apps a CROSS JOIN LATERAL (
          SELECT d.id FROM deployments d WHERE d."appId" = a.id AND d.status <> 'queued' ORDER BY d."createdAt" DESC, d.id DESC LIMIT 1
        ) l WHERE a.id = ANY(${apps.map((a) => a.id)}::uuid[])`
    : [];
  const last = lastIds.length ? await db.deployment.findMany({ where: { id: { in: lastIds.map((r) => r.id) } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: DEPLOYMENT_ROW }) : [];

  // loadPeople needs these rows, hostSnapshot needs `instance`: both from the batch above, run in parallel.
  const [people, host] = await Promise.all([loadPeople(db, actor, [...recent, ...last]), hostSnapshot(db, instance?.name ?? "Dockify", now)]);
  const row = (d: (typeof recent)[number]) => ({
    id: d.id,
    appId: d.appId,
    status: DEPLOY_STATUS[d.status],
    commit: d.commitSha,
    message: d.message,
    trigger: d.trigger,
    createdAt: d.createdAt.toISOString(),
    finishedAt: d.finishedAt?.toISOString() ?? null,
    app: { id: d.app.id, name: d.app.name, ...(d.app.displayName ? { displayName: d.app.displayName } : {}), kind: d.app.kind },
    projectSlug: d.app.environment.project.slug,
    environment: d.app.environment.name,
    repo: d.app.gitRepository,
    ...externalOf(d),
    actor: actorRef(d, people),
    ...deploymentSource(d, d.app, people),
  });
  const trendMap = new Map(trendDays(now, zone).map((d) => [d, { total: 0, failed: 0 }]));
  for (const d of trend) {
    const b = trendMap.get(dayIn(d.createdAt.getTime(), zone));
    if (!b) continue;
    b.total++;
    if (d.status === "failed") b.failed++;
  }
  const healthMap = new Map(lastDays(HEALTH_DAYS, now).map((d) => [d, { healthy: 0, total: 0 }]));
  for (const u of uptime) {
    const b = healthMap.get(u.day.toISOString().slice(0, 10));
    if (!b || u.sampledMinutes === 0) continue;
    b.total++;
    if (u.downMinutes === 0) b.healthy++;
  }

  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<(typeof KINDS)[number], number>;
  for (const r of byKindRows) byKind[r.kind] = r._count._all;
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
  for (const r of byStatusRows) byStatus[r.status] = r._count._all;

  return {
    ...(viewer && actor
      ? {
          viewer: {
            name: viewer.name,
            role: actor.role,
            email: viewer.email,
            ...(viewer.avatarUrl ? { avatarUrl: viewer.avatarUrl } : {}),
            time: { timeZone: viewer.timeZone, hour12: viewer.hour12 },
          },
        }
      : {}),
    projects: projectRows,
    counts: {
      projects: { total: projectsTotal, active: projectsActive, archived: projectsTotal - projectsActive },
      environments,
      apps: { total: appsTotal, byKind, byStatus },
      domains,
      deployments: { total: deploymentsTotal, last24h: deployments24h, inFlight },
    },
    recentDeployments: recent.map(row),
    lastDeployments: last.map(row),
    resources: apps.map((a) => ({
      id: a.id, name: a.name, ...(a.displayName ? { displayName: a.displayName } : {}), kind: a.kind, status: a.status,
      projectId: a.environment.project.id, projectSlug: a.environment.project.slug, environment: a.environment.name,
      ...(a.deployTarget === "vercel" ? { onVercel: true as const } : {}),
    })),
    deployTrend: [...trendMap].map(([date, v]) => ({ date, ...v })),
    /** The IANA zone deployTrend's days are counted in. */
    trendZone: zone,
    appHealth: [...healthMap].map(([date, v]) => ({ date, ...v })),
    host,
    // The bell's update notices; server-wide like the host card.
    system,
  };
}
