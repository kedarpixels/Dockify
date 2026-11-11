/**
 * The preview half of the deploy engine. A preview app is NOT its base app: its own container and route
 * file, no volumes, no added capabilities. No secret or linked credential ever reaches fork code, and a
 * same-repo preview of production gets only plain values unless the owner allowed more (P.previewIsolation).
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { projects as P } from "@dockify/contracts";
import { enqueuePreviewTx, enqueueTx, type Db } from "@dockify/db";
import { resolveServiceImage, type ImagePort } from "../data/images.ts";
import type { ContainerInput } from "@dockify/engine";
import { commandInput, envNetwork } from "./containers.ts";
import { explainFailure, failureFacts } from "./failure.ts";
import { isConflict, isNotFound, isNotModified, PREVIEW_NETWORK_PREFIX, type ContainerInfo, type DockerApi } from "@dockify/engine";
import { DeployCancelled, PermanentDeployError, reason } from "@dockify/engine";
import type { DeployLog } from "./log.ts";
import { dialProbes, waitUntilReady, type HealthConfig, type ProbeDeps } from "./readiness.ts";
import type { ResolvedVar } from "./env.ts";
import { dns01FromEnv, removeRoute, writeRoute } from "./routes.ts";
import type { EdgeMode } from "../edge/ingress.ts";
import type { Dialer, RouteStore } from "../server/runtime.ts";

export const PREVIEW_LABEL = {
  env: "dockify.preview",
  member: "dockify.preview.app",
  role: "dockify.role",
  project: "dockify.project",
  deployment: "dockify.deployment",
} as const;

/** Fork previews share one network that holds no service: untrusted code reaches nothing. */
export const FORK_NETWORK = "dockify-pv-forks";
/** A same-repo preview kept out of production has a network to itself and its database, removed with it. */
export const previewNetwork = (envId: string) => `${PREVIEW_NETWORK_PREFIX}${envId}`;
export function networkOf(isolation: P.PreviewIsolation, envId: string, baseEnvironmentId: string): string {
  return isolation === "fork" ? FORK_NETWORK : isolation === "own" ? previewNetwork(envId) : envNetwork(baseEnvironmentId);
}
export const previewContainerName = (pdId: string, deploymentId: string) => `dk-pv-${pdId}-${deploymentId.slice(0, 8)}`;
export const previewDbName = (envId: string) => `dk-pvdb-${envId}`;
/** Under the dk- names the socket proxy lets the worker delete. */
export const PREVIEW_DB_VOLUME_PREFIX = "dk-pvdb-data-";
export const previewDbVolume = (envId: string) => `${PREVIEW_DB_VOLUME_PREFIX}${envId}`;
const PREVIEW_DB_DATA = "/var/lib/postgresql/data";
/** Route file id; never a uuid alone, so it can never collide with an app's file. */
export const previewRouteId = (pdId: string) => `pv-${pdId}`;
/** Direct mode with DNS-01: the wildcard certificate of the preview domain covers every preview host. */
export function previewWildcard(hostname: string, resolver = dns01FromEnv()): { domain: string; certResolver: string } | undefined {
  return resolver ? { domain: hostname.split(".").slice(1).join("."), certResolver: resolver } : undefined;
}

const DB_KEYS = ["DATABASE_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"];

export interface PreviewContext {
  pdId: string;
  envId: string;
  projectId: string;
  prNumber: number;
  hostname: string;
  fromFork: boolean;
  isolatedDb: boolean;
  isolation: P.PreviewIsolation;
  network: string;
  limits: { cpu: number; memoryMb: number; pids: number };
}

export async function loadPreviewContext(db: Db, pdId: string): Promise<PreviewContext | null> {
  const pd = await db.previewDeployment.findUnique({
    where: { id: pdId },
    select: {
      id: true, hostname: true,
      // Only one deployment of a preview app is open at a time: the one this context is for.
      deployments: { where: { status: { in: ["queued", "building", "deploying", "cancelling"] } }, select: { fromFork: true } },
      env: {
        select: {
          id: true, prNumber: true, fromFork: true, isolatedDb: true, status: true, baseEnvironmentId: true,
          baseEnvironment: { select: { name: true } },
          project: { select: { id: true, previewCpuLimit: true, previewMemoryMb: true, previewPidsLimit: true, previewProductionAccess: true, environments: { select: { id: true } } } },
        },
      },
    },
  });
  if (!pd) return null;
  const e = pd.env;
  // The deployment's own mark, fixed when it was queued, so a row edited since cannot hand a fork commit the secrets.
  const fromFork = e.fromFork || pd.deployments.some((d) => d.fromFork);
  const isolation = P.previewIsolation({ ...e, fromFork });
  return {
    pdId: pd.id, envId: e.id, projectId: e.project.id, prNumber: e.prNumber, hostname: pd.hostname, fromFork, isolatedDb: e.isolatedDb, isolation,
    network: networkOf(isolation, e.id, e.baseEnvironmentId),
    limits: { cpu: e.project.previewCpuLimit, memoryMb: e.project.previewMemoryMb, pids: e.project.previewPidsLimit },
  };
}

