// The route policy table already decided who may call each route. These handlers add the checks
// that need the row. The api never touches a container: start, stop and restart are worker jobs.
import { actorFields, meta } from "../../actor.ts";
import { requireActor } from "../../actor.ts";
import os from "node:os";
import type { FastifyRequest } from "fastify";
import { createHttpClient, type HttpClient } from "@dockify/net-guard";
import type { Prisma } from "@dockify/db";
import { enqueueTx } from "@dockify/db";
import { assertProjectScope, readsCommands, type Actor } from "../../actor.ts";
import { loadPeople } from "../../actor-view.ts";
import type { Ctx, Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError, isUniqueViolation } from "../../errors.ts";
import { appShowing, nameShownElsewhere, storedDisplayName } from "./display-name.ts";
import { assertNoDeployInFlight } from "../deployments/enqueue.ts";
import { IN_FLIGHT } from "../deployments/mapping.ts";
import { configOf, findIntegration } from "../integrations/store.ts";
import { enqueueVercelMirror, enqueueVercelSync, importGate, TOKEN_DEAD, vercelApiFor } from "../integrations/vercel.ts";
import { appLabel, defaultCpuCores, projects as P } from "@dockify/contracts";
import { DEFAULT_MEMORY_MB, DEFAULT_PIDS } from "../observe/metrics.ts";
import { imageProblem } from "../projects/handlers.ts";
import { enqueueRemovals } from "../projects/jobs.ts";
import { secretIdsFor } from "../projects/env-store.ts";
import { recentDeployment } from "../projects/views.ts";
import { assertVersionChangeAllowsDelete, moveLinksBeforeDelete } from "../resources/service-version.ts";
import { configUpdate, targetPlan, healthOf, STATEFUL, limitsOf, publicUrlOf, settingsOf, settingsUpdate, withoutCommands, zeroDowntimeOf, type Change, type Refusal } from "./views.ts";

export type PowerOp = "start" | "stop" | "restart";

const ROW = {
  id: true, name: true, displayName: true, kind: true, status: true, desiredState: true, image: true, gitRepository: true, gitBranch: true, gitRepoId: true, deployTarget: true, vercelProjectId: true, vercelFollowOnly: true,
  builder: true, rootDir: true, dockerfilePath: true, installCommand: true, buildCommand: true, startCommand: true, releaseCommand: true,
  port: true, healthCheckPath: true, healthExpectedStatus: true, healthTimeoutSeconds: true, healthGraceSeconds: true, healthIntervalSeconds: true,
  replicas: true, cpuLimit: true, memoryLimitMb: true, pidsLimit: true, capAdd: true, sysctls: true,
  currentDeploymentId: true, environmentId: true, serverId: true,
  primaryDomain: { select: { hostname: true } },
  domains: { orderBy: { createdAt: "asc" }, take: 1, select: { hostname: true } },
  environment: { select: { name: true, projectId: true, project: { select: { slug: true, gitRepoId: true, _count: { select: { environments: true } } } } } },
  _count: { select: { volumes: true } },
} as const satisfies Prisma.AppSelect;

type Row = Prisma.AppGetPayload<{ select: typeof ROW }>;

const label = (a: Row) => P.placeLabel(a.environment.project.slug, a.environment.name, a.environment.project._count?.environments, a.name);
const notFound = () => new HttpError(404, "App not found", "NOT_FOUND");
const refused = (r: Refusal[]) => new HttpError(400, r[0]?.reason ?? "Refused", "REFUSED", { field: r[0]?.field, refusals: r });

async function loadRow(ctx: Ctx, actor: Actor, id: string): Promise<Row> {
  const app = await ctx.db.app.findUnique({ where: { id }, select: ROW });
  if (!app) throw notFound();
  assertProjectScope(actor, app.environment.projectId);
  return app;
}

let vercelHttp: HttpClient | undefined;

/**
 * The last day hourly. A fresh app has no hourly rollups yet, so it falls back to five-minute rows,
 * then to the raw samples of the last hour, instead of showing an empty chart.
 */
