/** Kept out of main.ts so a test can check the table covers every job kind without starting the loops. */
import path from "node:path";
import type { Db, JobKind, SecretVault } from "@dockify/db";
import { enqueue, enqueuePreviewTx, readSecretValue } from "@dockify/db";
import { createDataChannel } from "./data/channel.ts";
import { EngineTerminalPort } from "./terminal/engine.ts";
import { attachTerminalChannel } from "./terminal/session.ts";
import { createDataDeps, createDataStores, type DataDeps, type DataStores } from "./data/context.ts";
import { EngineDataPort } from "./data/engine-port.ts";
import { dataJobHandlers } from "./data/handlers.ts";
import { createMailer, mailPolicyFromEnv, type Mailer } from "@dockify/email";
import type { HttpClient } from "@dockify/net-guard";
import { assertPublicHost } from "@dockify/net-guard";
import { connectPg } from "./data/pg-session.ts";
import { dataServerTick, dataTick } from "./data/scheduler.ts";
import { parseCredentials } from "./data/services.ts";
import { AGENT_CONTAINER, canonicalName, envNetwork, LABEL, PROXY_CONTAINER, routeAliasOf } from "./deploy/containers.ts";
import { sweepLeftovers } from "./data/leftovers.ts";
import { runPrune, startDiskSampler, type DiskDeps } from "./deploy/disk.ts";
import { removeOrphanContainers } from "./deploy/janitor.ts";
import { sweepEnvNetworks, sweepPreviewNetworks } from "./deploy/networks.ts";
import { isNotFound, type DockerApi } from "@dockify/engine";
import { deployHandlers, loadDeployConfig, settleOrphanedDeployments, type DeployConfig } from "./deploy/index.ts";
import { exposedPort, promotePending } from "./deploy/pipeline.ts";
import { publicResolver, zoneDns } from "./edge/dns.ts";
import { loadEdgeSettings, type EdgeSettings } from "./edge/ingress.ts";
import { queueDashboardCheck } from "./edge/dashboard.ts";
import { edgeGlobalHandlers, edgeServerHandlers, enqueueRouteSync, queueWaitingDnsChecks, type EdgeDeps, type EdgeGlobalDeps, type RouteTargetInfo } from "./edge/jobs.ts";
import { probeDomain } from "./edge/probe.ts";
import { watchStarts } from "./edge/starts.ts";
import { nodeTlsProbe, proxyCertificateReady } from "./edge/tls.ts";
import { PREVIEW_LABEL } from "./deploy/preview.ts";
import {
  createHttpClient, integrationJobHandlers, isPermanent as integrationPermanent, previewJobHandlers, queueVercelMirrorIfDue, reconcilePreviews, runPreviewDns, staleDnsDomains, statsOf, traefikCounters,
} from "./integrations/index.ts";
import { sweepPreviewDbVolumes, type PreviewRuntimeDeps } from "./integrations/previews.ts";
import { runEmailSend } from "./integrations/email.ts";
import { runIconFetch } from "./icons/index.ts";
import { deliverDeployFailed } from "./integrations/deploy-notify.ts";
import { runDeployStatus } from "./integrations/deploy-status.ts";
import { announceExpiringCertificates, announceFailedBackups, deliverEventNotice } from "./integrations/events.ts";
import { deliverPreviewNotice } from "./integrations/preview-notify.ts";
import { deliverUpdateNotice } from "./integrations/update-notify.ts";
import { primeWebhookTargets, runWebhookSend, WebhookTargets } from "./integrations/webhooks.ts";
import { deliverSecurityNotice } from "./integrations/security-notify.ts";
import { resolveEnv, runtimeEnv } from "./deploy/env.ts";
import { observeJobHandlers, startObserve, startObserveMaintenance } from "./observe/index.ts";
import type { ServerRuntime } from "./server/runtime.ts";
import { jsonLogger, type Logger } from "./boot.ts";
import { DeferJobError, PermanentJobError } from "./errors.ts";
import { DiskReserve, hostDiskUsage, realDiskFs, statfsUsage } from "./deploy/disk-guard.ts";
import { type AliveFile, checkWorkFolder, heartbeat, needsWorkFolder, WorkerHealth } from "./health.ts";
import type { ClaimedJob } from "./queue.ts";
import { deleteOrphanedBackups } from "./data/orphans.ts";
import { runPower } from "./power.ts";
import { removeApp } from "./teardown.ts";
import { isVaultDown, jobContext } from "./vault.ts";
import { handleScheduledRun } from "./jobs/run.ts";
import { jobsTick, pruneJobHistory, settleOrphanRuns } from "./jobs/tick.ts";

