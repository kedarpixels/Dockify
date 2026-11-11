/**
 * Preview teardown, sleep and wake, and the reconcile that makes the cleanup guarantee hold whatever
 * crashed in between. A preview on the wrong network for its project's setting is built again:
 * secrets live in a container's config, so nothing short of a new container takes them back.
 */
import { projects as P } from "@dockify/contracts";
import { enqueuePreviewTx, type Db, type PreviewStatus, type Tx } from "@dockify/db";
import { appsHere } from "../server/apps-here.ts";
import { requestOver } from "../server/http-over.ts";
import type { Dialer, RouteStore } from "../server/runtime.ts";
import type { EdgeMode } from "../edge/ingress.ts";
import { buildCacheScope, isNotFound, isNotModified, type Builder, type ContainerSummary, type DockerApi } from "@dockify/engine";
import { removePreviewNetwork, type NetworkSweepDeps } from "../deploy/networks.ts";
import { networkOf, PREVIEW_LABEL, PREVIEW_DB_VOLUME_PREFIX, previewDbVolume, previewRouteId, previewWildcard, settlePreview } from "../deploy/preview.ts";
import { removeRoute, routedBackend, writeAsleepRoute, writeRoute } from "../deploy/routes.ts";
import { isBackendName, ridFor } from "../edge/routes.ts";

/** A teardown older than this is considered lost and queued again. */
export const STUCK_CLOSING_MS = 10 * 60_000;

const LIVE: readonly PreviewStatus[] = ["building", "ready", "asleep", "failed"];
/** Statuses whose containers stay (asleep keeps them stopped). */
const KEEPS_CONTAINERS: readonly PreviewStatus[] = [...LIVE, "closing"];

export interface PreviewFacts {
  id: string;
  status: PreviewStatus;
  projectEnabled: boolean;
  projectArchived: boolean;
  lastCommitAt: Date;
  lastRequestAt: Date | null;
  sleptAt: Date | null;
  updatedAt: Date;
  ttlHours: number;
  idleMinutes: number;
  cleanupQueued: boolean;
}

export type RetireReason = "ttl" | "disabled";
export interface ReconcilePlan {
  retire: Array<{ id: string; reason: RetireReason }>;
  sleep: string[];
  requeue: string[];
}

export const lastActivity = (r: Pick<PreviewFacts, "lastCommitAt" | "lastRequestAt">): number => Math.max(r.lastCommitAt.getTime(), r.lastRequestAt?.getTime() ?? 0);

/** `trafficKnown` is false when the proxy's request counters could not be read; nothing sleeps on a guess. */
export function planReconcile(rows: PreviewFacts[], now: Date, trafficKnown: boolean): ReconcilePlan {
  const plan: ReconcilePlan = { retire: [], sleep: [], requeue: [] };
  const t = now.getTime();
  for (const r of rows) {
    if (r.status === "closed") continue;
    if (r.status === "closing") {
      if (!r.cleanupQueued && t - r.updatedAt.getTime() >= STUCK_CLOSING_MS) plan.requeue.push(r.id);
      continue;
    }
    if (!r.projectEnabled || r.projectArchived) plan.retire.push({ id: r.id, reason: "disabled" });
    else if (t - r.lastCommitAt.getTime() >= r.ttlHours * 3600_000) plan.retire.push({ id: r.id, reason: "ttl" });
    else if (r.status === "ready" && trafficKnown && r.idleMinutes > 0 && t - lastActivity(r) >= r.idleMinutes * 60_000) plan.sleep.push(r.id);
  }
  return plan;
}

export interface DockerFacts {
  envs: Array<{ id: string; status: PreviewStatus; isolatedDb: boolean; members: string[] }>;
}

