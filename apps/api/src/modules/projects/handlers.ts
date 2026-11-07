/**
 * Projects, environments, apps and env vars. The route policy table already decided who may call
 * each route (Admin writes, Viewer reads); these handlers add the checks that need the
 * row: the token's project limit, the step-up for anything that touches a secret, and the
 * cross-field refusals of a new app.
 */
import { actorFields, meta } from "../../actor.ts";
import { requireActor } from "../../actor.ts";
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import { isReservedServiceName, isReservedSlug, projects as P, RESERVED_SERVICE_MESSAGE } from "@dockify/contracts";
import { defaultServerId, generateServiceCredentials, readSecretValue, sealServiceCredentials, type Prisma } from "@dockify/db";
import { dataPathFor, volumeNameFor } from "../backups/shared.ts";
import { iso } from "@dockify/contracts";
import { assertProjectScope, tokenProjectLimit, tokensLimitedOnlyTo, type Actor } from "../../actor.ts";
import { audit } from "../../audit.ts";
import { actorKind, avatarOf, loadPeople } from "../../actor-view.ts";
import { forbidden, HttpError, isUniqueViolation, rateLimited, stepUpRequired } from "../../errors.ts";
import type { Ctx, Handlers } from "../../app.ts";
import { appColumns, checkSpec, pinnedBranch, dockerVolumeName, SERVICE_DEFAULT_VERSION, SERVICE_IMAGES, SERVICE_PORTS, STORAGE_UNAVAILABLE, type AppSpec, type Refusal } from "./app-source.ts";
import {
  EnvPlanError, diff, entryId, listedValue, parseSnapshot, refValueFor, refView, resolveValue, restrictTo, servicesOf, unsealForListing,
  type Entry, type EnvSet, type ResolvedChange,
} from "./env-model.ts";
import { applyChanges, loadEntries, loadScope, openRefTarget, secretIdsFor, type ProjectScope, type Writer } from "./env-store.ts";
import { parseComposeText } from "./compose.ts";
import { enqueueRemovals } from "./jobs.ts";
import { assertNoDeployInFlight } from "../deployments/enqueue.ts";
import { assertNoVersionChangeRunning } from "../resources/version-running.ts";
import { isBlockedHost, registryHostProblem, repoHostOf, type RegistryResolver } from "./host-rule.ts";
import { recentDeployment, repoLabel, slugCandidate, slugify } from "./views.ts";
import { publicUrlOf } from "../apps/views.ts";
import { nameShownElsewhere } from "../apps/display-name.ts";
import { DEFAULT_MEMORY_MB } from "../observe/metrics.ts";

type EnvChangeIn = z.infer<typeof P.EnvChange>;


const writerOf = (a: Actor, source?: Writer["source"]): Writer => ({ ...actorFields(a), source: source ?? (a.kind === "token" ? "api" : "dashboard") });

/** Step-up for secret work. Tokens can never touch a secret. */
const secretGate = (a: Actor) => (touches: boolean): void => {
  if (!touches) return;
  if (a.kind === "token") throw forbidden("API tokens cannot change secrets");
  if (!a.elevated) throw stepUpRequired();
};

/** The loader and interpreter hook keys among a set of changes (adds and changes only), deduplicated. */
export const dangerousIn = (changes: Array<{ key: string; op: string }>): string[] =>
  [...new Set(changes.filter((c) => c.op !== "remove" && P.isDangerousEnvKey(c.key)).map((c) => c.key))];

/**
 * A hook key (NODE_OPTIONS, LD_PRELOAD, BASH_ENV...) runs code before the app's own code does. It
 * needs an elevated session that confirms it on purpose, never a token, and the apply writes an
 * audit row naming the keys. Returns the keys so the caller can audit them.
 */
export function dangerousGate(a: Actor, keys: string[], confirmed: boolean | undefined): string[] {
  if (!keys.length) return [];
  if (a.kind === "token") throw forbidden(`API tokens cannot set ${keys.join(", ")}`);
  if (!a.elevated) throw stepUpRequired();
  if (!confirmed) {
    throw new HttpError(409, `${keys.join(", ")} changes how the app's process starts, before your code runs. Confirm to set it.`, "DANGEROUS_KEY_CONFIRM", { keys });
  }
  return keys;
}

const notFound = (what: string) => new HttpError(404, `${what} not found`, "NOT_FOUND");
const refused = (refusals: Refusal[]) =>
  new HttpError(400, refusals[0]?.reason ?? "Refused", "REFUSED", { field: refusals[0]?.field, refusals });

async function projectBySlug(ctx: Ctx, actor: Actor, slug: string) {
  const p = await ctx.db.project.findUnique({ where: { slug } });
  if (!p || p.archivedAt) throw notFound("Project");
  assertProjectScope(actor, p.id);
  return p;
}

const planError = (e: unknown): never => {
  if (e instanceof EnvPlanError) throw new HttpError(400, e.message, e.code, e.key ? { key: e.key } : {});
  throw e;
};

/**
 * Environment names and app ids to scope ids, refusing an app that is not in that environment. A
 * link becomes its stored reference, refused unless the service is in this same project; the
 * reference itself is not secret (listings show it), the credential it resolves to is.
 */
function resolveChanges(scope: ProjectScope, changes: EnvChangeIn[]): ResolvedChange[] {
  const services = servicesOf(scope.apps);
  return changes.map((c) => {
    const env = scope.environments.find((e) => e.name === c.environment);
    if (!env) throw new HttpError(404, `Environment ${c.environment} not found`, "ENV_NOT_FOUND");
    let app: ProjectScope["apps"][number] | undefined;
    if (c.appId) {
      app = scope.apps.find((a) => a.id === c.appId);
      if (!app || app.environmentId !== env.id) throw new HttpError(400, `That app is not in ${c.environment}`, "APP_NOT_IN_ENVIRONMENT");
    }
    return {
      scope: app ? "app" : "environment",
      scopeId: app ? app.id : env.id,
      environment: env.name,
      ...(app ? { appId: app.id, appName: app.name } : {}),
      key: c.key,
      op: c.op,
      ...(c.ref && c.op !== "remove" ? { value: refValueFor(c.ref, services), secret: false } : {}),
      ...(c.value !== undefined ? { value: c.value } : {}),
      ...(c.secret !== undefined && !c.ref ? { secret: c.secret } : {}),
      ...(c.target !== undefined ? { target: c.target } : {}),
    };
  });
}