export type JobHandler = (job: ClaimedJob, signal: AbortSignal) => Promise<void>;

/** self_update and dashboard_domain_apply run in the updater's own lane; the rest have no producer and fail permanently. */
export const UNHANDLED_KINDS: readonly JobKind[] = ["self_update", "dashboard_domain_apply", "cancel_deploy", "factory_reset"];

export interface WorkerDeps {
  db: Db;
  /** The worker's only way to a plaintext secret: the api's internal routes. Never a keyring. */
  vault: SecretVault;
  /** DOCKIFY_INTERNAL_TOKEN: what the api presents on the data channel, and what signs the icon links in emails. */
  internalToken?: string;
  deployConfig?: DeployConfig;
  edge?: EdgeSettings;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  alive?: AliveFile;
}

export type JobTable = Partial<Record<JobKind, JobHandler>>;

export interface WorkerShared extends WorkerDeps {
  env: NodeJS.ProcessEnv;
  deployConfig: DeployConfig;
  edge: EdgeSettings;
  logger: Logger;
  health: WorkerHealth;
  stores: DataStores;
  http: HttpClient;
  mail: Mailer;
  webhookTargets: WebhookTargets;
  publicUrl: string | null;
}

export interface ServerWired {
  handlers: JobTable;
  disk: DiskDeps;
  data: DataDeps;
  edgeDeps: EdgeDeps;
  previews: PreviewRuntimeDeps;
  sweep: () => Promise<void>;
}

export type Wired = ServerWired;

/** Past the job lease, so a test that a dead worker was running no longer counts as live. */
const BOOT_SWEEP_DELAY_MS = 90_000;

/**
 * Where an app's route points: its route alias, or the canonical name of a container made before aliases
 * existed. Never an address (Docker hands out new ones on a reboot). A stopped container keeps its route.
 */
