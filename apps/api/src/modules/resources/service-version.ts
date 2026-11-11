// Changing a managed database's version. A downgrade is refused: data written by a newer server does not read back in an older one.
// Nothing here deletes data. The old service stays until its owner deletes it, and only then are its links rewritten to the new
// service, so no link is ever left pointing at something gone.
import { randomUUID } from "node:crypto";
import { apps as Ap, projects as P } from "@dockify/contracts";
import { enqueueTx, linkedApps, sealServiceCredentials, generateServiceCredentials, type Prisma, type Tx } from "@dockify/db";
import type { z } from "zod";
import { actorFields, assertProjectScope, meta, requireActor, type Actor } from "../../actor.ts";
import type { Ctx, Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError, isUniqueViolation } from "../../errors.ts";
import { dataPathFor, volumeNameFor } from "../backups/shared.ts";
import { requestDeployTx } from "../deployments/enqueue.ts";
import { SERVICE_IMAGES, SERVICE_PORTS } from "../projects/app-source.ts";
import { refValueFor, servicesOf, type ResolvedChange } from "../projects/env-model.ts";
import { applyChanges, loadEntries, loadScope } from "../projects/env-store.ts";
import { serviceVersionOf } from "./index.ts";
import { assertNoVersionChangeRunning, upgradeRunning } from "./version-running.ts";

type View = z.infer<typeof Ap.ServiceVersionView>;
type Option = z.infer<typeof Ap.ServiceVersionOption>;
type Kind = "postgres" | "redis";