async function usageSeries(ctx: Ctx, appId: string, now: number) {
  const select = { at: true, cpuPct: true, memoryBytes: true } as const;
  const day = new Date(now - 24 * 3_600_000);
  const hourly = await ctx.db.metricSample.findMany({ where: { appId, resolution: "hour", at: { gte: day } }, orderBy: { at: "asc" }, take: 24, select });
  if (hourly.length >= 2) return hourly;
  const fine = await ctx.db.metricSample.findMany({ where: { appId, resolution: "five_min", at: { gte: day } }, orderBy: { at: "desc" }, take: 48, select });
  if (fine.length >= 2) return fine.reverse();
  const raw = await ctx.db.metricSample.findMany({ where: { appId, resolution: "raw", at: { gte: new Date(now - 3_600_000) } }, orderBy: { at: "desc" }, take: 60, select });
  return raw.length >= 2 ? raw.reverse() : hourly;
}

const targetOf = (a: Pick<Row, "deployTarget" | "vercelProjectId" | "vercelFollowOnly">) => ({
  kind: a.deployTarget,
  vercelProjectId: a.vercelProjectId,
  ...(a.deployTarget === "vercel" ? { mode: a.vercelFollowOnly ? ("follow" as const) : ("deploy" as const) } : {}),
});

async function appDetail(ctx: Ctx, a: Row, viewer: Actor) {
  const now = Date.now();
  const [deployments, latest, hourly] = await Promise.all([
    ctx.db.deployment.findMany({ where: { appId: a.id, previewId: null }, orderBy: { createdAt: "desc" }, take: 10 }),
    ctx.db.metricSample.findFirst({ where: { appId: a.id, resolution: "raw", at: { gte: new Date(now - 120_000) } }, orderBy: { at: "desc" }, select: { cpuPct: true, memoryBytes: true } }),
    usageSeries(ctx, a.id, now),
  ]);
  const people = await loadPeople(ctx.db, viewer, deployments);
  const up = a.status === "running" || a.status === "degraded";
  const desired = a.deployTarget === "server" && a.desiredState === "running" ? a.replicas : 0;
  const memoryLimitBytes = (a.memoryLimitMb ?? DEFAULT_MEMORY_MB) * 1024 * 1024;
  // A Viewer and an API token never see the terminal, so neither is even told about the switch.
  const mayOpen = viewer.kind === "session" && viewer.role === "admin" && a.deployTarget === "server";
  const terminal = mayOpen && ((await ctx.db.instance.findUnique({ where: { id: 1 }, select: { terminalEnabled: true } }))?.terminalEnabled ?? false);
  return {
    id: a.id,
    terminal,
    name: a.name,
    ...(a.displayName ? { displayName: a.displayName } : {}),
    kind: a.kind,
    status: a.status,
    projectId: a.environment.projectId,
    projectSlug: a.environment.project.slug,
    environment: a.environment.name,
    url: publicUrlOf(a.primaryDomain, a.domains),
    image: a.image,
    repo: a.gitRepository,
    branch: a.gitRepository ? a.gitBranch : null,
    target: targetOf(a),
    replicas: { desired, running: up ? Math.min(desired, a.replicas) : 0 },
    // Container ports only: Dockify never publishes one on the host.
    ports: a.port ? [{ container: a.port, host: null, protocol: "tcp" as const }] : [],
    settings: readsCommands(viewer) ? settingsOf(a) : withoutCommands(settingsOf(a)),
    ...(up ? { usage: { cpuPct: latest ? Math.round(latest.cpuPct * 10) / 10 : 0, memoryBytes: latest ? Number(latest.memoryBytes) : 0, memoryLimitBytes } } : {}),
    ...(hourly.length ? { metrics: hourly.map((m) => ({ at: m.at.toISOString(), cpuPct: Math.round(m.cpuPct * 10) / 10, memoryBytes: Number(m.memoryBytes) })) } : {}),
    deployments: deployments.map((d) => recentDeployment(d, { id: a.id, name: a.name, displayName: a.displayName, kind: a.kind, repo: a.gitRepository, image: a.image }, a.environment.project.slug, a.environment.name, people)),
  };
}

interface SyncState {
  state?: unknown;
  at?: unknown;
  envVars?: unknown;
  lastDeploy?: { url?: unknown; state?: unknown; at?: unknown } | null;
  error?: unknown;
}