export function planDockerSweep(containers: ContainerSummary[], routeFiles: string[], facts: DockerFacts): { containers: string[]; routes: string[] } {
  const byEnv = new Map(facts.envs.map((e) => [e.id, e]));
  const removeContainers: string[] = [];
  for (const c of containers) {
    const envId = c.Labels[PREVIEW_LABEL.env];
    if (!envId) continue;
    const env = byEnv.get(envId);
    const role = c.Labels[PREVIEW_LABEL.role];
    const keep =
      !!env && KEEPS_CONTAINERS.includes(env.status) &&
      (role === "preview-db" ? env.isolatedDb : env.members.includes(c.Labels[PREVIEW_LABEL.member] ?? ""));
    if (!keep) removeContainers.push(c.Id);
  }
  const routed = new Set(
    facts.envs.filter((e) => e.status === "building" || e.status === "ready" || e.status === "failed" || e.status === "asleep").flatMap((e) => e.members.map((m) => `${ridFor(previewRouteId(m))}.yml`)),
  );
  const routes = routeFiles.filter((f) => f.startsWith("pv-") && f.endsWith(".yml") && !routed.has(f));
  return { containers: removeContainers, routes };
}

/** A deleted preview's cache mounts may take this long to go; the janitor's trim gets whatever does not. */
const SCOPE_PRUNE_TIMEOUT_MS = 2 * 60_000;

/** A building preview waits a pass (its new container may be starting); unknown networks are left alone. */
export function planIsolationDrift(containers: ContainerSummary[], envs: Array<{ id: string; status: PreviewStatus; network: string }>): { containers: string[]; rebuild: string[] } {
  const byEnv = new Map(envs.map((e) => [e.id, e]));
  const remove: string[] = [];
  const rebuild = new Set<string>();
  for (const c of containers) {
    const env = byEnv.get(c.Labels[PREVIEW_LABEL.env] ?? "");
    const role = c.Labels[PREVIEW_LABEL.role];
    const on = c.NetworkSettings?.Networks;
    if (!env || !on || (role !== "preview" && role !== "preview-db") || on[env.network]) continue;
    if (env.status !== "ready" && env.status !== "failed" && env.status !== "asleep") continue;
    remove.push(c.Id);
    if (env.status !== "asleep") rebuild.add(env.id);
  }
  return { containers: remove, rebuild: [...rebuild] };
}

export function parseRequestCounters(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("traefik_service_requests_total{")) continue;
    const m = /service="(pv-[0-9a-f-]{36})@file"[^}]*\}\s+([0-9.eE+]+)/.exec(line);
    if (!m) continue;
    out.set(m[1]!, (out.get(m[1]!) ?? 0) + Number(m[2]));
  }
  return out;
}

export type CounterSource = () => Promise<Map<string, number> | null>;

export function traefikCounters(dial: Dialer): CounterSource {
  return async () => {
    const socket = await dial({ proxy: 8082 }, { timeoutMs: 5_000 }).catch(() => null);
    if (!socket) return null;
    return new Promise((resolve) => {
      const req = requestOver(socket, { host: "dk-proxy", port: 8082, path: "/metrics", method: "GET", timeoutMs: 5_000 }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 8 * 1024 * 1024) req.destroy();
          else chunks.push(c);
        });
        res.on("end", () => resolve(res.statusCode === 200 ? parseRequestCounters(Buffer.concat(chunks).toString("utf8")) : null));
        res.on("error", () => resolve(null));
        // A cap reached ends the response without an "end".
        res.on("close", () => resolve(null));
      });
      req.on("error", () => resolve(null));
      req.end();
    });
  };
}

export interface PreviewRuntimeDeps {
  db: Db;
  docker: DockerApi;
  serverId: string;
  routes: RouteStore;
  mode: EdgeMode;
  proxyContainer: string;
  dashboardHost: string;
  counters?: CounterSource;
  stats?: (containerId: string) => Promise<{ cpuPct: number; memoryBytes: number } | null>;
  log?: (msg: string, extra?: object) => void;
  networks?: Pick<NetworkSweepDeps, "docker" | "ownContainers">;
  builder?: Pick<Builder, "pruneCacheScope">;
  now?: () => Date;
}

const clock = (deps: { now?: () => Date }): Date => deps.now?.() ?? new Date();

export class PreviewCleanupError extends Error {}

const previewIdOf = (payload: unknown): string => {
  const id = (payload as { previewId?: unknown } | null)?.previewId;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new PreviewCleanupError("preview job payload has no previewId");
  return id;
};