const numeric = (v: string): number[] => v.split(".").map(Number);
function cmp(a: string, b: string): number {
  const [x, y] = [numeric(a), numeric(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * A newer Postgres major needs a new service, since its data directory does not open in a newer major.
 * A newer Redis reads an older snapshot, so it moves in place, with a dump first. An older version is never offered.
 */
export function versionOptions(kind: Kind, current: string | null): Option[] {
  if (!current) return [];
  return Object.keys(SERVICE_IMAGES[kind])
    .filter((v) => cmp(v, current) >= 0)
    .sort(cmp)
    .map((version) => ({ version, path: kind === "postgres" && cmp(version, current) > 0 ? ("new_service" as const) : ("in_place" as const) }));
}

/** The new service's name: <name>-pg17, cut to fit and made free. */
export function newServiceName(name: string, version: string, taken: ReadonlySet<string>): string {
  const suffix = `-pg${version}`;
  const base = `${name.replace(/-pg\d+$/, "").slice(0, 32 - suffix.length - 2).replace(/-+$/, "")}${suffix}`;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 10; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  throw new HttpError(409, "Could not find a free name for the new service", "NAME_TAKEN");
}

const asKind = (k: string): Kind => {
  if (k !== "postgres" && k !== "redis") throw new HttpError(400, "Only a managed Postgres or Redis has a version to change", "NOT_A_SERVICE");
  return k;
};

async function load(ctx: Ctx, a: Actor, id: string) {
  const app = await ctx.db.app.findUnique({ where: { id }, include: { environment: { include: { project: { select: { id: true, slug: true } } } } } });
  if (!app) throw new HttpError(404, "App not found", "NOT_FOUND");
  assertProjectScope(a, app.environment.projectId);
  asKind(app.kind);
  return app;
}
type Row = Awaited<ReturnType<typeof load>>;

const label = (app: Row) => `${app.environment.project.slug}/${app.environment.name}/${app.name}`;
const running = (ctx: Ctx | { db: Tx }, id: string) => upgradeRunning(ctx.db, id);

async function viewOf(ctx: Ctx, app: Row): Promise<View> {
  const kind = asKind(app.kind);
  const version = serviceVersionOf(app.image) ?? null;
  const raw = (app.serviceUpgrade ?? null) as Record<string, unknown> | null;
  const targetId = typeof raw?.targetId === "string" ? raw.targetId : null;
  const target = targetId ? await ctx.db.app.findUnique({ where: { id: targetId }, select: { id: true, name: true, displayName: true } }) : null;
  const redirect = app.serviceRedirectId ? await ctx.db.app.findUnique({ where: { id: app.serviceRedirectId }, select: { id: true, name: true, displayName: true } }) : null;
  // The new service was deleted by its owner: that change is over.
  const gone = !!targetId && !target;
  const job = await running(ctx, app.id);
  const counts = (v: unknown) => (v && typeof (v as { tables?: unknown }).tables === "number" ? (v as { tables: number; rows: number }) : null);
  return {
    kind, version, image: app.image ?? "", pin: app.pinnedImage ? (app.pinnedImage.split("@")[1] ?? null) : null,
    options: versionOptions(kind, version),
    linkedApps: await linkedApps(ctx.db, ctx.ring, app),
    redirect,
    busy: !!job,
    upgrade: raw && !gone && typeof raw.phase === "string"
      ? {
          phase: raw.phase as z.infer<typeof Ap.ServiceUpgradePhase>,
          toVersion: String(raw.toVersion ?? ""), fromVersion: String(raw.fromVersion ?? ""), at: String(raw.at ?? new Date(0).toISOString()),
          target, sourceCounts: counts(raw.source), targetCounts: counts(raw.target),
          copiedAt: typeof raw.copiedAt === "string" ? raw.copiedAt : null, error: typeof raw.error === "string" ? raw.error : null,
        }
      : null,
  };
}

const initial = (fromVersion: string, toVersion: string, targetId: string | null, phase: string) =>
  ({ phase, fromVersion, toVersion, targetId, at: new Date().toISOString(), source: null, target: null, copiedAt: null, error: null }) as unknown as Prisma.InputJsonValue;

export const serviceVersionHandlers: Handlers = {
  "apps.version.get": async ({ params, actor, ctx }) => viewOf(ctx, await load(ctx, requireActor(actor), params.id)),

  "apps.version.change": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const app = await load(ctx, a, params.id);
    if (body.confirm !== app.name) throw new HttpError(400, `Type ${app.name} to confirm`, "CONFIRM_MISMATCH", { field: "confirm" });
    if (app.serviceRedirectId) throw new HttpError(409, "The links of this service already lead to its newer copy. Change the version from there.", "ALREADY_SWITCHED");
    const kind = asKind(app.kind);
    const current = serviceVersionOf(app.image) ?? null;
    if (!current) throw new HttpError(409, "This service runs an image whose version Dockify cannot read", "VERSION_UNKNOWN");
    const toImage = SERVICE_IMAGES[kind][body.version];
    if (!toImage) throw new HttpError(400, `Supported ${kind} versions: ${Object.keys(SERVICE_IMAGES[kind]).join(", ")}`, "VERSION_UNKNOWN", { field: "version" });
    if (cmp(body.version, current) < 0) {
      throw new HttpError(409, `${kind === "postgres" ? "Postgres" : "Redis"} ${body.version} is older than the ${current} this runs. Going back means restoring a backup taken before the upgrade, into a new service.`, "DOWNGRADE_REFUSED", { field: "version" });
    }
    const option = versionOptions(kind, current).find((o) => o.version === body.version)!;

    await ctx.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dockify.backup:${app.id}`}))`;
      if (await running({ db: tx }, app.id)) throw new HttpError(409, "A version change of this service is already running", "BUSY");
      const other = await tx.job.findFirst({ where: { kind: { in: ["backup", "restore"] }, dedupeKey: { in: [`backup:${app.id}`, `restore:${app.id}`] }, completedAt: null, failedAt: null }, select: { kind: true } });
      if (other) throw new HttpError(409, `A ${other.kind} of this service is running; try again when it finishes`, "BUSY");

      if (option.path === "in_place") {
        await enqueueTx(tx, { kind: "service_upgrade", lane: "data", serverId: app.serverId, payload: { action: "in_place", sourceId: app.id, toImage, toVersion: body.version }, dedupeKey: `service-upgrade:${app.id}`, maxAttempts: 1 });
        await tx.app.update({ where: { id: app.id }, data: { serviceUpgrade: initial(current, body.version, null, "backing_up") } });
      } else {
        // One step of redirect only: a service its old copy still leads to moves on once that copy is deleted.
        const behind = await tx.app.findFirst({ where: { serviceRedirectId: app.id }, select: { name: true } });
        if (behind) throw new HttpError(409, `${behind.name}, the service this replaced, still exists. Delete it first, so its links become this service's own.`, "OLD_SERVICE_EXISTS");
        // A failed or stale copy at this same version is copied over again, into the same new service.
        const prior = (app.serviceUpgrade ?? null) as { targetId?: unknown; toVersion?: unknown } | null;
        const reuse = typeof prior?.targetId === "string" && prior.toVersion === body.version ? await tx.app.findUnique({ where: { id: prior.targetId }, select: { id: true } }) : null;
        const targetId = reuse?.id ?? (await createTarget(tx, ctx, app, kind, body.version, toImage));
        await enqueueTx(tx, { kind: "service_upgrade", lane: "data", serverId: app.serverId, payload: { action: "prepare", sourceId: app.id, targetId, toVersion: body.version }, dedupeKey: `service-upgrade:${app.id}`, maxAttempts: 1 });
        await tx.app.update({ where: { id: app.id }, data: { serviceUpgrade: initial(current, body.version, targetId, "backing_up") } });
      }
      await audit(tx, {
        category: "system", action: "service.version.change", verb: "started changing the version of", ...actorFields(a), targetType: "app", targetId: app.id, targetLabel: label(app),
        suffix: `from ${current} to ${body.version}, ${option.path === "in_place" ? "in place" : "through a new service"}`, ...meta(req),
      });
    }).catch((e: unknown) => {
      if (isUniqueViolation(e)) throw new HttpError(409, "A service with that name already exists", "NAME_TAKEN");
      throw e;
    });
    return viewOf(ctx, await load(ctx, a, params.id));
  },

  "apps.version.switch": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const app = await load(ctx, a, params.id);
    if (body.confirm !== app.name) throw new HttpError(400, `Type ${app.name} to confirm`, "CONFIRM_MISMATCH", { field: "confirm" });
    const state = (app.serviceUpgrade ?? null) as { phase?: unknown; failedAt?: unknown; targetId?: unknown } | null;
    const canRetry = state?.phase === "failed" && state.failedAt === "switch";
    if ((state?.phase !== "ready" && !canRetry) || typeof state?.targetId !== "string") throw new HttpError(409, "The copy is not ready to switch to", "NOT_READY");
    if (!(await ctx.db.app.findUnique({ where: { id: state.targetId }, select: { id: true } }))) throw new HttpError(409, "The new service no longer exists", "NOT_READY");
    await ctx.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dockify.backup:${app.id}`}))`;
      if (await running({ db: tx }, app.id)) throw new HttpError(409, "A version change of this service is already running", "BUSY");
      await enqueueTx(tx, { kind: "service_upgrade", lane: "data", serverId: app.serverId, payload: { action: "switch", sourceId: app.id, targetId: state.targetId as string }, dedupeKey: `service-upgrade:${app.id}`, maxAttempts: 1 });
      await tx.app.update({ where: { id: app.id }, data: { serviceUpgrade: { ...(app.serviceUpgrade as object), phase: "switching", error: null, at: new Date().toISOString() } as Prisma.InputJsonValue } });
      await audit(tx, { category: "system", action: "service.version.switch", verb: "started switching the linked apps of", ...actorFields(a), targetType: "app", targetId: app.id, targetLabel: label(app), ...meta(req) });
    });
    return viewOf(ctx, await load(ctx, a, params.id));
  },

  /** The way back: links lead to the old service again. Writes made since the switch are only in the new one, and the dialog says so. */
  "apps.version.back": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const app = await load(ctx, a, params.id);
    if (body.confirm !== app.name) throw new HttpError(400, `Type ${app.name} to confirm`, "CONFIRM_MISMATCH", { field: "confirm" });
    if (!app.serviceRedirectId) throw new HttpError(409, "This service's links already lead to it", "NOT_SWITCHED");
    const linked = await linkedApps(ctx.db, ctx.ring, app);
    await ctx.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dockify.backup:${app.id}`}))`;
      if (await running({ db: tx }, app.id)) throw new HttpError(409, "A version change of this service is already running", "BUSY");
      await tx.app.update({ where: { id: app.id }, data: { serviceRedirectId: null, serviceUpgrade: { ...(app.serviceUpgrade as object), phase: "ready", at: new Date().toISOString() } as Prisma.InputJsonValue } });
      for (const l of linked) {
        const cur = await tx.app.findUnique({ where: { id: l.id }, select: { desiredState: true, gitBranch: true, currentDeployment: { select: { imageId: true, imageRef: true, commitSha: true } } } });
        if (!cur?.currentDeployment || cur.desiredState !== "running") continue;
        await requestDeployTx(tx, l.id, {
          trigger: "redeploy", branch: cur.gitBranch, commitSha: cur.currentDeployment.commitSha, message: "Database switched back",
          imageId: cur.currentDeployment.imageId, imageRef: cur.currentDeployment.imageRef, ...actorFields(a),
        }, "coalesce");
      }
      await audit(tx, { category: "system", action: "service.version.back", verb: "switched the linked apps back to", ...actorFields(a), targetType: "app", targetId: app.id, targetLabel: label(app), suffix: `(${linked.length} redeploying)`, ...meta(req) });
    });
    return viewOf(ctx, await load(ctx, a, params.id));
  },
};