const labeler = (scope: ProjectScope) => (e: Entry) => {
  if (e.scope === "environment") return { environment: scope.environments.find((x) => x.id === e.scopeId)?.name ?? "" };
  const app = scope.apps.find((a) => a.id === e.scopeId);
  const env = scope.environments.find((x) => x.id === app?.environmentId);
  return { environment: env?.name ?? "", ...(app ? { appId: app.id, appName: app.name } : {}) };
};

// ------------------------------------------------------------------ views

/** A sample older than this no longer says what an app uses now: the sampler writes one every 20 s. */
const USAGE_FRESH_MS = 2 * 60_000;

async function projectDetail(ctx: Ctx, projectId: string, viewer: Actor) {
  const p = await ctx.db.project.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      environments: {
        orderBy: { createdAt: "asc" },
        include: {
          apps: {
            orderBy: { createdAt: "asc" },
            include: {
              primaryDomain: { select: { hostname: true } },
              domains: { orderBy: { createdAt: "asc" } },
              deployments: { orderBy: { createdAt: "desc" }, take: 1 },
            },
          },
        },
      },
    },
  });
  const envName = new Map(p.environments.map((e) => [e.id, e.name]));
  const apps = p.environments.flatMap((e) => e.apps);
  const deployments = await ctx.db.deployment.findMany({
    where: { appId: { in: apps.map((a) => a.id) } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const appById = new Map(apps.map((a) => [a.id, a]));
  const people = await loadPeople(ctx.db, viewer, [...deployments, ...apps.flatMap((a) => a.deployments)]);
  // The newest sample of each app that runs, as the app page's usage card reads it.
  const running = apps.filter((a) => a.status === "running" || a.status === "degraded");
  const samples = running.length
    ? await ctx.db.metricSample.findMany({
        where: { appId: { in: running.map((a) => a.id) }, resolution: "raw", at: { gte: new Date(Date.now() - USAGE_FRESH_MS) } },
        orderBy: { at: "desc" },
        select: { appId: true, cpuPct: true, memoryBytes: true },
      })
    : [];
  const latest = new Map<string, (typeof samples)[number]>();
  for (const s of samples) if (s.appId && !latest.has(s.appId)) latest.set(s.appId, s);
  const usageOf = (a: (typeof apps)[number]) => {
    const s = latest.get(a.id);
    return s ? { usage: { cpuPct: Math.round(s.cpuPct * 10) / 10, memoryBytes: Number(s.memoryBytes), memoryLimitBytes: (a.memoryLimitMb ?? DEFAULT_MEMORY_MB) * 1024 * 1024 } } : {};
  };
  const rd = (d: (typeof deployments)[number]) => {
    const a = appById.get(d.appId);
    return recentDeployment(d, { id: d.appId, name: a?.name ?? "", displayName: a?.displayName, kind: a?.kind, repo: a?.gitRepository ?? null, image: a?.image ?? null }, p.slug, envName.get(a?.environmentId ?? "") ?? "", people);
  };
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    repo: p.repoUrl ? { url: p.repoUrl, label: repoLabel(p.repoUrl) } : null,
    defaultBranch: p.defaultBranch,
    autoDeploy: p.autoDeploy,
    createdAt: iso(p.createdAt),
    environments: p.environments.map((e) => ({ name: e.name, branch: e.branch })),
    apps: apps.map((a) => ({
      id: a.id,
      name: a.name,
      ...(a.displayName ? { displayName: a.displayName } : {}),
      kind: a.kind,
      status: a.status,
      projectId: p.id,
      projectSlug: p.slug,
      environment: envName.get(a.environmentId) ?? "",
      url: publicUrlOf(a.primaryDomain, a.domains),
      ...(a.deployTarget === "vercel" ? { onVercel: true as const } : {}),
      ...usageOf(a),
      ...(a.deployments[0] ? { lastDeployment: rd(a.deployments[0]) } : {}),
    })),
    deployments: deployments.map(rd),
    domains: apps.flatMap((a) =>
      a.domains.map((d) => ({
        id: d.id,
        host: d.hostname,
        appId: a.id,
        appName: a.name,
        ...(a.displayName ? { appDisplayName: a.displayName } : {}),
        environment: envName.get(a.environmentId) ?? "",
        tls: d.tlsStatus,
        expiresAt: d.tlsExpiresAt ? iso(d.tlsExpiresAt) : null,
      })),
    ),
  };
}

// Secrets are never unsealed for a listing, even inside a step-up window: a bulk listing is not an
// audited reveal, and the web would ship the plaintext in page data. env.reveal is the only path.
async function envState(ctx: Ctx, projectId: string) {
  const scope = await loadScope(ctx.db, projectId);
  const project = await ctx.db.project.findUniqueOrThrow({ where: { id: projectId }, select: { envVersion: true } });
  const entries = await loadEntries(ctx.db, ctx.ring, scope, unsealForListing);
  const services = servicesOf(scope.apps);
  const envName = (id: string) => scope.environments.find((e) => e.id === id)?.name ?? "";
  const view = (e: (typeof entries extends Map<string, infer V> ? V : never)) => {
    const ref = refView(e.value, services, envName);
    return {
      key: e.key,
      value: listedValue(e),
      // A link always reads as masked: what it resolves to is a credential.
      secret: e.secret || ref !== undefined,
      target: e.target,
      updatedAt: iso(e.updatedAt),
      updatedBy: e.updatedBy,
      ...(ref ? { ref } : {}),
    };
  };
  const all = [...entries.values()];
  return {
    version: project.envVersion,
    environments: scope.environments.map((env) => ({ name: env.name, vars: all.filter((e) => e.scope === "environment" && e.scopeId === env.id).map(view) })),
    overrides: scope.apps
      .map((app) => ({
        appId: app.id,
        appName: app.name,
        environment: scope.environments.find((e) => e.id === app.environmentId)?.name ?? "",
        vars: all.filter((e) => e.scope === "app" && e.scopeId === app.id).map(view),
      }))
      .filter((o) => o.vars.length > 0),
  };
}

async function simpleEnv(ctx: Ctx, projectId: string) {
  const s = await envState(ctx, projectId);
  return {
    environments: s.environments.map((e) => ({
      name: e.name,
      vars: e.vars.map((v) => ({ key: v.key, value: v.value ?? "", secret: v.secret, updatedAt: v.updatedAt })),
    })),
  };
}

// ------------------------------------------------------------------ apps

export interface NewApp {
  spec: AppSpec | null;
  name: string;
  kind: AppSpec["kind"];
  /** Assigned ahead of time when a value must name this app before it exists (a template). */
  id?: string;
  /** Keys of spec.env that are not secret, so the variables page shows them. Default: all sealed and masked. */
  plain?: ReadonlySet<string>;
  /** Variables linked to a managed service created in this same call. */
  refs?: ReadonlyArray<{ key: string; serviceId: string; field: P.EnvRefField }>;
  memoryMb?: number;
  /** Redeploy the digest of the first pull, as a managed service does (a template's image). */
  pinImage?: boolean;
}

/** How registry names are resolved; tests swap it for a fake. */
let registryResolver: RegistryResolver | undefined;
export const setRegistryResolver = (r: RegistryResolver | undefined): void => {
  registryResolver = r;
};

/**
 * Why an image may not be pulled, or null: the rule every path that stores an image applies, on its
 * face (checkSpec) and then by its DNS answer. A spec's other rules do not concern an image alone.
 */
export async function imageProblem(image: string): Promise<string | null> {
  const face = checkSpec({ kind: "backend", target: "server", source: { type: "image", image, registryId: null } } as AppSpec).find((r) => r.field === "source.image");
  return face?.reason ?? registryHostProblem(image, registryResolver);
}

/** The old bare shape { name, kind }: a database kind gets the newest version offered, as New app proposes. */
function bareColumns(kind: AppSpec["kind"]): { kind: AppSpec["kind"]; image?: string; port?: number } {
  if (kind === "postgres" || kind === "redis") return { kind, image: SERVICE_IMAGES[kind][SERVICE_DEFAULT_VERSION[kind]], port: SERVICE_PORTS[kind] };
  return { kind };
}

/** The apps a new Postgres or Redis is linked to as it is created (contracts ServiceLink). */
export type ServiceLinkIn = z.infer<typeof P.ServiceLink>;

/** The kinds a service can be linked to: the apps that run code. */
const LINKABLE = new Set(["frontend", "backend", "bot"]);

const listed = (names: string[]): string => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * The variables that link a new service to the apps picked in its create popup: DATABASE_URL for a
 * Postgres, REDIS_URL for a Redis, set on each app as a reference to the service (env-refs), the
 * same stored form the Variables page links with. The credential is read at deploy time, so a
 * changed one follows on the app's next deploy. An app that already has that name, its own or one
 * shared in its environment, is never overwritten silently: unless the caller listed it in
 * `replace`, the create answers 409 LINK_CONFLICT naming those apps, and the transaction creates
 * nothing. A replaced variable of the app's own keeps where it is used; a shared one stays as it
 * is for the other apps and the picked app gets its own link over it.
 */
async function linkChanges(
  tx: Prisma.TransactionClient, ring: Ctx["ring"], scope: ProjectScope, env: { id: string; name: string },
  service: { id: string; kind: "postgres" | "redis" }, link: ServiceLinkIn,
): Promise<ResolvedChange[]> {
  const key = P.refFieldLabel(service.kind, "url");
  const targets = [...new Set(link.apps)].map((id) => {
    const app = scope.apps.find((a) => a.id === id);
    if (!app || app.environmentId !== env.id || !LINKABLE.has(app.kind)) {
      throw new HttpError(400, `Only apps in ${env.name} that run code can be linked to the ${service.kind === "postgres" ? "database" : "cache"}`, "LINK_TARGET", { field: "link" });
    }
    return app;
  });
  // Names only: no value is opened to find a conflict.
  const stored = await loadEntries(tx, ring, scope, false);
  const own = (appId: string) => stored.has(entryId("app", appId, key));
  const shared = stored.has(entryId("environment", env.id, key));
  const replace = new Set(link.replace ?? []);
  const conflicts = targets.filter((a) => (own(a.id) || shared) && !replace.has(a.id));
  if (conflicts.length) {
    throw new HttpError(409, `${listed(conflicts.map((a) => a.name))} already ${conflicts.length === 1 ? "has" : "have"} ${key}. Confirm to replace it.`, "LINK_CONFLICT", {
      field: "link", key, apps: conflicts.map((a) => ({ id: a.id, name: a.name, shared: !own(a.id) })),
    });
  }
  const value = refValueFor({ resourceId: service.id, field: "url" }, servicesOf(scope.apps));
  return targets.map((a): ResolvedChange => {
    const base = { scope: "app" as const, scopeId: a.id, environment: env.name, appId: a.id, appName: a.name, key, value };
    return own(a.id) ? { ...base, op: "change" } : { ...base, op: "add", secret: false, target: "runtime" };
  });
}

/**
 * Creates the app rows for one or more specs in one transaction. Returns the new ids. `link` only
 * goes with one new Postgres or Redis: the apps its create popup picked (linkChanges).
 */
export async function createApps(
  ctx: Ctx, actor: Actor, project: { id: string; slug: string }, environment: string, apps: NewApp[], req: FastifyRequest, link?: ServiceLinkIn,
): Promise<string[]> {
  const refusals: Refusal[] = [];
  const names = new Set<string>();
  apps.forEach((a, i) => {
    const at = apps.length > 1 ? `apps.${i}` : "";
    if (names.has(a.name)) refusals.push({ field: at ? `${at}.name` : "name", reason: `${a.name} is used twice` });
    names.add(a.name);
    if (a.spec) refusals.push(...checkSpec(a.spec, at));
    else if (a.kind === "s3") refusals.push({ field: at ? `${at}.kind` : "kind", reason: STORAGE_UNAVAILABLE });
  });
  if (refusals.length) throw refused(refusals);
  const linking = link?.apps.length ? link : undefined;
  const linked = apps[0]?.kind;
  if (linking && (apps.length !== 1 || (linked !== "postgres" && linked !== "redis"))) {
    throw refused([{ field: "link", reason: "Only a new Postgres or Redis can be linked to apps as it is created" }]);
  }
  // The registry name is resolved here and nowhere else: the agent's gate reads only what the
  // reference spells (apps/agent/src/registry-host.ts), and dockerd does its own lookup at the pull.
  for (const [i, a] of apps.entries()) {
    if (a.spec?.source.type !== "image") continue;
    const problem = await registryHostProblem(a.spec.source.image, registryResolver);
    if (problem) refusals.push({ field: apps.length > 1 ? `apps.${i}.source.image` : "source.image", reason: problem });
  }
  if (refusals.length) throw refused(refusals);

  const registryIds = [...new Set(apps.flatMap((a) => (a.spec?.source.type === "image" && a.spec.source.registryId ? [a.spec.source.registryId] : [])))];
  if (registryIds.length) {
    const found = await ctx.db.integration.count({ where: { id: { in: registryIds }, kind: "registry" } });
    if (found !== registryIds.length) throw new HttpError(400, "That registry is not connected", "REGISTRY_NOT_FOUND", { field: "source.registryId" });
  }
  for (const a of apps) {
    const g = a.spec?.source.type === "git" ? a.spec.source.git : undefined;
    if (g && !(await ctx.db.gitHubInstallation.findUnique({ where: { installationId: BigInt(g.installationId) }, select: { id: true } }))) {
      throw new HttpError(400, "That GitHub installation is not connected", "GIT_NOT_FOUND", { field: "source.git" });
    }
  }

  try {
    return await ctx.db.$transaction(async (tx) => {
      const env = await tx.environment.findUnique({ where: { projectId_name: { projectId: project.id, name: environment } } });
      if (!env) throw new HttpError(404, `Environment ${environment} not found`, "ENV_NOT_FOUND");
      // Another app may show a new app's name as its display name: refused, so no two apps look alike.
      const shown = await tx.app.findFirst({
        where: { environmentId: env.id, OR: apps.map((a) => ({ displayName: { equals: a.name, mode: "insensitive" as const } })) },
        select: { name: true, displayName: true },
      });
      if (shown) throw nameShownElsewhere(shown.displayName ?? shown.name, shown, "name");
      const ids: string[] = [];
      const envChanges: ResolvedChange[] = [];
      const serverId = await defaultServerId(tx);
      for (const a of apps) {
        const id = a.id ?? randomUUID();
        const cols = a.spec ? appColumns(a.spec) : bareColumns(a.kind);
        // A managed service (a service source, or the old bare shape of a database kind) gets its
        // credentials as the shared sealed JSON the worker reads, and its named data volume
        // as a Volume row, so every deploy, backup and restore finds the same data.
        const service = cols.kind === "postgres" || cols.kind === "redis" ? cols.kind : null;
        // Its name becomes a DNS alias on the environment network (contracts RESERVED_SERVICE_NAMES).
        if (service && isReservedServiceName(a.name)) throw new HttpError(400, RESERVED_SERVICE_MESSAGE, "RESERVED_NAME", { field: "name" });
        let passwordSecretId: string | null = null;
        if (service) passwordSecretId = await sealServiceCredentials(tx, ctx.ring, id, generateServiceCredentials(service, a.name));
        // A GitHub App installation named by the spec is linked by its row; an unknown one is refused.
        let gitInstallationId: string | null = null;
        const gitRef = a.spec?.source.type === "git" ? a.spec.source.git : undefined;
        if (gitRef) {
          const inst = /^\d{1,19}$/.test(gitRef.installationId)
            ? await tx.gitHubInstallation.findUnique({ where: { installationId: BigInt(gitRef.installationId) }, select: { id: true } })
            : null;
          if (!inst) throw refused([{ field: "source.git.installationId", reason: "That GitHub installation is not connected" }]);
          gitInstallationId = inst.id;
        }
        const gitBranch = "gitBranch" in cols ? pinnedBranch(cols.gitBranch, env.branch) : null;
        await tx.app.create({ data: { id, environmentId: env.id, serverId, name: a.name, ...cols, gitBranch, gitInstallationId, passwordSecretId, ...(a.memoryMb ? { memoryLimitMb: a.memoryMb } : {}), ...(a.pinImage ? { pinImage: true } : {}) } });
        if (service) await tx.volume.create({ data: { appId: id, name: volumeNameFor(id), mountPath: dataPathFor(service) } });
        for (const v of a.spec?.volumes ?? []) {
          await tx.volume.create({ data: { appId: id, name: dockerVolumeName(id, v.name), mountPath: v.path } });
        }
        for (const e of a.spec?.env ?? []) {
          envChanges.push({ scope: "app", scopeId: id, environment: env.name, appId: id, appName: a.name, key: e.key, op: "add", value: e.value, secret: !a.plain?.has(e.key), target: "both" });
        }
        ids.push(id);
      }
      const refs = apps.some((a) => a.refs?.length);
      if (envChanges.length || linking || refs) {
        const scope = await loadScope(tx, project.id);
        // Every service was created above, so the scope holds them and the reference passes the project check.
        for (const [i, a] of apps.entries()) {
          for (const r of a.refs ?? []) {
            envChanges.push({ scope: "app", scopeId: ids[i]!, environment: env.name, appId: ids[i]!, appName: a.name, key: r.key, op: "add", value: refValueFor({ resourceId: r.serviceId, field: r.field }, servicesOf(scope.apps)), secret: false, target: "runtime" });
          }
        }
        // The service was created above, so the scope holds it and the reference passes the project check.
        const service = linking ? { id: ids[0]!, kind: linked as "postgres" | "redis" } : undefined;
        if (linking && service) envChanges.push(...(await linkChanges(tx, ctx.ring, scope, env, service, linking)));
        const out = await applyChanges(tx, ctx.ring, scope, { baseVersion: "current", changes: envChanges, redeploy: false, writer: writerOf(actor), authorize: secretGate(actor) });
        // The links are variable changes like any other: they get the same audit row as an apply.
        if (linking) await auditEnv(tx, actor, project, out.version, out.records.length, req, out.records);
      }
      for (const [i, id] of ids.entries()) {
        await audit(tx, {
          category: "config", action: "app.create", verb: "created app", ...actorFields(actor),
          targetType: "app", targetId: id, targetLabel: `${project.slug}/${environment}/${apps[i]?.name ?? ""}`,
          suffix: apps[i]?.spec ? `from ${apps[i]?.spec?.source.type}` : null, ...meta(req),
        });
      }
      return ids;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, "An app with that name already exists in this environment", "NAME_TAKEN", { field: "name" });
    return planError(e);
  }
}

// ------------------------------------------------------------------ teardown

/**
 * Revokes every live API token limited to this project alone: once the cascade drops its rows it
 * could reach nothing, and a dead token should not linger in the list. Each revocation is audited.
 */
export async function revokeTokensLimitedTo(tx: Prisma.TransactionClient, p: { id: string; slug: string }, a: Actor, req: FastifyRequest): Promise<number> {
  const tokens = await tx.apiToken.findMany({
    where: { revokedAt: null, projects: { some: { projectId: p.id } } },
    select: { id: true, name: true, allProjects: true, projects: { select: { projectId: true } } },
  });
  const ids = tokensLimitedOnlyTo(tokens, p.id);
  if (!ids.length) return 0;
  await tx.apiToken.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: new Date() } });
  for (const t of tokens.filter((x) => ids.includes(x.id))) {
    await audit(tx, {
      category: "access", action: "token.revoke", verb: "revoked API token", ...actorFields(a), targetType: "token", targetId: t.id, targetLabel: t.name,
      suffix: `because its only project ${p.slug} was deleted`, ...meta(req),
    });
  }
  return ids.length;
}