async function removeContainer(docker: DockerApi, id: string): Promise<void> {
  // Previews keep nothing: an image's anonymous volumes go with the container.
  await docker.removeContainer(id, { volumes: true }).catch((e: unknown) => {
    if (!isNotFound(e)) throw e;
  });
}

/** Stays while a rollback target or a preview with containers uses it; a closed preview's row does not count. */
export async function prunePreviewImages(db: Db, docker: DockerApi, deploymentIds: string[], serverId: string): Promise<number> {
  if (!deploymentIds.length) return 0;
  const mine = await db.deployment.findMany({ where: { id: { in: deploymentIds }, imageId: { not: null } }, select: { imageId: true } });
  const ids = [...new Set(mine.map((d) => d.imageId!))];
  if (!ids.length) return 0;
  const shared = new Set(
    (await db.deployment.findMany({
      where: { imageId: { in: ids }, id: { notIn: deploymentIds }, ...appsHere(serverId), OR: [{ previewId: null }, { preview: { env: { status: { in: [...KEEPS_CONTAINERS] } } } }] },
      select: { imageId: true },
    })).map((d) => d.imageId!),
  );
  let removed = 0;
  for (const id of ids) {
    if (shared.has(id)) continue;
    try {
      await docker.removeImage(id);
      removed++;
    } catch {
    }
  }
  return removed;
}

/** The preview_cleanup job. Safe to run twice: a closed preview is a no-op past the docker sweep. */
export async function runPreviewCleanup(deps: PreviewRuntimeDeps, payload: unknown): Promise<void> {
  const { db, docker } = deps;
  const id = previewIdOf(payload);
  const env = await db.previewEnv.findUnique({
    where: { id },
    select: { id: true, status: true, fromFork: true, apps: { select: { id: true, deployments: { select: { id: true } } } } },
  });
  // Containers by label first: they go even when the row is already gone. Then the database's volume,
  // which only a preview's cleanup or the reconcile ever removes.
  for (const c of await docker.listContainers({ [PREVIEW_LABEL.env]: id })) await removeContainer(docker, c.Id);
  await docker.removeVolume(previewDbVolume(id));
  // Neither of these can hold a teardown up: the sweep and the janitor's trim get what they leave.
  if (deps.networks) await removePreviewNetwork(deps.networks, id).catch((e: unknown) => deps.log?.("could not remove a preview's network", { id, error: e instanceof Error ? e.message : String(e) }));
  if (!env) return;
  for (const m of env.apps) await removeRoute(deps.routes, previewRouteId(m.id));
  const deploymentIds = env.apps.flatMap((m) => m.deployments.map((d) => d.id));
  // In-flight builds stop; the pipeline writes their terminal state.
  await db.deployment.updateMany({ where: { id: { in: deploymentIds }, status: { in: ["queued", "building", "deploying"] } }, data: { status: "cancelling" } });
  await db.previewDeployment.updateMany({ where: { envId: id }, data: { currentDeploymentId: null, containerId: null, cpuPct: null, memoryBytes: null } });
  // Images first, rows after: a crash in between leaves the row closing, and the next run retries.
  await prunePreviewImages(db, docker, deploymentIds, deps.serverId);
  if (deps.builder) await deps.builder.pruneCacheScope(buildCacheScope("", { envId: id, fromFork: env.fromFork }), SCOPE_PRUNE_TIMEOUT_MS).catch((e: unknown) => deps.log?.("could not reclaim a preview's build cache", { id, error: e instanceof Error ? e.message : String(e) }));
  if (env.status !== "closed") {
    await db.$transaction(async (tx) => {
      await tx.previewEnv.update({ where: { id }, data: { status: "closed", closedAt: clock(deps), notifiedKey: null } });
      await enqueuePreviewTx(tx, "preview_feedback", id);
    });
  }
}