/** The new service, created as every service is, carrying the source's limits and backup schedule so it is never less protected. */
async function createTarget(tx: Prisma.TransactionClient, ctx: Ctx, app: Row, kind: Kind, version: string, image: string): Promise<string> {
  const siblings = await tx.app.findMany({ where: { environmentId: app.environmentId }, select: { name: true } });
  const name = newServiceName(app.name, version, new Set(siblings.map((s) => s.name)));
  const id = randomUUID();
  await tx.app.create({
    data: {
      // On the old service's server: the upgrade copies the data across on that server's network.
      id, environmentId: app.environmentId, serverId: app.serverId, name, kind, image, port: SERVICE_PORTS[kind], desiredState: "running",
      memoryLimitMb: app.memoryLimitMb, cpuLimit: app.cpuLimit, pidsLimit: app.pidsLimit,
    },
  });
  const tiers = await tx.backupSchedule.findMany({ where: { appId: app.id } });
  if (tiers.length) {
    await tx.backupSchedule.createMany({
      data: tiers.map((t) => ({ appId: id, tier: t.tier, enabled: t.enabled, cron: t.cron, timezone: t.timezone, keep: t.keep, keepDays: t.keepDays, destinationId: t.destinationId })),
    });
  }
  const secretId = await sealServiceCredentials(tx, ctx.ring, id, generateServiceCredentials(kind, name));
  await tx.app.update({ where: { id }, data: { passwordSecretId: secretId } });
  await tx.volume.create({ data: { appId: id, name: volumeNameFor(id), mountPath: dataPathFor(kind) } });
  return id;
}

