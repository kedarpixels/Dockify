// GET lists every container on the server as a resource row with its latest live sample. POST creates a bare Postgres or Redis exactly as New app creates a service.
import { defaultCpuCores, projects as P } from "@dockify/contracts";
import os from "node:os";
import type { Db, Prisma } from "@dockify/db";
import { assertProjectScope } from "../../actor.ts";
import type { Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError, unauthenticated } from "../../errors.ts";
import { enqueueDeployment } from "../deployments/index.ts";
import { projectLimit } from "../observe/scope.ts";
import { SERVICE_DEFAULT_VERSION, STORAGE_UNAVAILABLE, type AppSpec } from "../projects/app-source.ts";
import { createApps } from "../projects/handlers.ts";

const DEFAULT_MEMORY_MB = 512;
const FRESH_MS = 120_000;

type AppRow = Prisma.AppGetPayload<{
  include: {
    environment: { select: { name: true; project: { select: { id: true; slug: true } } } };
    volumes: { select: { name: true; sizeBytes: true } };
  };
}>;

const STATEFUL = new Set(["postgres", "redis", "s3"]);
/** The statuses whose container is up, so its start time is an uptime. */
const UP = new Set(["running", "degraded"]);

/** A service's version from the tag it runs: "postgres:16-alpine" is "16", "redis:7.4-alpine" is "7.4". */
export function serviceVersionOf(image: string | null): string | undefined {
  return image ? /:(\d+(?:\.\d+)*)(?:-|$|@)/.exec(image)?.[1] : undefined;
}

export function toResourceRow(app: AppRow, sample: { cpuPct: number | null; memoryBytes: bigint | null } | undefined) {
  const volume = app.volumes[0];
  const version = STATEFUL.has(app.kind) ? serviceVersionOf(app.image) : undefined;
  return {
    id: app.id,
    name: app.name,
    ...(app.displayName ? { displayName: app.displayName } : {}),
    kind: app.kind,
    status: app.status,
    projectId: app.environment.project.id,
    projectSlug: app.environment.project.slug,
    environment: app.environment.name,
    image: app.image ?? "",
    ...(version ? { version } : {}),
    cpu: { usedPct: sample?.cpuPct ? Math.round(sample.cpuPct * 10) / 10 : 0, limitCores: app.cpuLimit ?? defaultCpuCores(os.cpus().length) },
    memory: {
      usedBytes: sample?.memoryBytes ? Number(sample.memoryBytes) : 0,
      reservedBytes: (app.memoryLimitMb ?? DEFAULT_MEMORY_MB) * 1024 * 1024,
    },
    volume: volume ? { name: volume.name, sizeBytes: Number(volume.sizeBytes ?? 0n) } : null,
    // The container's own start time, which a restart or a crash resets. Null while the app is not up.
    startedAt: UP.has(app.status) && app.containerStartedAt ? app.containerStartedAt.toISOString() : null,
  };
}

const APP_INCLUDE = {
  environment: { select: { name: true, project: { select: { id: true, slug: true } } } },
  volumes: { select: { name: true, sizeBytes: true } },
} as const;

async function latestSamples(db: Db, appIds: string[], now: number): Promise<Map<string, { cpuPct: number | null; memoryBytes: bigint | null }>> {
  if (appIds.length === 0) return new Map();
  const rows = await db.metricSample.findMany({
    where: { appId: { in: appIds }, resolution: "raw", at: { gte: new Date(now - FRESH_MS) } },
    orderBy: { at: "desc" },
    select: { appId: true, cpuPct: true, memoryBytes: true },
  });
  const out = new Map<string, { cpuPct: number | null; memoryBytes: bigint | null }>();
  for (const r of rows) if (r.appId && !out.has(r.appId)) out.set(r.appId, { cpuPct: r.cpuPct, memoryBytes: r.memoryBytes });
  return out;
}

export const resourcesHandlers: Handlers = {
  "resources.list": async ({ actor, ctx }) => {
    const now = Date.now();
    const limit = projectLimit(actor);
    const where: Prisma.AppWhereInput = { environment: { project: { archivedAt: null, ...(limit ? { id: { in: limit } } : {}) } } };
    const apps = await ctx.db.app.findMany({
      where,
      include: APP_INCLUDE,
      orderBy: [{ environment: { project: { slug: "asc" } } }, { environment: { name: "asc" } }, { name: "asc" }],
      take: 1000,
    });
    const samples = await latestSamples(ctx.db, apps.map((a) => a.id), now);
    return apps.map((a) => toResourceRow(a, samples.get(a.id)));
  },

  "resources.create": async ({ body, actor, ctx, req }) => {
    if (!actor) throw unauthenticated();
    if (body.kind === "s3") throw new HttpError(400, STORAGE_UNAVAILABLE, "KIND_UNAVAILABLE", { field: "kind" });
    const project = await ctx.db.project.findUnique({ where: { id: body.projectId }, select: { id: true, slug: true, archivedAt: true, _count: { select: { environments: true } } } });
    if (!project || project.archivedAt) throw new HttpError(404, "Project not found", "NOT_FOUND", { field: "projectId" });
    assertProjectScope(actor, project.id);
    const kind = body.kind;
    const spec: AppSpec = { name: body.name, kind, source: { type: "service", service: kind, version: SERVICE_DEFAULT_VERSION[kind] }, target: "server" };
    const [id] = await createApps(ctx, actor, project, body.environment, [{ spec, name: body.name, kind }], req);
    // Provisioning is the service's first deploy, run by the worker's managed path.
    const by = {
      actorType: actor.kind === "token" ? ("token" as const) : ("user" as const),
      actorId: actor.kind === "token" ? actor.tokenId : actor.userId,
      actorName: actor.name,
    };
    await enqueueDeployment(ctx.db, id!, { trigger: actor.kind === "token" ? "api" : "manual", ...by });
    await audit(ctx.db, {
      category: "deploys", action: "app.deploy", verb: "deployed", ...by, targetType: "app", targetId: id!,
      targetLabel: P.placeLabel(project.slug, body.environment, project._count?.environments, body.name), ip: req.clientIp, userAgent: req.headers["user-agent"] ?? null,
    });
    const app = await ctx.db.app.findUniqueOrThrow({ where: { id: id! }, include: APP_INCLUDE });
    return toResourceRow(app, undefined);
  },
};