type SyncView = {
  state: "synced" | "pending" | "failed";
  at: string | null;
  envVars: number;
  lastDeploy: { url: string; state: "ready" | "building" | "error"; at: string } | null;
  error: string | null;
} | null;

const SYNC_STATES = new Set(["synced", "pending", "failed"]);
const DEPLOY_STATES = new Set(["ready", "building", "error"]);

function syncView(s: SyncState | undefined): SyncView {
  if (!s || typeof s.state !== "string" || !SYNC_STATES.has(s.state)) return null;
  const d = s.lastDeploy;
  const lastDeploy = d && typeof d.url === "string" && typeof d.state === "string" && DEPLOY_STATES.has(d.state) && typeof d.at === "string"
    ? { url: d.url, state: d.state as "ready" | "building" | "error", at: d.at }
    : null;
  return {
    state: s.state as "synced" | "pending" | "failed",
    at: typeof s.at === "string" ? s.at : null,
    envVars: typeof s.envVars === "number" ? s.envVars : 0,
    lastDeploy,
    error: typeof s.error === "string" ? s.error : null,
  };
}

/**
 * A Vercel outage leaves the project list empty, never the tab broken. Only an admin session sees
 * the whole account's project list; a viewer or a token gets the linked project alone.
 */
async function vercelOf(ctx: Ctx, a: Row, viewer: Actor) {
  if (a.kind !== "frontend") return null;
  const row = await findIntegration(ctx.db, "vercel");
  const connected = !!row && row.status !== "disconnected" && !!row.secretId;
  let projects: Array<{ id: string; name: string; framework: string | null }> = [];
  let projectsError: string | null = null;
  if (connected) {
    vercelHttp ??= createHttpClient();
    projects = await vercelApiFor(ctx.db, ctx.ring, vercelHttp)
      .then((api) => api.projects())
      .then((list) => list.filter((p) => viewer.role === "admin" && viewer.kind === "session" || p.id === a.vercelProjectId).map((p) => ({ id: p.id, name: p.name, framework: p.framework ?? null })))
      .catch((e: unknown) => {
        projectsError = e instanceof HttpError && e.code === "VERCEL_TOKEN" ? TOKEN_DEAD : e instanceof HttpError && e.status < 500 ? e.message : "Vercel did not answer, so its projects could not be listed. Try again shortly.";
        return [];
      });
  }
  const apps = row ? (configOf<{ apps?: Record<string, SyncState> }>(row).apps ?? {}) : {};
  return { connected, projects, projectsError, sync: a.deployTarget === "vercel" && !a.vercelFollowOnly ? syncView(apps[a.id]) : null };
}

async function appConfig(ctx: Ctx, a: Row, viewer: Actor) {
  return {
    health: healthOf(a),
    limits: limitsOf(a),
    defaults: { cpuCores: defaultCpuCores(os.cpus().length), memoryMb: DEFAULT_MEMORY_MB, pids: DEFAULT_PIDS },
    release: { command: readsCommands(viewer) ? (a.releaseCommand ?? "") : "" },
    zeroDowntime: zeroDowntimeOf(a.kind, a._count.volumes),
    target: a.kind === "frontend" ? targetOf(a) : null,
    vercel: await vercelOf(ctx, a, viewer),
  };
}

const VERB: Record<PowerOp, string> = { start: "started", stop: "stopped", restart: "restarted" };

/**
 * Records the desired state and queues the worker in one transaction, under the same per-app lock
 * a deploy takes, so a power change and a deploy can never interleave.
 */