export function routeTargetFor(db: Db, docker: DockerApi) {
  return async (appId: string): Promise<RouteTargetInfo | null> => {
    const app = await db.app.findUnique({ where: { id: appId }, select: { environmentId: true } });
    if (!app) return null;
    const network = envNetwork(app.environmentId);
    try {
      const info = await docker.inspectContainer(canonicalName(appId));
      if (info.Config.Labels?.[LABEL.app] !== appId) return null;
      return { backend: routeAliasOf(info, network) ?? canonicalName(appId), network };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  };
}

export function imagePortFor(docker: DockerApi) {
  return async (appId: string): Promise<number | null> => {
    try {
      const info = await docker.inspectContainer(canonicalName(appId));
      if (info.Config.Labels?.[LABEL.app] !== appId) return null;
      return exposedPort(await docker.inspectImage(info.Image));
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  };
}

/** A preview member's container, by name, for a route an older version wrote with its address. */
export function previewTargetFor(docker: DockerApi) {
  return async (previewDeploymentId: string): Promise<RouteTargetInfo | null> => {
    const found = await docker.listContainers({ [PREVIEW_LABEL.member]: previewDeploymentId, [PREVIEW_LABEL.role]: "preview" });
    for (const c of [...found].sort((a, b) => Number(b.State === "running") - Number(a.State === "running"))) {
      const info = await docker.inspectContainer(c.Id).catch(() => null);
      const network = info ? Object.keys(info.NetworkSettings.Networks)[0] : undefined;
      if (info && network) return { backend: info.Name.replace(/^\//, ""), network };
    }
    return null;
  };
}

/**
 * Secret values for literal redaction of runtime logs: secret env vars and a managed service's generated
 * password. Each is read on its own, so one unreadable value never empties the list.
 */
export function secretsFor(db: Db, vault: SecretVault) {
  return async (appId: string): Promise<string[]> => {
    const app = await db.app.findUnique({
      where: { id: appId },
      select: { environmentId: true, passwordSecretId: true, environment: { select: { projectId: true } } },
    });
    if (!app) return [];
    const vars = await resolveEnv(db, vault, { projectId: app.environment.projectId, environmentId: app.environmentId, appId }).catch(() => []);
    const out = vars.filter((v) => v.isSecret && v.value.length >= 6).map((v) => v.value);
    const password = app.passwordSecretId ? await servicePassword(db, vault, app.passwordSecretId) : null;
    if (password && password.length >= 6) out.push(password);
    return out;
  };
}

async function servicePassword(db: Db, vault: SecretVault, secretId: string): Promise<string | null> {
  const raw = await readSecretValue(db, vault, secretId).catch(() => null);
  if (!raw) return null;
  try {
    return parseCredentials(raw).password;
  } catch {
    return null;
  }
}

const permanentWhen = (h: JobHandler, isPerm: (e: unknown) => boolean): JobHandler => async (job, signal) => {
  try {
    await h(job, signal);
  } catch (e) {
    if (isPerm(e)) throw new PermanentJobError(e instanceof Error ? e.message : String(e));
    throw e;
  }
};

/** How long a notification waits for the api before it counts as failed, and how often it looks. */
export const API_WAIT_MS = 3 * 86_400_000;
const API_RETRY_MS = 30_000;

/** A notification that finds the api down spends no attempt, so a long outage does not lose the alert. */
export const waitForApi = (h: JobHandler): JobHandler => async (job, signal) => {
  try {
    await h(job, signal);
  } catch (e) {
    const waited = job.createdAt ? Date.now() - job.createdAt.getTime() : 0;
    if (isVaultDown(e) && waited < API_WAIT_MS) throw new DeferJobError(e instanceof Error ? e.message : String(e), API_RETRY_MS);
    throw e;
  }
};

export function workerShared(deps: WorkerDeps): WorkerShared {
  const env = deps.env ?? process.env;
  const { db, vault } = deps;
  const stores = {
    ...createDataStores({
      db,
      vault,
      tmpDir: env.DOCKIFY_TMP_DIR?.trim() || "/var/lib/dockify/tmp",
      localRoot: env.DOCKIFY_BACKUP_DIR?.trim() || "/var/lib/dockify/backups",
      guard: assertPublicHost,
      env,
    }),
    log: (msg: string, extra?: object) => deps.logger?.warn(msg, extra),
  };
  return {
    db, vault, env,
    ...(deps.internalToken ? { internalToken: deps.internalToken } : {}),
    ...(deps.alive ? { alive: deps.alive } : {}),
    deployConfig: deps.deployConfig ?? loadDeployConfig(env),
    edge: deps.edge ?? loadEdgeSettings(env),
    logger: deps.logger ?? jsonLogger(),
    health: new WorkerHealth(),
    stores,
    http: createHttpClient(),
    // One sender for this process: it remembers what its server accepted, so a retried job skips that.
    mail: createMailer(mailPolicyFromEnv(env)),
    webhookTargets: new WebhookTargets(),
    publicUrl: env.DOCKIFY_PUBLIC_URL?.trim() || null,
  };
}

const tableBuilder = () => {
  const handlers: JobTable = {};
  const add = (owner: string, table: Partial<Record<string, JobHandler>>) => {
    for (const [kind, h] of Object.entries(table)) {
      if (!h) continue;
      if (handlers[kind as JobKind]) throw new Error(`job kind ${kind} is handled twice (${owner})`);
      handlers[kind as JobKind] = h;
    }
  };
  return { handlers, add };
};

export function buildServerHandlers(runtime: ServerRuntime, deps: WorkerShared): ServerWired {
  const { db, vault, deployConfig, edge, logger } = deps;
  const { docker, serverId, routes, mode, dial, builder, host } = runtime;
  const removeVolume = (name: string) => docker.removeVolume(name);
  const data: DataDeps = {
    ...createDataDeps(deps.stores, new EngineDataPort(docker)),
    // Volumes live on this server's Docker disk, which only its own host reading sees (a remote server's
    // is not mounted here). Staged ciphertext is on the worker's work volume, read where it is written.
    volumeDisk: hostDiskUsage(host),
    scratchDisk: statfsUsage(deps.stores.tmpDir),
    promotePending: (appId) => promotePending(db, appId),
  };
  const previews: PreviewRuntimeDeps = {
    db, docker, serverId, routes, mode, proxyContainer: PROXY_CONTAINER, dashboardHost: deployConfig.dashboardHost,
    builder,
    networks: { docker, ownContainers: [PROXY_CONTAINER, AGENT_CONTAINER] },
    counters: traefikCounters(dial),
    stats: async (id) => statsOf(await docker.call(`GET`, `/containers/${encodeURIComponent(id)}/stats?stream=false`)),
  };
  const previewJobs = previewJobHandlers(previews);

  const { handlers, add } = tableBuilder();
  add("deploy", deployHandlers({ db, vault, config: deployConfig, docker, serverId, routes, mode, dial, builder, host, ...(mode.ingress === "direct_tls" ? { certificateReady: proxyCertificateReady(dial) } : {}) }));
  add("jobs", { scheduled_run: (job, signal) => handleScheduledRun({ db, vault, docker }, job, signal) });
  const edgeDeps: EdgeDeps = {
    ...edgeBase(deps, runtime),
    serverId,
    routeTarget: routeTargetFor(db, docker),
    imagePort: imagePortFor(docker),
    previewTarget: previewTargetFor(docker),
    joinProxy: (network) => docker.connectNetwork(network, PROXY_CONTAINER),
  };
  add("edge", edgeServerHandlers(edgeDeps));
  // A work folder the worker cannot write fails only these jobs, at once, with how to fix it.
  add("data", needsWorkFolder(dataJobHandlers(data), { db, dir: data.tmpDir, health: deps.health, log: logger }));
  add("previews", {
    preview_cleanup: permanentWhen((job) => previewJobs.preview_cleanup(job), integrationPermanent),
    preview_wake: permanentWhen((job) => previewJobs.preview_wake(job), integrationPermanent),
  });
  // The containers Dockify itself attaches to tenant networks, which never keep a network alive.
  const networks = {
    docker,
    ownContainers: [PROXY_CONTAINER, AGENT_CONTAINER],
    log: (msg: string, extra?: object) => logger.warn(msg, extra),
  };
  add("teardown", { remove_app: (job) => removeApp({ db, docker, routes, removeVolume, networks }, job.payload, job.serverId!) });
  // Volumes already read and kept, so the sweep starts no helper for them again until a restart.
  const keptVolumes = new Set<string>();
  const sweep = async (): Promise<void> => {
    const log = networks.log;
    const volumes = async () => (await docker.diskUsage(["volume"], AbortSignal.timeout(10 * 60_000))).Volumes ?? [];
    await sweepPreviewDbVolumes({ db, serverId, docker, volumes })
      .then((n) => {
        if (n) log("removed the databases of previews that are gone", { volumes: n });
      })
      .catch((e: unknown) => log("the preview database sweep failed", { error: e instanceof Error ? e.message : String(e) }));
    await sweepLeftovers({ db, serverId, docker: data.docker, volumes, log, kept: keptVolumes })
      .then((r) => {
        if (r.scratchContainers || r.scratchVolumes || r.emptyVolumes) log("swept leftovers of throwaway containers", { ...r });
      })
      .catch((e: unknown) => log("the leftover sweep failed", { error: e instanceof Error ? e.message : String(e) }));
    await removeOrphanContainers(db, docker, new Date(), log)
      .then((names) => {
        if (names.length) log("removed containers of deleted apps", { names });
      })
      .catch((e: unknown) => log("the orphaned container sweep failed", { error: e instanceof Error ? e.message : String(e) }));
    await sweepEnvNetworks({ db, serverId, ...networks }).catch((e: unknown) => log("the network sweep failed", { error: e instanceof Error ? e.message : String(e) }));
    await sweepPreviewNetworks({ db, serverId, ...networks }).catch((e: unknown) => log("the preview network sweep failed", { error: e instanceof Error ? e.message : String(e) }));
  };
  add("power", {
    app_power: async (job) => {
      await runPower({ db, docker, promotePending: (appId) => promotePending(db, appId) }, job.payload);
    },
  });
  const disk: DiskDeps = { db, docker, config: deployConfig, serverId, builder };
  // The Server page's Prune button: the api waits on this job and reads its report off the row.
  add("disk", {
    prune: async (job) => {
      await runPrune(disk, job);
    },
  });

  // The janitor pass also reconciles previews, after sweeping what throwaway containers left, so
  // its report of unused volumes names only what is really left.
  const janitor = handlers.janitor;
  if (janitor) {
    handlers.janitor = async (job, signal) => {
      await sweep();
      await janitor(job, signal);
      await reconcilePreviews(previews);
    };
  }
  // A reconcile job also runs the preview pass, so a change of a preview's isolation (queued by the
  // api's settings handler) reaches its containers at once. Previews first: that is the urgent half.
  const reconcile = handlers.reconcile;
  if (reconcile) {
    handlers.reconcile = async (job, signal) => {
      await reconcilePreviews(previews);
      await reconcile(job, signal);
    };
  }
  return { handlers, disk, data, edgeDeps, previews, sweep };
}

const edgeBase = (deps: WorkerShared, server: Pick<ServerRuntime, "routes" | "mode">): EdgeGlobalDeps => ({
  db: deps.db, vault: deps.vault, settings: deps.edge, routes: server.routes, mode: server.mode,
  dns: publicResolver(),
  zoneDns: zoneDns(),
  tls: nodeTlsProbe,
  // The api answers the ownership probe with the same shared secret (modules/domains/check-route.ts).
  ...(deps.internalToken ? { probe: (host: string, domainId: string) => probeDomain({ host, domainId, secret: deps.internalToken! }) } : {}),
});

/** Everything that reaches no server. The dashboard's domain does write route files, always on `primary`. */
export function buildGlobalHandlers(deps: WorkerShared & { primary: Pick<ServerRuntime, "routes" | "mode"> }): JobTable {
  const { db, vault, http, mail, env, publicUrl, deployConfig, edge, webhookTargets, stores } = deps;
  const integ = integrationJobHandlers({
    db,
    vault,
    http,
    resolveEnv: async (appId) => {
      const app = await db.app.findUnique({ where: { id: appId }, select: { port: true, environmentId: true, environment: { select: { projectId: true } } } });
      if (!app) throw new PermanentJobError(`app ${appId} no longer exists`);
      const vars = await resolveEnv(db, vault, { projectId: app.environment.projectId, environmentId: app.environmentId, appId });
      return runtimeEnv(vars, app.port);
    },
    githubApiBase: deployConfig.githubApiBase,
    internalToken: deps.internalToken,
    publicUrl,
    deploymentRetentionDays: deployConfig.deploymentRetentionDays,
  });
  const { handlers, add } = tableBuilder();
  add("edge", edgeGlobalHandlers(edgeBase(deps, deps.primary)));
  const observe = observeJobHandlers({ db, vault, internalToken: deps.internalToken, targets: webhookTargets, mail, publicUrl: env.DOCKIFY_PUBLIC_URL ?? null });
  add("observe", Object.fromEntries(Object.entries(observe).map(([kind, h]) => [kind, waitForApi(h)])));
  add("integrations", {
    preview_feedback: permanentWhen((job) => integ.preview_feedback(job), integrationPermanent),
    preview_dns: async (job) => runPreviewDns({ db, vault, settings: edge, dns: publicResolver() }, job.payload),
    vercel_sync: permanentWhen((job, signal) => integ.vercel_sync(job, signal), integrationPermanent),
    vercel_mirror: permanentWhen((job) => integ.vercel_mirror(job), integrationPermanent),
    email_send: async (job) => {
      await runEmailSend({ db, vault, mail }, job);
    },
    deploy_notify: async (job) => {
      await deliverDeployFailed({ db, vault, mail, publicUrl, internalToken: deps.internalToken }, job.payload);
    },
    deploy_status: async (job) => {
      await runDeployStatus({ db, vault, http, apiBase: deployConfig.githubApiBase, publicUrl }, job.payload);
    },
    event_notify: async (job) => {
      await deliverEventNotice({ db, vault, mail, publicUrl }, job.payload);
    },
    preview_notify: async (job) => {
      await deliverPreviewNotice({ db, vault, mail, publicUrl }, job.payload);
    },
    update_notify: async (job) => {
      await deliverUpdateNotice({ db, vault, mail, publicUrl }, job.payload, job.id);
    },
    webhook_send: waitForApi(async (job) => {
      await runWebhookSend({ db, vault, http, targets: webhookTargets }, job.payload, job.id);
    }),
    // Backups of a deleted app: only this process can write the backups volume.
    backup_delete: async (job) => {
      await deleteOrphanedBackups(stores, job.id, job.payload);
    },
    security_notify: async (job) => {
      await deliverSecurityNotice({ db, vault, mail, publicUrl }, job.payload);
    },
  });
  add("icons", { icon_fetch: (job) => runIconFetch({ db, http }, job.payload) });
  return handlers;
}

export function buildHandlers(runtime: ServerRuntime, deps: WorkerShared): Wired {
  const server = buildServerHandlers(runtime, deps);
  const { handlers, add } = tableBuilder();
  add("server", server.handlers);
  add("global", buildGlobalHandlers({ ...deps, primary: runtime }));
  return { ...server, handlers };
}

export interface Timers {
  stop(): Promise<void>;
}

const HOUR = 3_600_000;
/** Next to the scratch folder, on the work volume: the same filesystem as containers and the database. */
const DISK_RESERVE_FILE = ".control-plane-reserve";

/** A periodic pass. Each tick runs with a named context, so a secret it opens is audited as "timer:<name>". */
const everyFor = (log: (msg: string, extra?: object) => void) => (name: string, ms: number, fn: () => Promise<unknown>) => {
  const run = () => jobContext.run({ jobId: null, purpose: `timer:${name.replace(/\s+/g, "-")}` }, fn);
  const t = setInterval(() => void run().catch((e: unknown) => log(`${name} failed`, { error: e instanceof Error ? e.message : String(e) })), ms);
  t.unref();
  return t;
};

/** Periodic work on one server. Every enqueue names the server, so its dedupe key does too. */
export function startServerTimers(runtime: ServerRuntime, deps: WorkerShared & ServerWired, log: (msg: string, extra?: object) => void): Timers {
  const { db, vault, data } = deps;
  const { serverId, docker } = runtime;
  const every = everyFor(log);
  const timers = [
    every("data server tick", 60_000, () => dataServerTick(data, serverId)),
    every("scheduled job sweep", 60_000, () => settleOrphanRuns(db, docker, serverId)),
    // Deployments whose job died with its workers would otherwise block their app forever.
    every("deploy sweep", 60_000, () => settleOrphanedDeployments({ db, docker, serverId })),
    every("reconcile", 15 * 60_000, () => enqueue(db, { kind: "reconcile", lane: "maintenance", serverId, payload: {}, dedupeKey: `reconcile:${serverId}` })),
    // The preview cleanup guarantee: closed, expired, disabled and orphaned previews go; idle ones sleep.
    every("preview reconcile", 3 * 60_000, () => reconcilePreviews({ ...deps.previews, log })),
    every("janitor", 6 * HOUR, () => enqueue(db, { kind: "janitor", lane: "maintenance", serverId, payload: {}, dedupeKey: `janitor:${serverId}` })),
  ];
  // A container Docker started (a reboot, its restart policy) gets its route checked at once, on
  // the deploy lane so the sync never runs during a swap.
  const starts = watchStarts(docker, (appId) => enqueueRouteSync(db, appId), log);
  const stopObserve = startObserve(runtime, { db, vault, log, secretsFor: secretsFor(db, vault) });
  // Off the job lanes on purpose: a slow /system/df on a big host must never hold up a deploy or the janitor.
  const diskSampler = startDiskSampler({ ...deps.disk, log });
  // A worker that crashed left its restore test's decrypted copy behind: gone soon after any boot,
  // not at the next janitor pass.
  const bootSweep = setTimeout(() => void jobContext.run({ jobId: null, purpose: "timer:boot-sweep" }, deps.sweep), BOOT_SWEEP_DELAY_MS);
  bootSweep.unref();
  return {
    async stop() {
      for (const t of timers) clearInterval(t);
      clearTimeout(bootSweep);
      await starts.stop();
      await diskSampler.stop();
      await stopObserve();
    },
  };
}

/** The first heartbeat goes out at once, so readiness shows as soon as work starts. */
export async function startGlobalTimers(deps: WorkerShared, log: (msg: string, extra?: object) => void): Promise<Timers> {
  const { db, vault, stores } = deps;
  const beat = () => heartbeat(db, deps.health).then((r) => {
    deps.alive?.beat();
    return r;
  });
  deps.alive?.booted();
  await beat().catch(() => {});
  const every = everyFor(log);
  const diskReserve = new DiskReserve({ path: path.join(path.dirname(stores.tmpDir), DISK_RESERVE_FILE), fs: realDiskFs(deps.deployConfig.diskPath), health: deps.health, log });
  void diskReserve.tick();
  const timers = [
    every("data tick", 60_000, () => dataTick(stores)),
    every("scheduled jobs", 20_000, () => jobsTick(db)),
    every("scheduled job history", 15 * 60_000, () => pruneJobHistory(db)),
    every("edge checks", 15 * 60_000, () => enqueue(db, { kind: "dns_check", lane: "maintenance", payload: {}, dedupeKey: "dns_check:all" })),
    // A domain whose DNS does not point here yet is checked again on a backoff, and gets
    // its router as soon as a check passes.
    every("dns waiting", 30_000, () => queueWaitingDnsChecks(db)),
    every("dashboard domain", 30_000, () => queueDashboardCheck(db)),
    every("preview dns", 3 * 60_000, async () => {
      for (const d of await staleDnsDomains(db)) await db.$transaction((tx) => enqueuePreviewTx(tx, "preview_dns", d));
    }),
    // The backstop that keeps Vercel deployments current without a webhook.
    every("vercel mirror", 30_000, () => queueVercelMirrorIfDue(db)),
    every("heartbeat", 30_000, beat),
    every("disk guard", 60_000, () => diskReserve.tick()),
    // The work folder again, so a fixed folder clears its issue without waiting for a backup.
    every("work folder", 60_000, () => checkWorkFolder({ health: deps.health, dir: stores.tmpDir, log: deps.logger })),
    // Events with no job of their own to hook, announced when their switch in Settings is on.
    every("backup notices", 60_000, () => announceFailedBackups(db)),
    every("certificate notices", 6 * HOUR, () => announceExpiringCertificates(db)),
    // Fresh copies of what would announce an api outage, for when that outage comes.
    every("webhook targets", 6 * HOUR, () => primeWebhookTargets({ db, vault, targets: deps.webhookTargets })),
  ];
  void jobContext.run({ jobId: null, purpose: "timer:webhook-targets" }, () => primeWebhookTargets({ db, vault, targets: deps.webhookTargets })).catch(() => {});
  const stopCare = startObserveMaintenance({ db, log });
  return {
    async stop() {
      for (const t of timers) clearInterval(t);
      await stopCare();
    },
  };
}

/** The data browser's and the web terminal's channel: bound to the control-plane address only, never 0.0.0.0. */
export function startChannel(runtime: ServerRuntime, deps: WorkerShared & ServerWired, log: (msg: string, extra?: object) => void): Timers {
  const { env } = deps;
  const bind = env.DOCKIFY_DATA_CHANNEL_BIND?.trim();
  const port = Number(env.DOCKIFY_DATA_CHANNEL_PORT ?? 3002);
  if (!bind || bind === "0.0.0.0" || bind === "::" || !deps.internalToken) {
    log("data browser channel disabled: set DOCKIFY_DATA_CHANNEL_BIND to the control-plane address");
    return { stop: async () => {} };
  }
  const server = createDataChannel({
    db: deps.db,
    docker: new EngineDataPort(runtime.docker),
    token: deps.internalToken,
    credentials: deps.data.credentials,
    connectPg,
    dial: runtime.dial,
  });
  const terminals = attachTerminalChannel(server, { db: deps.db, docker: new EngineTerminalPort(runtime.docker), token: deps.internalToken, log });
  server.listen(port, bind);
  return {
    async stop() {
      await terminals.closeAll();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