/** Left by a row deleted with its project or a crash mid cleanup. A volume in use is left alone. */
export async function sweepPreviewDbVolumes(deps: { db: Db; serverId: string; docker: Pick<DockerApi, "removeVolume">; volumes: () => Promise<Array<{ Name: string; UsageData?: { RefCount?: number } | null }>> }): Promise<number> {
  const mine = (await deps.volumes()).filter((v) => v.Name.startsWith(PREVIEW_DB_VOLUME_PREFIX) && (v.UsageData?.RefCount ?? 0) === 0);
  if (!mine.length) return 0;
  const envs = await deps.db.previewEnv.findMany({ where: { status: { in: [...KEEPS_CONTAINERS] }, ...previewsHere(deps.serverId) }, select: { id: true } });
  const live = new Set(envs.map((e) => previewDbVolume(e.id)));
  let n = 0;
  for (const v of mine) {
    if (live.has(v.Name)) continue;
    await deps.docker.removeVolume(v.Name);
    n += 1;
  }
  return n;
}

/** The images and containers stay for a fast wake. */
export async function sleepPreview(deps: PreviewRuntimeDeps, id: string): Promise<void> {
  const { db, docker } = deps;
  const env = await db.previewEnv.findUnique({ where: { id }, select: { status: true, apps: { select: { id: true, hostname: true, app: { select: { port: true } } } } } });
  if (!env || env.status !== "ready") return;
  // A page that says so in place of the app: without a route the proxy answers a bare 404.
  for (const m of env.apps) {
    if (m.app.port === null) await removeRoute(deps.routes, previewRouteId(m.id));
    else await writeAsleepRoute(deps.routes, { appId: previewRouteId(m.id), hosts: [m.hostname], port: m.app.port, wildcard: previewWildcard(m.hostname) }, deps.dashboardHost, deps.mode);
  }
  for (const c of await docker.listContainers({ [PREVIEW_LABEL.env]: id })) {
    await docker.stopContainer(c.Id, 10).catch((e: unknown) => {
      if (!isNotModified(e) && !isNotFound(e)) throw e;
    });
  }
  // Only a preview still ready goes to sleep: a push (building) or a close that landed while the
  // containers stopped owns the row now, and its own job starts or removes what was stopped.
  await db.$transaction(async (tx) => {
    const slept = await tx.previewEnv.updateMany({ where: { id, status: "ready" }, data: { status: "asleep", sleptAt: clock(deps) } });
    if (!slept.count) return;
    await tx.previewDeployment.updateMany({ where: { envId: id }, data: { cpuPct: 0, memoryBytes: 0 } });
    await enqueuePreviewTx(tx, "preview_feedback", id);
  });
}