async function power(ctx: Ctx, actor: Actor, id: string, op: PowerOp, req: FastifyRequest): Promise<undefined> {
  const a = await loadRow(ctx, actor, id);
  if (a.deployTarget !== "server") throw new HttpError(400, "This app deploys to Vercel, so nothing of it runs on this server", "NOT_ON_SERVER");
  if (op !== "stop" && !a.currentDeploymentId) throw new HttpError(409, "This app has not been deployed yet. Deploy it first.", "NOT_DEPLOYED");
  // The observe pass found no container: a job would only fail where nobody sees it.
  if (op !== "stop" && a.status === "missing") throw new HttpError(409, "This app has no container. Deploy it again.", "NO_CONTAINER");
  if (op === "restart" && a.desiredState === "stopped") throw new HttpError(409, "This app is stopped. Start it instead.", "APP_STOPPED");
  await ctx.db.$transaction(async (tx) => {
    const key = `deploy:${a.id}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const open = await tx.deployment.findFirst({ where: { appId: a.id, previewId: null, status: { in: IN_FLIGHT } }, select: { id: true } });
    const openJob = open ? null : await tx.job.findFirst({ where: { dedupeKey: key, completedAt: null, failedAt: null }, select: { id: true } });
    if (open || openJob) {
      throw new HttpError(409, "A deployment of this app is in progress. Wait for it, or cancel it first.", "DEPLOY_IN_FLIGHT", open ? { deploymentId: open.id } : {});
    }
    if (op !== "restart") await tx.app.update({ where: { id: a.id }, data: { desiredState: op === "stop" ? "stopped" : "running" } });
    await enqueueTx(tx, { kind: "app_power", lane: "deploy", serverId: a.serverId, payload: { appId: a.id, op }, dedupeKey: `app.power:${a.id}:${op}`, maxAttempts: 3 });
    await audit(tx, { category: "deploys", action: `app.${op}`, verb: VERB[op], ...actorFields(actor), targetType: "app", targetId: a.id, targetLabel: label(a), ...meta(req) });
  });
  return undefined;
}

const changesJson = (c: Change[]) => c as unknown as Prisma.InputJsonValue;

export const appLifecycleHandlers: Handlers = {
  "apps.get": async ({ params, actor, ctx }) => {
    const a = requireActor(actor);
    return appDetail(ctx, await loadRow(ctx, a, params.id), a);
  },

  "apps.patch": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const app = await loadRow(ctx, a, params.id);
    const { data, refusals, changes } = settingsUpdate(app, body.settings, body.advanced, body.source);
    if (refusals.length) throw refused(refusals);
    // Only a new image: saving other settings must not depend on what DNS answers today.
    if (typeof data.image === "string" && data.image !== app.image) {
      const problem = await imageProblem(data.image);
      if (problem) throw refused([{ field: "source.image", reason: problem }]);
    }
    if (changes.length) {
      await ctx.db.$transaction(async (tx) => {
        await tx.app.update({ where: { id: app.id }, data });
        await audit(tx, {
          category: "config", action: "app.update", verb: "changed the settings of", ...actorFields(a), targetType: "app", targetId: app.id,
          targetLabel: label(app), suffix: "(applies on the next deploy)", changes: changesJson(changes), ...meta(req),
        });
      });
    }
    return appDetail(ctx, await loadRow(ctx, a, params.id), a);
  },

  // Changes only the name people read. `name` stays, so no container, volume, alias, route or link notices.
  "apps.rename": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const app = await loadRow(ctx, a, params.id);
    const next = storedDisplayName(app.name, body.displayName);
    if (next !== app.displayName) {
      try {
        await ctx.db.$transaction(async (tx) => {
          // One rename per environment at a time, so the check below sees every other one.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`app-name:${app.environmentId}`}))`;
          if (next !== null) {
            const other = await appShowing(tx, app.environmentId, [next], app.id);
            if (other) throw nameShownElsewhere(next, other);
          }
          await tx.app.update({ where: { id: app.id }, data: { displayName: next } });
          await audit(tx, {
            category: "config", action: "app.rename", verb: "renamed", ...actorFields(a), targetType: "app", targetId: app.id, targetLabel: label(app),
            suffix: `from ${appLabel(app)} to ${appLabel({ name: app.name, displayName: next })}`,
            changes: changesJson([{ key: "displayName", before: app.displayName, after: next }]), ...meta(req),
          });
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw nameShownElsewhere(next ?? app.name, null);
        throw e;
      }
    }
    return appDetail(ctx, await loadRow(ctx, a, params.id), a);
  },

  "apps.delete": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const app = await loadRow(ctx, a, params.id);
    if (body.confirm !== app.name) throw new HttpError(400, `Type ${app.name} to confirm`, "CONFIRM_MISMATCH", { field: "confirm" });
    await ctx.db.$transaction(async (tx) => {
      await assertVersionChangeAllowsDelete(tx, app.id);
      await moveLinksBeforeDelete(tx, ctx.ring, app.id, a);
      await assertNoDeployInFlight(tx, [app.id]);
      // Queued before the rows go: the teardown job's payload is read from them.
      await enqueueRemovals(tx, [app.id], app.environment.projectId);
      const secretIds = await secretIdsFor(tx, { environmentIds: [], appIds: [app.id] });
      await tx.app.delete({ where: { id: app.id } });
      if (secretIds.length) await tx.secret.deleteMany({ where: { id: { in: secretIds } } });
      await audit(tx, {
        category: "config", action: "app.delete", verb: "deleted app", ...actorFields(a), targetType: "app", targetId: app.id, targetLabel: label(app),
        ...(STATEFUL.has(app.kind) ? { suffix: "(its backups stay in the bucket as orphans)" } : {}), ...meta(req),
      });
    });
    return undefined;
  },

  "apps.start": async ({ params, actor, ctx, req }) => power(ctx, requireActor(actor), params.id, "start", req),
  "apps.stop": async ({ params, actor, ctx, req }) => power(ctx, requireActor(actor), params.id, "stop", req),
  "apps.restart": async ({ params, actor, ctx, req }) => power(ctx, requireActor(actor), params.id, "restart", req),

  "apps.config.get": async ({ params, actor, ctx }) => appConfig(ctx, await loadRow(ctx, requireActor(actor), params.id), requireActor(actor)),

  "apps.config.patch": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const app = await loadRow(ctx, a, params.id);
    const { data, refusals, changes } = configUpdate({ ...app, gitRepoId: app.gitRepoId ?? app.environment.project.gitRepoId }, body);
    if (refusals.length) throw refused(refusals);
    const toVercel = body.target?.kind === "vercel" && app.deployTarget !== "vercel";
    const leavesServer = body.target && body.target.kind !== app.deployTarget && app.deployTarget === "server";
    if (leavesServer && app.desiredState === "running" && app.currentDeploymentId) {
      throw new HttpError(409, "This app is running on this server. Stop it before moving it to Vercel.", "STOP_FIRST", { field: "target" });
    }
    if (toVercel) {
      const row = await findIntegration(ctx.db, "vercel");
      if (!row || row.status === "disconnected" || !row.secretId) throw new HttpError(409, "Connect Vercel in Settings first", "NOT_CONNECTED", { field: "target" });
    }
    // Sending variables and secrets to Vercel is the owner's explicit call, every time it begins.
    const plan = body.target ? targetPlan(app, body.target) : null;
    if (plan?.startsPushing) {
      importGate(a)(true);
      if (!body.confirmSendSecrets) throw new HttpError(409, "This sends the app's variables and secrets to Vercel. Confirm it to go on.", "CONFIRM_SEND_SECRETS", { field: "target" });
    }
    if (changes.length) {
      await ctx.db.$transaction(async (tx) => {
        await tx.app.update({ where: { id: app.id }, data });
        if (plan?.startsPushing) {
          await audit(tx, {
            category: "access", action: "app.vercel.sendSecrets", verb: "allowed sending variables and secrets to Vercel for", ...actorFields(a), targetType: "app", targetId: app.id,
            targetLabel: label(app), suffix: body.target?.vercelProjectId ?? null, ...meta(req),
          });
        }
        await audit(tx, {
          category: "config", action: "app.config", verb: "changed the deploy config of", ...actorFields(a), targetType: "app", targetId: app.id,
          targetLabel: label(app), changes: changesJson(changes), ...meta(req),
        });
      });
      // A new Vercel target gets the env pushed right away; the first deploy is the owner's call.
      if (plan?.startsPushing) await enqueueVercelSync(ctx.db, app.id, "sync_env");
      if (body.target?.kind === "vercel" && (toVercel || body.target.vercelProjectId !== app.vercelProjectId)) await enqueueVercelMirror(ctx.db, body.target.vercelProjectId);
    }
    return appConfig(ctx, await loadRow(ctx, a, params.id), a);
  },
};