async function teardown(tx: Prisma.TransactionClient, projectId: string, environmentIds: string[]): Promise<number> {
  const apps = await tx.app.findMany({ where: { environmentId: { in: environmentIds } }, select: { id: true } });
  const appIds = apps.map((a) => a.id);
  await assertNoDeployInFlight(tx, appIds);
  for (const id of appIds) await assertNoVersionChangeRunning(tx, id);
  const removed = await enqueueRemovals(tx, appIds, projectId);
  const secretIds = await secretIdsFor(tx, { environmentIds, appIds });
  if (secretIds.length) await tx.secret.deleteMany({ where: { id: { in: secretIds } } });
  return removed;
}

// ------------------------------------------------------------------ handlers

export const projectsHandlers = {
  "projects.list": async ({ actor, ctx }) => {
    const a = requireActor(actor);
    const ids = tokenProjectLimit(a);
    const limit = ids ? { id: { in: ids } } : {};
    const rows = await ctx.db.project.findMany({
      where: { archivedAt: null, ...limit },
      orderBy: { createdAt: "asc" },
      include: { environments: { orderBy: { createdAt: "asc" }, select: { name: true, _count: { select: { apps: true } } } } },
    });
    return rows.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      createdAt: iso(p.createdAt),
      apps: p.environments.reduce((n, e) => n + e._count.apps, 0),
      environments: p.environments.map((e) => e.name),
    }));
  },

  "projects.create": async ({ body, actor, ctx, req }) => {
    const a = requireActor(actor);
    if (tokenProjectLimit(a)) throw forbidden("This API token is limited to existing projects");
    const base = slugify(body.name);
    if (!base) throw new HttpError(400, "Use letters or digits in the name", "INVALID_SLUG", { field: "name" });
    // "New!" slugifies to "new" too: the reserved check runs on the slug, not only on the name.
    if (isReservedSlug(base)) throw new HttpError(400, "That name is reserved", "RESERVED_SLUG", { field: "name" });
    const envNames = new Set(body.environments);
    if (envNames.size !== body.environments.length) throw new HttpError(400, "Each environment needs its own name", "DUPLICATE_ENVIRONMENT", { field: "environments" });
    if (body.repoUrl && isBlockedHost(repoHostOf(body.repoUrl))) throw new HttpError(400, "That repository host is not reachable from Dockify", "REFUSED", { field: "repoUrl" });
    let gitInstallationId: string | null = null;
    if (body.git) {
      const inst = await ctx.db.gitHubInstallation.findUnique({ where: { installationId: BigInt(body.git.installationId) }, select: { id: true } });
      if (!inst) throw new HttpError(400, "That GitHub installation is not connected", "GIT_NOT_FOUND", { field: "git" });
      gitInstallationId = inst.id;
    }
    // No branch named: the instance's default branch (Settings, Instance).
    const branch = body.defaultBranch ?? (await ctx.db.instance.findUnique({ where: { id: 1 }, select: { defaultBranch: true } }))?.defaultBranch ?? "main";
    // A taken slug gets a suffix for a different name that slugifies alike; the same name would leave
    // two projects nobody can tell apart.
    if (await ctx.db.project.findFirst({ where: { name: body.name, archivedAt: null }, select: { id: true } })) {
      throw new HttpError(409, "A project with that name already exists", "SLUG_TAKEN", { field: "name" });
    }
    for (let n = 0; n < 10; n++) {
      const slug = slugCandidate(base, n);
      try {
        await ctx.db.$transaction(async (tx) => {
          const p = await tx.project.create({
            data: {
              slug, name: body.name, repoUrl: body.repoUrl || null, defaultBranch: branch,
              gitInstallationId, gitRepoId: body.git?.repoId ?? null,
              environments: { create: body.environments.map((name) => ({ name, branch })) },
            },
          });
          await audit(tx, { category: "config", action: "project.create", verb: "created project", ...actorFields(a), targetType: "project", targetId: p.id, targetLabel: slug, ...meta(req) });
        });
        return { slug };
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    }
    throw new HttpError(409, "A project with that name already exists", "SLUG_TAKEN", { field: "name" });
  },

  "projects.get": async ({ params, actor, ctx }) => {
    const a = requireActor(actor);
    const p = await projectBySlug(ctx, a, params.slug);
    return projectDetail(ctx, p.id, a);
  },

  "projects.patch": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const p = await projectBySlug(ctx, a, params.slug);
    if (body.environments && new Set(body.environments.map((e) => e.name)).size !== body.environments.length) {
      throw new HttpError(400, "Each environment needs its own name", "DUPLICATE_ENVIRONMENT", { field: "environments" });
    }
    await ctx.db.$transaction(async (tx) => {
      const changes: Array<{ key: string; before: string | boolean | null; after: string | boolean | null }> = [];
      if (body.name !== undefined && body.name !== p.name) changes.push({ key: "name", before: p.name, after: body.name });
      if (body.autoDeploy !== undefined && body.autoDeploy !== p.autoDeploy) changes.push({ key: "autoDeploy", before: p.autoDeploy, after: body.autoDeploy });
      await tx.project.update({ where: { id: p.id }, data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.autoDeploy !== undefined ? { autoDeploy: body.autoDeploy } : {}) } });
      const existing = await tx.environment.findMany({ where: { projectId: p.id } });
      if (existing.length + (body.environments ?? []).filter((e) => !existing.some((x) => x.name === e.name)).length > 10) {
        throw new HttpError(400, "A project holds at most 10 environments", "TOO_MANY_ENVIRONMENTS", { field: "environments" });
      }
      for (const e of body.environments ?? []) {
        const cur = existing.find((x) => x.name === e.name);
        if (!cur) {
          await tx.environment.create({ data: { projectId: p.id, name: e.name, branch: e.branch } });
          changes.push({ key: `environments.${e.name}`, before: null, after: e.branch });
        } else if (cur.branch !== e.branch) {
          await tx.environment.update({ where: { id: cur.id }, data: { branch: e.branch } });
          changes.push({ key: `environments.${e.name}.branch`, before: cur.branch, after: e.branch });
        }
      }
      if (changes.length) {
        await audit(tx, { category: "config", action: "project.update", verb: "updated project", ...actorFields(a), targetType: "project", targetId: p.id, targetLabel: p.slug, changes, ...meta(req) });
      }
    });
    return projectDetail(ctx, p.id, a);
  },

  "projects.delete": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const p = await projectBySlug(ctx, a, params.slug);
    if (body.confirm !== p.slug) throw new HttpError(400, `Type ${p.slug} to confirm`, "CONFIRM_MISMATCH", { field: "confirm" });
    await ctx.db.$transaction(async (tx) => {
      const envs = await tx.environment.findMany({ where: { projectId: p.id }, select: { id: true } });
      const removed = await teardown(tx, p.id, envs.map((e) => e.id));
      const extra = await secretIdsFor(tx, { environmentIds: [], appIds: [], projectId: p.id });
      if (extra.length) await tx.secret.deleteMany({ where: { id: { in: extra } } });
      await revokeTokensLimitedTo(tx, p, a, req);
      await tx.project.delete({ where: { id: p.id } });
      await audit(tx, {
        category: "config", action: "project.delete", verb: "deleted project", ...actorFields(a), targetType: "project", targetId: p.id, targetLabel: p.slug,
        suffix: `and ${removed} app${removed === 1 ? "" : "s"}`, ...meta(req),
      });
    });
    return undefined;
  },

  "projects.apps.create": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const p = await projectBySlug(ctx, a, params.slug);
    const spec: AppSpec | null = "source" in body ? (({ environment: _e, link: _l, ...rest }) => rest)(body) : null;
    const link = "source" in body ? body.link : undefined;
    const [id] = await createApps(ctx, a, p, body.environment, [{ spec, name: body.name, kind: body.kind }], req, link);
    return { id: id as string };
  },

  "projects.apps.import": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const p = await projectBySlug(ctx, a, params.slug);
    if ("compose" in body) {
      // All or nothing: one refusal and no app is created. A dry run reports without creating.
      const t = parseComposeText(body.compose);
      if (body.dryRun) return { ids: [], warnings: t.warnings, refusals: t.refusals };
      if (t.refusals.length) throw refused(t.refusals);
      const ids = await createApps(ctx, a, p, body.environment, t.specs.map((s) => ({ spec: s, name: s.name, kind: s.kind })), req);
      return { ids, warnings: t.warnings };
    }
    const ids = await createApps(ctx, a, p, body.environment, body.apps.map((s) => ({ spec: s, name: s.name, kind: s.kind })), req);
    return { ids };
  },

  // ---------------------------------------------------------------- env vars

  "env.get": async ({ params, actor, ctx }) => {
    const a = requireActor(actor);
    const p = await projectBySlug(ctx, a, params.slug);
    return simpleEnv(ctx, p.id);
  },

  "env.put": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const p = await projectBySlug(ctx, a, params.slug);
    if (new Set(body.vars.map((v) => v.key)).size !== body.vars.length) throw new HttpError(400, "A key is listed twice", "DUPLICATE_CHANGE");
    await ctx.db.$transaction(async (tx) => {
      const scope = await loadScope(tx, p.id);
      const env = scope.environments.find((e) => e.name === body.environment);
      if (!env) throw new HttpError(404, `Environment ${body.environment} not found`, "ENV_NOT_FOUND");
      const stored = await loadEntries(tx, ctx.ring, scope, false);
      const changes: EnvChangeIn[] = body.vars.map((v) => ({
        environment: body.environment, key: v.key, value: v.value, secret: v.secret,
        op: stored.has(entryId("environment", env.id, v.key)) ? "change" : "add",
      }));
      const hooks = dangerousGate(a, dangerousIn(changes), body.confirmDangerous);
      const r = await applyChanges(tx, ctx.ring, scope, { baseVersion: "current", changes: resolveChanges(scope, changes), redeploy: false, writer: writerOf(a), authorize: secretGate(a) });
      await auditEnv(tx, a, p, r.version, r.records.length, req);
      await auditHooks(tx, a, p, hooks, req);
    }).catch((e: unknown) => {
      // Saving values that are already set is a no-op here, not an error.
      if (e instanceof EnvPlanError && e.code === "NO_CHANGES") return;
      planError(e);
    });
    return simpleEnv(ctx, p.id);
  },

  "env.delete": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const p = await projectBySlug(ctx, a, params.slug);
    await ctx.db.$transaction(async (tx) => {
      const scope = await loadScope(tx, p.id);
      const changes = resolveChanges(scope, [{ environment: body.environment, key: body.key, op: "remove" }]);
      const r = await applyChanges(tx, ctx.ring, scope, { baseVersion: "current", changes, redeploy: false, writer: writerOf(a), authorize: secretGate(a) });
      await auditEnv(tx, a, p, r.version, 1, req);
    }).catch(planError);
    return undefined;
  },

  "env.state": async ({ params, actor, ctx }) => {
    const a = requireActor(actor);
    const p = await projectBySlug(ctx, a, params.slug);
    return envState(ctx, p.id);
  },

  "env.apply": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const p = await projectBySlug(ctx, a, params.slug);
    const r = await ctx.db.$transaction(async (tx) => {
      const scope = await loadScope(tx, p.id);
      const hooks = dangerousGate(a, dangerousIn(body.changes), body.confirmDangerous);
      const out = await applyChanges(tx, ctx.ring, scope, {
        baseVersion: body.baseVersion, changes: resolveChanges(scope, body.changes), redeploy: body.redeploy, writer: writerOf(a), authorize: secretGate(a),
      });
      await auditEnv(tx, a, p, out.version, out.records.length, req, out.records);
      await auditHooks(tx, a, p, hooks, req);
      return out;
    }).catch(planError);
    return { version: r.version, deploymentIds: r.deploymentIds };
  },

  "env.reveal": async ({ params, body, actor, ctx, req, reply }) => {
    const a = requireActor(actor);
    // No step-up: the per-caller bucket and the audit row below are the guard.
    const wait = ctx.limits.reveal.take(a.kind === "token" ? `token:${a.tokenId}` : `session:${a.sessionId}`);
    if (wait !== null) throw rateLimited(reply, wait);
    const p = await projectBySlug(ctx, a, params.slug);
    const scope = await loadScope(ctx.db, p.id);
    const [c] = resolveChanges(scope, [{ environment: body.environment, ...(body.appId ? { appId: body.appId } : {}), key: body.key, op: "remove" }]);
    if (!c) throw notFound("Variable");
    const row = await ctx.db.envVar.findUnique({ where: { scopeType_scopeId_key: { scopeType: c.scope, scopeId: c.scopeId, key: c.key } } });
    if (!row) throw notFound("Variable");
    const stored = await readSecretValue(ctx.db, ctx.ring, row.secretId).catch(() => null);
    if (stored === null) throw new HttpError(500, "The value could not be unsealed", "UNREADABLE");
    // A link reveals what it resolves to now, read from this project's own services only.
    const linked = P.isEnvRefValue(stored);
    const value = await resolveValue(stored, servicesOf(scope.apps), (svc) => openRefTarget(ctx.db, ctx.ring, svc)).catch(planError);
    await audit(ctx.db, {
      category: "access", action: "env.reveal", verb: "revealed env var", ...actorFields(a), targetType: "env_var", targetId: row.id,
      targetLabel: `${p.slug}/${c.environment}${c.appName ? `/${c.appName}` : ""}/${c.key}`,
      suffix: [body.purpose === "copy" ? "for copy" : null, linked ? "resolved from a linked service" : null].filter(Boolean).join(", ") || null,
      // Names only: the value never reaches the log.
      changes: { key: c.key, project: p.slug, environment: c.environment, ...(c.appName ? { app: c.appName } : {}), purpose: body.purpose ?? "view", linked },
      ...meta(req),
    });
    return { value };
  },

  "env.versions": async ({ params, query, actor, ctx }) => {
    const a = requireActor(actor);
    const p = await projectBySlug(ctx, a, params.slug);
    const rows = await ctx.db.envVersion.findMany({ where: { projectId: p.id }, orderBy: { version: "desc" }, take: query.limit ?? 50 });
    const people = await loadPeople(ctx.db, a, rows);
    return {
      versions: rows.map((v) => ({
        version: v.version,
        at: iso(v.createdAt),
        actor: v.actorName ?? (v.actorType === "system" ? "Dockify" : "Unknown"),
        actorAvatarUrl: avatarOf(v, people),
        actorKind: actorKind(v.actorType),
        source: v.source,
        ...(v.restoredFrom !== null ? { restoredFrom: v.restoredFrom } : {}),
        changes: Array.isArray(v.changes) ? (v.changes as unknown as z.infer<typeof P.EnvVersion>["changes"]) : [],
        redeployed: v.redeployed,
      })),
    };
  },

  "env.rollback": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const p = await projectBySlug(ctx, a, params.slug);
    const r = await ctx.db.$transaction(async (tx) => {
      const target = await tx.envVersion.findUnique({ where: { projectId_version: { projectId: p.id, version: body.version } } });
      if (!target) throw notFound("Version");
      const raw = await readSecretValue(tx, ctx.ring, target.snapshotSecretId);
      if (raw === null) throw new HttpError(500, "That version could not be unsealed", "UNREADABLE");
      const scope = await loadScope(tx, p.id);
      const wanted = restrictTo(parseSnapshot(raw), new Set(scope.environments.map((e) => e.id)), new Set(scope.apps.map((x) => x.id)));
      const current: EnvSet = new Map(await loadEntries(tx, ctx.ring, scope, true));
      const changes = diff(current, wanted, labeler(scope));
      if (changes.length === 0) throw new HttpError(409, `The variables already match version ${body.version}`, "NO_CHANGES");
      const hooks = dangerousGate(a, dangerousIn(changes), body.confirmDangerous);
      const out = await applyChanges(tx, ctx.ring, scope, {
        baseVersion: body.baseVersion, changes, redeploy: body.redeploy, writer: writerOf(a, "rollback"), restoredFrom: body.version, authorize: secretGate(a),
      });
      await auditEnv(tx, a, p, out.version, out.records.length, req, out.records, body.version);
      await auditHooks(tx, a, p, hooks, req);
      return out;
    }).catch(planError);
    return { version: r.version };
  },

  // ---------------------------------------------------------------- environments

  "environments.create": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const p = await projectBySlug(ctx, a, params.slug);
    try {
      await ctx.db.$transaction(async (tx) => {
        if ((await tx.environment.count({ where: { projectId: p.id } })) >= 10) {
          throw new HttpError(400, "A project holds at most 10 environments", "TOO_MANY_ENVIRONMENTS");
        }
        const env = await tx.environment.create({ data: { projectId: p.id, name: body.name, branch: body.branch } });
        if (body.copyFrom) {
          const scope = await loadScope(tx, p.id);
          const from = scope.environments.find((e) => e.name === body.copyFrom);
          if (!from) throw new HttpError(404, `Environment ${body.copyFrom} not found`, "ENV_NOT_FOUND", { field: "copyFrom" });
          const entries = await loadEntries(tx, ctx.ring, scope, true);
          const changes: ResolvedChange[] = [...entries.values()]
            .filter((e) => e.scope === "environment" && e.scopeId === from.id)
            .map((e) => ({ scope: "environment", scopeId: env.id, environment: env.name, key: e.key, op: "add", value: e.value ?? "", secret: e.secret, target: e.target }));
          if (changes.length) {
            // Hook keys run code before the app starts, so a copy passes the same gate as an edit.
            // These values exist already, so there is no new one to confirm: a token is refused, and a
            // session steps up, as for a copied secret.
            const hooks = dangerousGate(a, dangerousIn(changes), true);
            await applyChanges(tx, ctx.ring, scope, { baseVersion: "current", changes, redeploy: false, writer: writerOf(a), authorize: secretGate(a) });
            await auditHooks(tx, a, p, hooks, req);
          }
        }
        await audit(tx, {
          category: "config", action: "environment.create", verb: "created environment", ...actorFields(a), targetType: "environment", targetId: env.id,
          targetLabel: `${p.slug}/${env.name}`, suffix: body.copyFrom ? `from ${body.copyFrom}` : null, ...meta(req),
        });
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, `${body.name} already exists`, "NAME_TAKEN", { field: "name" });
      planError(e);
    }
    return undefined;
  },

  "environments.patch": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const p = await projectBySlug(ctx, a, params.slug);
    const env = await ctx.db.environment.findUnique({ where: { projectId_name: { projectId: p.id, name: params.name } } });
    if (!env) throw notFound("Environment");
    if (env.branch === body.branch) return undefined;
    await ctx.db.$transaction(async (tx) => {
      await tx.environment.update({ where: { id: env.id }, data: { branch: body.branch } });
      await audit(tx, {
        category: "config", action: "environment.update", verb: "changed the branch of", ...actorFields(a), targetType: "environment", targetId: env.id,
        targetLabel: `${p.slug}/${env.name}`, changes: [{ key: "branch", before: env.branch, after: body.branch }], ...meta(req),
      });
    });
    return undefined;
  },

  "environments.delete": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const p = await projectBySlug(ctx, a, params.slug);
    if (body.confirm !== params.name) throw new HttpError(400, `Type ${params.name} to confirm`, "CONFIRM_MISMATCH", { field: "confirm" });
    await ctx.db.$transaction(async (tx) => {
      const env = await tx.environment.findUnique({ where: { projectId_name: { projectId: p.id, name: params.name } } });
      if (!env) throw notFound("Environment");
      if ((await tx.environment.count({ where: { projectId: p.id } })) <= 1) {
        throw new HttpError(409, "A project keeps at least one environment; delete the project instead", "LAST_ENVIRONMENT");
      }
      const removed = await teardown(tx, p.id, [env.id]);
      await tx.environment.delete({ where: { id: env.id } });
      await audit(tx, {
        category: "config", action: "environment.delete", verb: "deleted environment", ...actorFields(a), targetType: "environment", targetId: env.id,
        targetLabel: `${p.slug}/${env.name}`, suffix: `and ${removed} app${removed === 1 ? "" : "s"}`, ...meta(req),
      });
    });
    return undefined;
  },
} satisfies Handlers;