/** A running change blocks the delete. The new service cannot go while links lead to it. Deleting the old one makes its links real links to the new service, in the same transaction. */
export async function assertVersionChangeAllowsDelete(tx: Prisma.TransactionClient, appId: string): Promise<void> {
  await assertNoVersionChangeRunning(tx, appId);
  const from = await tx.app.findFirst({ where: { serviceRedirectId: appId }, select: { name: true } });
  if (from) throw new HttpError(409, `The linked apps of ${from.name} use this database. Switch them back on ${from.name} first, or delete ${from.name} to keep this one.`, "IN_USE_BY_SWITCH");
}

export async function moveLinksBeforeDelete(tx: Prisma.TransactionClient, ring: Ctx["ring"], appId: string, a: Actor): Promise<void> {
  const app = await tx.app.findUnique({ where: { id: appId }, select: { serviceRedirectId: true, environment: { select: { projectId: true } } } });
  if (!app?.serviceRedirectId) return;
  const scope = await loadScope(tx, app.environment.projectId);
  const entries = await loadEntries(tx, ring, scope, true);
  const services = servicesOf(scope.apps);
  const changes: ResolvedChange[] = [];
  for (const e of entries.values()) {
    const ref = P.decodeEnvRef(e.value);
    if (ref?.resourceId !== appId) continue;
    const owner = e.scope === "app" ? scope.apps.find((x) => x.id === e.scopeId) : undefined;
    const envId = owner ? owner.environmentId : e.scopeId;
    changes.push({
      scope: e.scope, scopeId: e.scopeId, environment: scope.environments.find((x) => x.id === envId)?.name ?? "",
      ...(owner ? { appId: owner.id, appName: owner.name } : {}), key: e.key, op: "change",
      value: refValueFor({ resourceId: app.serviceRedirectId, field: ref.field }, services),
    });
  }
  if (!changes.length) return;
  await applyChanges(tx, ring, scope, {
    baseVersion: "current", changes, redeploy: false,
    writer: { ...actorFields(a), source: "dashboard" },
    authorize: () => {},
  });
}