/**
 * Pure: the env a preview runs with. Anything but a preview sharing its base loses every secret. One kept
 * out of production loses the database keys too, marked secret or not, so a plain DATABASE_URL cannot reach
 * real data.
 */
export function previewVars(vars: ResolvedVar[], ctx: Pick<PreviewContext, "isolation" | "prNumber" | "hostname">, db: { url: string; host: string; port: number; user: string; password: string; database: string } | null): ResolvedVar[] {
  let out = ctx.isolation === "base" ? [...vars] : vars.filter((v) => !v.isSecret);
  if (ctx.isolation === "own") out = out.filter((v) => !DB_KEYS.includes(v.key));
  if (db) {
    out = out.filter((v) => !DB_KEYS.includes(v.key));
    const add = (key: string, value: string, isSecret: boolean) => out.push({ key, value, isSecret, target: "both" });
    add("DATABASE_URL", db.url, true);
    add("PGHOST", db.host, false);
    add("PGPORT", String(db.port), false);
    add("PGUSER", db.user, false);
    add("PGPASSWORD", db.password, true);
    add("PGDATABASE", db.database, false);
  }
  out = out.filter((v) => !v.key.startsWith("DOCKIFY_PREVIEW"));
  out.push({ key: "DOCKIFY_PREVIEW", value: "1", isSecret: false, target: "both" });
  out.push({ key: "DOCKIFY_PREVIEW_PR", value: String(ctx.prNumber), isSecret: false, target: "both" });
  out.push({ key: "DOCKIFY_PREVIEW_URL", value: `https://${ctx.hostname}`, isSecret: false, target: "both" });
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

const envOf = (info: ContainerInfo, key: string): string | null => info.Config.Env?.find((e) => e.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;

export const PREVIEW_DB_IMAGE = "postgres:16-alpine";

/** Resolved like a managed service's image (data/images.ts): pulled once, its digest recorded on the project. */
export async function previewDbImage(db: Db, docker: DockerApi, projectId: string, log: DeployLog, signal: AbortSignal): Promise<string> {
  const row = await db.project.findUnique({ where: { id: projectId }, select: { previewDbImage: true } });
  const port: ImagePort = {
    inspectImage: async (ref) => {
      try {
        const info = await docker.inspectImage(ref);
        return { id: info.Id, repoDigests: info.RepoDigests ?? [] };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    pullImage: (ref, onLine) => docker.pullImage(ref, null, onLine ?? (() => {}), signal),
  };
  const r = await resolveServiceImage(port, PREVIEW_DB_IMAGE, row?.previewDbImage ?? null, (line) => log.system(line));
  if (r.pin !== row?.previewDbImage) await db.project.update({ where: { id: projectId }, data: { previewDbImage: r.pin } });
  return r.imageId;
}

/**
 * The password is generated here and kept only in the container's own config. The data sits on a volume named
 * for the preview, never an anonymous one, so teardown and the reconcile can name it.
 */
export async function ensurePreviewDb(db: Db, docker: DockerApi, ctx: PreviewContext, log: DeployLog, signal: AbortSignal) {
  // The fork network may not exist yet: its first container can be this database.
  await ensurePreviewNetwork(docker, ctx);
  const name = previewDbName(ctx.envId);
  const user = "preview";
  const database = "preview";
  let info: ContainerInfo | null = await docker.inspectContainer(name).catch((e) => (isNotFound(e) ? null : Promise.reject(e)));
  if (!info) {
    const password = randomBytes(18).toString("base64url");
    const volume = previewDbVolume(ctx.envId);
    // A volume with no container holds a database under a password nobody has any more: start over.
    await docker.removeVolume(volume).catch((e) => {
      if (!isConflict(e)) throw e;
    });
    await docker.ensureVolume(volume, { "dockify.managed": "true", [PREVIEW_LABEL.env]: ctx.envId, [PREVIEW_LABEL.role]: "preview-db", [PREVIEW_LABEL.project]: ctx.projectId });
    const input: ContainerInput = {
      name, image: await previewDbImage(db, docker, ctx.projectId, log, signal), network: ctx.network, aliases: [name],
      env: { POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_DB: database },
      port: 5432, memoryMb: P.PREVIEW_DB_MEMORY_MB, cpuCores: 0.5, pidsLimit: 128,
      labels: { "dockify.managed": "true", [PREVIEW_LABEL.env]: ctx.envId, [PREVIEW_LABEL.role]: "preview-db", [PREVIEW_LABEL.project]: ctx.projectId },
      restart: "unless-stopped",
      volumes: [{ name: volume, mountPath: PREVIEW_DB_DATA }],
      healthcheck: { test: ["CMD-SHELL", 'pg_isready -q -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'], intervalSeconds: 3, timeoutSeconds: 3, retries: 20, startSeconds: 5 },
    };
    try {
      await docker.createContainer(name, input);
    } catch (e) {
      if (!isConflict(e)) throw e;
    }
    log.system(`created a throwaway Postgres for ${P.PREVIEW_DB_MEMORY_MB} MB, deleted with the preview`);
  }
  await docker.startContainer(name).catch((e) => {
    if (!isNotModified(e)) throw e;
  });
  for (let i = 0; i < 60; i++) {
    if (signal.aborted) throw new DeployCancelled();
    info = await docker.inspectContainer(name);
    if (info.State.Health?.Status === "healthy") break;
    if (!info.State.Running) throw new PermanentDeployError("the preview database exited while starting");
    await sleep(1000, undefined, { signal }).catch(() => {});
  }
  if (info?.State.Health?.Status !== "healthy") throw new PermanentDeployError("the preview database did not become ready in time");
  const password = envOf(info, "POSTGRES_PASSWORD");
  if (!password) throw new PermanentDeployError("the preview database has no password in its config");
  return { url: `postgresql://${user}:${encodeURIComponent(password)}@${name}:5432/${database}`, host: name, port: 5432, user, password, database };
}

export interface PreviewApp {
  id: string;
  port: number | null;
  startCommand: string | null;
  health: Omit<HealthConfig, "port" | "hostHeader">;
}

export interface PreviewSwapDeps {
  docker: DockerApi;
  log: DeployLog;
  routes: RouteStore;
  mode: EdgeMode;
  dial: Dialer;
  proxyContainer: string;
  dashboardHost: string;
  probe?: Partial<ProbeDeps>;
  certificateReady?: CertificateCheck;
}

export type CertificateCheck = (hostname: string) => Promise<boolean>;

/**
 * With per-host HTTP-01 a new route has only the proxy's default certificate until the first order finishes,
 * and a link that warns in a browser is not ready. A certificate that does not come stops nothing.
 */
export async function waitForCertificate(hostname: string, ready: CertificateCheck, log: DeployLog, signal: AbortSignal, o: { timeoutMs?: number; everyMs?: number } = {}): Promise<boolean> {
  const deadline = Date.now() + (o.timeoutMs ?? 90_000);
  for (;;) {
    if (await ready(hostname).catch(() => false)) return true;
    if (signal.aborted) return false;
    if (Date.now() >= deadline) {
      log.system(`the certificate for ${hostname} is not issued yet, so a browser warns until it is. Check that the name resolves to this server.`);
      return false;
    }
    await sleep(o.everyMs ?? 3_000, undefined, { signal }).catch(() => {});
  }
}

export function previewContainerInput(app: Pick<PreviewApp, "port" | "startCommand"> & Partial<PreviewApp>, ctx: PreviewContext, o: { name: string; imageId: string; env: Record<string, string>; deploymentId: string }): ContainerInput {
  return {
    name: o.name,
    image: o.imageId,
    network: ctx.network,
    aliases: [o.name],
    env: o.env,
    ...(app.startCommand ? commandInput(app.startCommand) : {}),
    port: app.port,
    memoryMb: ctx.limits.memoryMb,
    cpuCores: ctx.limits.cpu,
    pidsLimit: ctx.limits.pids,
    capAdd: [],
    sysctls: {},
    volumes: [],
    labels: {
      "dockify.managed": "true",
      // The built image bakes dockify.app=<base app id> (build.ts); blank it on the container so a
      // preview can never be mistaken for the production app, even outside pickAppContainers.
      "dockify.app": "",
      [PREVIEW_LABEL.env]: ctx.envId,
      [PREVIEW_LABEL.member]: ctx.pdId,
      [PREVIEW_LABEL.role]: "preview",
      [PREVIEW_LABEL.project]: ctx.projectId,
      [PREVIEW_LABEL.deployment]: o.deploymentId,
    },
    restart: "unless-stopped",
  };
}

/**
 * A preview's release one-off gets the preview's isolation, since its code may be a fork's: the app's own
 * builder would put it on the base environment's network with the app's capabilities and limits.
 */
export function previewReleaseInput(ctx: PreviewContext, o: { name: string; imageId: string; env: Record<string, string>; deploymentId: string; command: string }): ContainerInput {
  const base = previewContainerInput({ port: null, startCommand: null }, ctx, o);
  return {
    ...base,
    aliases: [],
    ...commandInput(o.command),
    labels: { ...base.labels, [PREVIEW_LABEL.role]: "preview-release" },
    restart: "no",
  };
}

export const ensurePreviewNetwork = (docker: DockerApi, ctx: Pick<PreviewContext, "network" | "isolation" | "envId">) =>
  docker.ensureNetwork(ctx.network, {
    "dockify.managed": "true",
    ...(ctx.isolation === "fork" ? { [PREVIEW_LABEL.role]: "preview-forks" } : ctx.isolation === "own" ? { [PREVIEW_LABEL.role]: "preview-network", [PREVIEW_LABEL.env]: ctx.envId } : {}),
  });

/** A failure removes only the new container; whatever served keeps serving. */
export async function previewSwap(app: PreviewApp, ctx: PreviewContext, deploymentId: string, imageId: string, env: Record<string, string>, deps: PreviewSwapDeps, signal: AbortSignal): Promise<{ containerId: string }> {
  const { docker, log } = deps;
  await ensurePreviewNetwork(docker, ctx);
  const name = previewContainerName(ctx.pdId, deploymentId);
  const stray = await docker.inspectContainer(name).catch(() => null);
  if (stray) await docker.removeContainer(stray.Id).catch(() => {});
  const id = await docker.createContainer(name, previewContainerInput(app, ctx, { name, imageId, env, deploymentId }));
  const scrap = async () => {
    await docker.removeContainer(id, { volumes: true }).catch(() => {});
  };
  try {
    await docker.startContainer(id);
  } catch (e) {
    await scrap();
    throw new PermanentDeployError(`the preview container could not start: ${reason(e)}`);
  }
  const ready = await waitUntilReady({ ...app.health, port: app.port, hostHeader: ctx.hostname }, {
    inspect: () => docker.inspectContainer(id),
    addressOf: (i: ContainerInfo) => i.NetworkSettings.Networks[ctx.network]?.IPAddress || null,
    ...dialProbes(deps.dial, id, ctx.network, signal),
    sleep: (ms, s) => sleep(ms, undefined, { signal: s }),
    now: () => Date.now(),
    ...deps.probe,
  }, signal);
  if (!ready.ok) {
    const why = signal.aborted ? "" : explainFailure(await failureFacts(docker, id, { command: app.startCommand, info: ready.info, exitCode: ready.exitCode ?? null, redact: (l) => log.redactor.line(l) }));
    await scrap();
    if (signal.aborted) throw new DeployCancelled();
    if (why) log.error(why);
    // The first line is what the card, the comment and the email show, so the likely cause goes in it.
    const own = ctx.isolation === "own" ? " It runs without production's secrets and services, which may be why." : "";
    throw new PermanentDeployError(`The preview container ${ready.detail}.${own}${why ? ` ${why}` : ""}`);
  }
  log.system(`preview container ${ready.detail}`);
  if (app.port !== null && ready.address) {
    await docker.connectNetwork(ctx.network, deps.proxyContainer);
    // By the container's own name, which is also its alias and unique to this deployment, never by
    // its address: Docker hands out new addresses on a reboot.
    await writeRoute(deps.routes, { appId: previewRouteId(ctx.pdId), hosts: [ctx.hostname], port: app.port, backend: name, wildcard: previewWildcard(ctx.hostname), gateId: ctx.pdId }, deps.dashboardHost, deps.mode);
    log.system(`route for https://${ctx.hostname} points at the new container`);
  } else {
    await removeRoute(deps.routes, previewRouteId(ctx.pdId));
  }
  // Older containers of this preview app go only after the route moved.
  for (const c of await docker.listContainers({ [PREVIEW_LABEL.member]: ctx.pdId })) {
    if (c.Id === id) continue;
    await docker.removeContainer(c.Id, { volumes: true }).catch((e) => {
      if (!isNotFound(e)) log.error(`could not remove an older preview container: ${reason(e)}`);
    });
  }
  if (app.port !== null && ready.address && deps.certificateReady) await waitForCertificate(ctx.hostname, deps.certificateReady, log, signal);
  return { containerId: id };
}

export function previewStatusOf(latest: Array<string | null>): "building" | "ready" | "failed" {
  if (latest.some((s) => s === null || s === "queued" || s === "building" || s === "deploying" || s === "cancelling")) return "building";
  if (latest.some((s) => s === "failed" || s === "cancelled")) return "failed";
  return "ready";
}

/** The first line worth showing of a build error. The quoted lines stay on the deployment (failureLines). */
export function firstErrorLine(error: string | null): string | null {
  if (!error) return null;
  const line = error.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
  if (!line) return null;
  return line.replace(/\s*Its last lines:\s*$/i, "").slice(0, 300) || null;
}

export function failureLines(error: string | null): string[] {
  if (!error) return [];
  return error.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(1);
}

/**
 * Pure: whether this settle emails. A ready preview tells once, then only after a failure. A fork's failure
 * tells once until it recovers, so a stranger cannot mail the admins with every failing push.
 */
export function previewNoticeFor(
  status: "building" | "ready" | "failed",
  v: { buildFailed: boolean; fromFork: boolean; commit: string | null; notifiedKey: string | null },
): { state: "ready" | "failed"; key: string } | null {
  if (status === "ready") return v.notifiedKey === "ready" ? null : { state: "ready", key: "ready" };
  if (status !== "failed" || !v.buildFailed) return null;
  const key = v.fromFork ? "failed" : `failed:${v.commit ?? "none"}`;
  return v.notifiedKey === key ? null : { state: "failed", key };
}

/** A preview that is closing, closed or asleep keeps its status. */
export async function settlePreview(db: Db, envId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const env = await tx.previewEnv.findUnique({
      where: { id: envId },
      select: { status: true, fromFork: true, commitSha: true, notifiedKey: true, apps: { select: { deployments: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, error: true } } } } },
    });
    if (!env || !["building", "ready", "failed"].includes(env.status)) return;
    const latest = env.apps.map((a) => a.deployments[0] ?? null);
    const status = previewStatusOf(latest.map((d) => d?.status ?? null));
    const error = status === "failed" ? firstErrorLine(latest.find((d) => d?.status === "failed")?.error ?? null) ?? "The build was cancelled" : null;
    const notice = previewNoticeFor(status, { buildFailed: latest.some((d) => d?.status === "failed"), fromFork: env.fromFork, commit: env.commitSha, notifiedKey: env.notifiedKey });
    await tx.previewEnv.update({ where: { id: envId }, data: { status, error, ...(notice ? { notifiedKey: notice.key } : {}) } });
    await enqueuePreviewTx(tx, "preview_feedback", envId);
    if (notice) {
      await enqueueTx(tx, {
        kind: "preview_notify", lane: "maintenance", maxAttempts: 5,
        payload: { previewId: envId, state: notice.state, commit: env.commitSha },
        dedupeKey: `preview_notify:${envId}:${notice.state}:${env.commitSha ?? "none"}`,
      });
    }
  });
}