/** One row per apply that set a hook key, naming the keys, so the activity log shows who changed how a process starts. */
async function auditHooks(tx: Prisma.TransactionClient, a: Actor, p: { id: string; slug: string }, keys: string[], req: FastifyRequest): Promise<void> {
  if (!keys.length) return;
  await audit(tx, {
    category: "access", action: "env.dangerousKey", verb: "set a process hook variable in", ...actorFields(a),
    targetType: "project", targetId: p.id, targetLabel: p.slug, suffix: keys.join(", "), ...meta(req),
  });
}

async function auditEnv(
  tx: Prisma.TransactionClient, a: Actor, p: { id: string; slug: string }, version: number, count: number, req: FastifyRequest,
  records?: Array<{ environment: string; appName?: string; key: string; op: string }>, restoredFrom?: number,
): Promise<void> {
  await audit(tx, {
    category: "config",
    action: restoredFrom ? "env.rollback" : "env.apply",
    verb: restoredFrom ? `rolled env vars back to version ${restoredFrom} in` : "changed env vars in",
    ...actorFields(a),
    targetType: "project",
    targetId: p.id,
    targetLabel: p.slug,
    suffix: `(version ${version}, ${count} change${count === 1 ? "" : "s"})`,
    // Keys and operations only: values never enter the audit log, masked or not.
    ...(records ? { changes: records.map((r) => ({ key: `${r.environment}${r.appName ? `/${r.appName}` : ""}/${r.key}`, before: null, after: r.op })) } : {}),
    ...meta(req),
  });
}