async function queueMemberBuild(tx: Tx, m: { id: string; appId: string; app: { serverId: string } }, env: { commitSha: string | null; branch: string; title: string; fromFork: boolean }, at: Date): Promise<void> {
  const now = at.toISOString();
  const key = `deploy:preview:${m.id}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  const dep = await tx.deployment.create({
    data: {
      appId: m.appId, serverId: m.app.serverId, previewId: m.id, trigger: "preview", branch: env.branch, commitSha: env.commitSha, message: env.title, fromFork: env.fromFork,
      actorType: "system", actorName: "Dockify", steps: [{ id: "queued", status: "done", startedAt: now, finishedAt: now }],
    },
    select: { id: true },
  });
  await tx.job.create({ data: { kind: "deploy", lane: "deploy", serverId: m.app.serverId, payload: { deploymentId: dep.id, appId: m.appId, previewId: m.id }, dedupeKey: key } });
}

/**
 * The new build is queued first, so a crash leaves a preview that is building, not a ready one with
 * nothing behind it. The old containers then go at once: a build that fails for want of a secret must
 * not leave the old container, secret and all, answering at the preview's URL.
 */
export async function correctIsolation(deps: PreviewRuntimeDeps, containers: ContainerSummary[], now: Date): Promise<{ containers: number; rebuilt: string[] }> {
  const { db } = deps;
  const rows = await db.previewEnv.findMany({
    where: { status: { in: ["ready", "failed", "asleep"] }, ...previewsHere(deps.serverId) },
    select: { id: true, status: true, fromFork: true, baseEnvironmentId: true, baseEnvironment: { select: { name: true } }, project: { select: { previewProductionAccess: true, environments: { select: { id: true } } } } },
  });
  const plan = planIsolationDrift(containers, rows.map((r) => ({ id: r.id, status: r.status, network: networkOf(P.previewIsolation(r), r.id, r.baseEnvironmentId) })));
  for (const id of plan.rebuild) {
    const env = await db.previewEnv.findUnique({ where: { id }, select: { commitSha: true, branch: true, title: true, fromFork: true, apps: { select: { id: true, appId: true, app: { select: { serverId: true } } } } } });
    if (!env) continue;
    // A route left behind answers 502 until the new one replaces it, so it never stops the rest.
    for (const m of env.apps) await removeRoute(deps.routes, previewRouteId(m.id)).catch(() => {});
    await db.$transaction(async (tx) => {
      // A push or a wake that got in first owns the build; it reads the setting when it starts.
      const moved = await tx.previewEnv.updateMany({ where: { id, status: { in: ["ready", "failed"] } }, data: { status: "building", error: null } });
      if (!moved.count) return;
      await tx.previewDeployment.updateMany({ where: { envId: id }, data: { currentDeploymentId: null, containerId: null, cpuPct: null, memoryBytes: null } });
      for (const m of env.apps) {
        const busy = await tx.deployment.findFirst({ where: { previewId: m.id, status: { in: ["queued", "building", "deploying", "cancelling"] } }, select: { id: true } });
        if (!busy) await queueMemberBuild(tx, m, env, now);
      }
      await enqueuePreviewTx(tx, "preview_feedback", id);
    });
  }
  for (const id of plan.containers) await removeContainer(deps.docker, id);
  return { containers: plan.containers.length, rebuilt: plan.rebuild };
}

/** A container that is gone (pruned, removed by hand) cannot be started, so that app is built again. */
export async function runPreviewWake(deps: PreviewRuntimeDeps, payload: unknown): Promise<void> {
  const { db, docker } = deps;
  const id = previewIdOf(payload);
  const env = await db.previewEnv.findUnique({
    where: { id },
    select: {
      status: true, commitSha: true, branch: true, title: true, isolatedDb: true, fromFork: true, baseEnvironmentId: true,
      apps: { select: { id: true, appId: true, hostname: true, containerId: true, app: { select: { port: true, serverId: true } } } },
    },
  });
  if (!env || (env.status !== "asleep" && env.status !== "ready")) return;
  const containers = await docker.listContainers({ [PREVIEW_LABEL.env]: id });
  const db_ = containers.find((c) => c.Labels[PREVIEW_LABEL.role] === "preview-db");
  if (db_) await docker.startContainer(db_.Id).catch((e: unknown) => { if (!isNotModified(e)) throw e; });
  const rebuild: Array<{ id: string; appId: string; app: { serverId: string } }> = [];
  for (const m of env.apps) {
    const c = containers.find((x) => x.Id === m.containerId) ?? containers.find((x) => x.Labels[PREVIEW_LABEL.member] === m.id && x.Labels[PREVIEW_LABEL.role] === "preview");
    if (!c) {
      rebuild.push(m);
      continue;
    }
    await docker.startContainer(c.Id).catch((e: unknown) => { if (!isNotModified(e)) throw e; });
    const info = await docker.inspectContainer(c.Id);
    const network = Object.keys(info.NetworkSettings.Networks)[0];
    // The route names the container (its name is also its alias), never the address it woke on.
    const backend = (info.Name ?? "").replace(/^\//, "");
    if (!isBackendName(backend)) {
      rebuild.push(m);
      continue;
    }
    if (m.app.port !== null && network && info.NetworkSettings.Networks[network]?.IPAddress) {
      await docker.connectNetwork(network, deps.proxyContainer);
      await writeRoute(deps.routes, { appId: previewRouteId(m.id), hosts: [m.hostname], port: m.app.port, backend, wildcard: previewWildcard(m.hostname), gateId: m.id }, deps.dashboardHost, deps.mode);
    }
  }
  await db.$transaction(async (tx) => {
    for (const m of rebuild) await queueMemberBuild(tx, m, env, clock(deps));
    // Woken counts as activity, so it does not fall asleep again on the next pass.
    await tx.previewEnv.update({ where: { id }, data: { status: rebuild.length ? "building" : "ready", sleptAt: null, lastRequestAt: clock(deps) } });
    await enqueuePreviewTx(tx, "preview_feedback", id);
  });
}

/** A preview with no member app can still be closed here; the rows guard against doing that twice. */
const previewsHere = (serverId: string) => ({ OR: [{ apps: { some: { app: appsHere(serverId) } } }, { apps: { none: {} } }] });

export interface ReconcileReport {
  retired: Array<{ id: string; reason: RetireReason }>;
  slept: string[];
  requeued: string[];
  containersRemoved: number;
  routesRemoved: number;
}

/** Gives a route written without a gate its gate; only a container-name backend is carried over. */
export async function gateOlderRoutes(deps: Pick<PreviewRuntimeDeps, "db" | "serverId" | "routes" | "mode" | "dashboardHost" | "log">): Promise<void> {
  const rows = await deps.db.previewDeployment.findMany({
    where: { env: { status: { in: ["building", "ready", "failed"] } }, currentDeploymentId: { not: null }, app: appsHere(deps.serverId) },
    select: { id: true, hostname: true, app: { select: { port: true } } },
  });
  for (const m of rows) {
    if (m.app.port === null) continue;
    const backend = await routedBackend(deps.routes, previewRouteId(m.id));
    if (!backend || !isBackendName(backend)) continue;
    await writeRoute(deps.routes, { appId: previewRouteId(m.id), hosts: [m.hostname], port: m.app.port, backend, wildcard: previewWildcard(m.hostname), gateId: m.id }, deps.dashboardHost, deps.mode)
      .catch((e: unknown) => deps.log?.("preview route refresh failed", { id: m.id, error: e instanceof Error ? e.message : String(e) }));
  }
}

export async function reconcilePreviews(deps: PreviewRuntimeDeps, now = clock(deps)): Promise<ReconcileReport> {
  const { db, docker, serverId } = deps;
  const rows = await db.previewEnv.findMany({
    where: { status: { not: "closed" }, ...previewsHere(serverId) },
    select: {
      id: true, status: true, lastCommitAt: true, lastRequestAt: true, sleptAt: true, updatedAt: true, requestCount: true,
      project: { select: { previewEnabled: true, archivedAt: true, previewTtlHours: true, previewIdleMinutes: true } },
      apps: { select: { id: true, containerId: true } },
    },
  });

  // A counter that moved since the last pass is a request. A closing or blocked preview is skipped:
  // writing its row would restart the clock (updatedAt) that finds a stuck cleanup.
  const counters = deps.counters ? await deps.counters().catch(() => null) : null;
  if (counters) {
    for (const r of rows) {
      if (r.status === "closing" || r.status === "blocked") continue;
      const total = r.apps.reduce((a, m) => a + (counters.get(previewRouteId(m.id)) ?? 0), 0);
      const prev = r.requestCount === null ? null : Number(r.requestCount);
      if (prev === null || total !== prev) {
        const moved = prev !== null && total > prev;
        await db.previewEnv.update({ where: { id: r.id }, data: { requestCount: BigInt(Math.round(total)), ...(moved ? { lastRequestAt: now } : {}) } });
        if (moved) r.lastRequestAt = now;
      }
    }
  }

  const open = new Set(
    (await db.job.findMany({ where: { dedupeKey: { in: rows.map((r) => `preview_cleanup:${r.id}`) }, completedAt: null, failedAt: null }, select: { dedupeKey: true } })).map((j) => j.dedupeKey),
  );
  const plan = planReconcile(rows.map((r) => ({
    id: r.id, status: r.status, projectEnabled: r.project.previewEnabled, projectArchived: r.project.archivedAt !== null,
    lastCommitAt: r.lastCommitAt, lastRequestAt: r.lastRequestAt, sleptAt: r.sleptAt, updatedAt: r.updatedAt,
    ttlHours: r.project.previewTtlHours, idleMinutes: r.project.previewIdleMinutes, cleanupQueued: open.has(`preview_cleanup:${r.id}`),
  })), now, counters !== null);

  for (const item of plan.retire) {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('preview:server'))`;
      const row = await tx.previewEnv.findUnique({ where: { id: item.id }, select: { status: true } });
      if (!row || row.status === "closed" || row.status === "closing") return;
      if (row.status === "blocked") await tx.previewEnv.update({ where: { id: item.id }, data: { status: "closed", reason: item.reason, closedAt: now } });
      else {
        await tx.previewEnv.update({ where: { id: item.id }, data: { status: "closing", reason: item.reason } });
        await enqueuePreviewTx(tx, "preview_cleanup", item.id, serverId);
      }
      await enqueuePreviewTx(tx, "preview_feedback", item.id);
    });
  }
  for (const id of plan.requeue) await db.$transaction(async (tx) => enqueuePreviewTx(tx, "preview_cleanup", id, serverId));
  for (const id of plan.sleep) await sleepPreview(deps, id).catch((e: unknown) => deps.log?.("preview sleep failed", { id, error: e instanceof Error ? e.message : String(e) }));

  if (deps.stats) {
    for (const r of rows) {
      if (r.status !== "ready" && r.status !== "failed" && r.status !== "building") continue;
      for (const m of r.apps) {
        if (!m.containerId) continue;
        const s = await deps.stats(m.containerId).catch(() => null);
        if (s) await db.previewDeployment.update({ where: { id: m.id }, data: { cpuPct: s.cpuPct, memoryBytes: BigInt(Math.round(s.memoryBytes)), sampledAt: now } });
      }
    }
  }

  const envs = await db.previewEnv.findMany({ where: { status: { not: "closed" }, ...previewsHere(serverId) }, select: { id: true, status: true, isolatedDb: true, apps: { select: { id: true } } } });
  let containers = await docker.listContainers({ "dockify.managed": "true" });
  // Never lets the rest of the pass go: a stuck preview must still be swept.
  const corrected = await correctIsolation(deps, containers, now).catch((e: unknown) => {
    deps.log?.("preview isolation check failed", { error: e instanceof Error ? e.message : String(e) });
    return null;
  });
  if (corrected?.containers) containers = await docker.listContainers({ "dockify.managed": "true" });
  const sweep = planDockerSweep(containers, Object.keys(await deps.routes.snapshot()), { envs: envs.map((e) => ({ id: e.id, status: e.status, isolatedDb: e.isolatedDb, members: e.apps.map((a) => a.id) })) });
  for (const id of sweep.containers) await removeContainer(docker, id);
  for (const f of sweep.routes) await removeRoute(deps.routes, f.replace(/\.yml$/, ""));

  await gateOlderRoutes(deps);

  // Settle anything a crash left building with nothing in flight.
  for (const r of rows.filter((x) => x.status === "building")) await settlePreview(db, r.id).catch(() => {});
  return { retired: plan.retire, slept: plan.sleep, requeued: plan.requeue, containersRemoved: sweep.containers.length, routesRemoved: sweep.routes.length };
}

export async function previewRouteIds(db: Db): Promise<string[]> {
  const rows = await db.previewDeployment.findMany({ where: { env: { status: { in: ["building", "ready", "failed", "asleep"] } } }, select: { id: true } });
  return rows.map((r) => previewRouteId(r.id));
}

/** CPU percent of one core count and memory from one stats read, the same arithmetic as docker stats. */
export function statsOf(s: { cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number }; precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number }; memory_stats?: { usage?: number; stats?: { inactive_file?: number } } }): { cpuPct: number; memoryBytes: number } {
  const cpu = (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sys = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats?.online_cpus ?? 1;
  const cpuPct = cpu > 0 && sys > 0 ? Math.round((cpu / sys) * cpus * 1000) / 10 : 0;
  const memoryBytes = Math.max(0, (s.memory_stats?.usage ?? 0) - (s.memory_stats?.stats?.inactive_file ?? 0));
  return { cpuPct, memoryBytes };
}