/**
 * A push that landed while this preview app was building was coalesced. Once the deploy settles,
 * build the preview's newest commit if it is not what just shipped.
 */
export async function promotePreview(db: Db, pdId: string): Promise<string | null> {
  return db.$transaction(async (tx) => {
    const key = `deploy:preview:${pdId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const pd = await tx.previewDeployment.findUnique({
      where: { id: pdId },
      select: {
        appId: true,
        app: { select: { serverId: true } },
        env: { select: { id: true, status: true, commitSha: true, branch: true, title: true, fromFork: true } },
        deployments: { orderBy: { createdAt: "desc" }, take: 1, select: { commitSha: true, status: true } },
      },
    });
    if (!pd || !pd.env.commitSha || !["building", "ready", "failed"].includes(pd.env.status)) return null;
    const last = pd.deployments[0];
    if (!last || last.commitSha === pd.env.commitSha) return null;
    if (["queued", "building", "deploying", "cancelling"].includes(last.status)) return null;
    const now = new Date().toISOString();
    const dep = await tx.deployment.create({
      data: {
        appId: pd.appId, serverId: pd.app.serverId, previewId: pdId, trigger: "preview", branch: pd.env.branch, commitSha: pd.env.commitSha, message: pd.env.title, fromFork: pd.env.fromFork,
        actorType: "system", actorName: "Dockify", steps: [{ id: "queued", status: "done", startedAt: now, finishedAt: now }],
      },
      select: { id: true },
    });
    await tx.job.create({ data: { kind: "deploy", lane: "deploy", serverId: pd.app.serverId, payload: { deploymentId: dep.id, appId: pd.appId, previewId: pdId }, dedupeKey: key } });
    await tx.previewEnv.update({ where: { id: pd.env.id }, data: { status: "building" } });
    return dep.id;
  });
}
