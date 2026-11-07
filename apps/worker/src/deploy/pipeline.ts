/**
 * The deploy job. One writer per deployment: only this handler writes building, deploying and the
 * terminal statuses. The api only moves an in-flight deployment to `cancelling`; this handler sees
 * that, unwinds and writes `cancelled`. What a deployment is gets pinned as soon as it is known
 * (commit sha after the clone, image id after the build), so a retry never rebuilds and never ships
 * a newer branch head, and a rollback reuses the image by id.
 */
import { enqueue, type Db, type Prisma, type SecretVault } from "@dockify/db";
import type { DockerPort } from "../data/docker-port.ts";
import { EngineDataPort } from "../data/engine-port.ts";
import { deployManagedService, ManagedServiceError } from "../data/managed.ts";
import { isServiceKind } from "../data/requests.ts";
import type { ClaimedJob } from "../queue.ts";
import { buildCacheScope } from "@dockify/engine";
import { pullAuth, pullImage } from "./pull.ts";
import { recordCommitAuthor } from "./commit-author.ts";
import type { DeployConfig } from "./config.ts";
import { canonicalName, PROXY_CONTAINER } from "./containers.ts";
import { DockerClient, isNotFound, type DockerApi, type ImageInfo } from "@dockify/engine";
import { openSnapshot, resolveEnv, rollbackEnv, runtimeEnv, sealSnapshot, type ResolvedVar } from "./env.ts";
import { DeployCancelled, isPermanent, PermanentDeployError, reason } from "@dockify/engine";
import { checkout, discard, repoHost } from "./git.ts";
import { installationCredential } from "./github.ts";
import { queueIconFetch } from "../icons/index.ts";
import { routableHosts } from "../edge/hosts.ts";
import { writeObservedStatus } from "../observe/app-status.ts";
import { dbSink, DeployLog } from "./log.ts";
import { runReleaseCommand } from "./release-command.ts";
import { digestOf, digestRef, pinFits, pinOf } from "../data/images.ts";
import { routedHosts } from "./routes.ts";
import { closeSteps, parseSteps, setStep, stepDone, type Step, type StepId, type StepStatus } from "./steps.ts";
import { RolledBackError, swap, type SwapApp, type SwapDeps } from "./swap.ts";
import { assertRoomToBuild, hostDiskUsage, type DiskUsageReader } from "./disk-guard.ts";
import type { Builder, Dialer, RouteStore, ServerRuntime } from "../server/runtime.ts";
import type { EdgeMode } from "../edge/ingress.ts";
import { type CertificateCheck, ensurePreviewDb, ensurePreviewNetwork, loadPreviewContext, previewReleaseInput, previewSwap, previewVars, promotePreview, settlePreview, type PreviewContext } from "./preview.ts";

export interface DeployDeps {
  db: Db;
  vault: SecretVault;
  docker: DockerApi;
  config: DeployConfig;
  serverId: string;
  routes: RouteStore;
  mode: EdgeMode;
  dial: Dialer;
  builder: Pick<Builder, "build">;
  host: ServerRuntime["host"];
  /** Overrides for tests (readiness timing, route settle). */
  swap?: Partial<Pick<SwapDeps, "probe" | "settleMs">>;
  cancelPollMs?: number;
  /** The data module's Docker port for managed services; by default the same client, wrapped. */
  services?: DockerPort;
  /** Overrides how the commit author lookup reaches GitHub, for tests. */
  commitAuthorFetch?: typeof fetch;
  /** Overrides how the disk guard reads the disk, for tests. */
  diskUsage?: DiskUsageReader;
  /** Direct TLS only: lets a preview wait for its certificate before it says Ready. */
  certificateReady?: CertificateCheck;
}

export interface DeployJobPayload {
  deploymentId: string;
}

export const IN_FLIGHT = ["queued", "building", "deploying", "cancelling"] as const;
const RUNNING = ["queued", "building", "deploying"] as const;

export function parsePayload(p: unknown): DeployJobPayload {
  const id = (p as { deploymentId?: unknown } | null)?.deploymentId;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new PermanentDeployError("deploy job payload has no deploymentId");
  return { deploymentId: id };
}

const loadDeployment = (db: Db, id: string) =>
  db.deployment.findUnique({
    where: { id },
    include: {
      app: {
        include: {
          gitInstallation: true,
          environment: { include: { project: { include: { gitInstallation: true } } } },
          volumes: { orderBy: { createdAt: "asc" } },
          domains: { orderBy: { createdAt: "asc" } },
          primaryDomain: true,
        },
      },
    },
  });
type Loaded = NonNullable<Awaited<ReturnType<typeof loadDeployment>>>;

/** The lowest TCP port an image says it listens on, or null. */
export function exposedPort(image: Pick<ImageInfo, "Config">): number | null {
  const ports = Object.keys(image.Config?.ExposedPorts ?? {}).flatMap((k) => {
    const m = /^(\d{1,5})(?:\/tcp)?$/.exec(k);
    const n = m ? Number(m[1]) : 0;
    return n >= 1 && n <= 65535 ? [n] : [];
  });
  return ports.length ? Math.min(...ports) : null;
}

/** `routed`: the hosts the app's route file has now, which keep their router while DNS cannot be checked. */
export function toSwapApp(app: Loaded["app"], routed: ReadonlySet<string> = new Set()): SwapApp {
  const sysctls: Record<string, string> = {};
  for (const [k, v] of Object.entries((app.sysctls ?? {}) as Record<string, unknown>)) if (typeof v === "string") sysctls[k] = v;
  const hosts = app.domains.map((d) => d.hostname);
  const primary = app.primaryDomain?.hostname;
  const ordered = primary ? [primary, ...hosts.filter((h) => h !== primary)] : hosts;
  const dns = new Map(app.domains.map((d) => [d.hostname, d.dnsStatus as string]));
  return {
    id: app.id,
    kind: app.kind,
    environmentId: app.environmentId,
    projectId: app.environment.projectId,
    port: app.port,
    startCommand: app.startCommand?.trim() || null,
    memoryLimitMb: app.memoryLimitMb,
    cpuLimit: app.cpuLimit,
    pidsLimit: app.pidsLimit,
    capAdd: [...app.capAdd],
    sysctls,
    volumes: app.volumes.map((v) => ({ id: v.id, name: v.name, mountPath: v.mountPath })),
    hosts: ordered,
    routeHosts: routableHosts(ordered.map((h) => ({ hostname: h, dnsStatus: dns.get(h) ?? "unchecked" })), { routed }),
    health: {
      path: app.healthCheckPath?.trim() || null,
      expectedStatus: app.healthExpectedStatus,
      timeoutSeconds: app.healthTimeoutSeconds,
      graceSeconds: app.healthGraceSeconds,
      intervalSeconds: app.healthIntervalSeconds,
      windowSeconds: 120,
    },
  };
}

class Tracker {
  steps: Step[];
  private readonly db: Db;
  private readonly id: string;
  constructor(db: Db, id: string, raw: unknown) {
    this.db = db;
    this.id = id;
    this.steps = parseSteps(raw, new Date().toISOString());
  }
  async set(id: StepId, status: StepStatus, extra: Prisma.DeploymentUpdateInput = {}): Promise<void> {
    this.steps = setStep(this.steps, id, status, new Date().toISOString());
    await this.db.deployment.update({ where: { id: this.id }, data: { ...extra, steps: this.steps as unknown as Prisma.InputJsonValue } });
  }
}

/** A person pressed Cancel: the row says so now, whatever the poll has seen yet. */
export async function cancelAsked(db: Pick<Db, "deployment">, id: string): Promise<boolean> {
  const r = await db.deployment.findUnique({ where: { id }, select: { status: true } });
  return r?.status === "cancelling";
}
export const LATE_CANCEL = "the cancel came after the new version was already serving, so this deployment stays live";

/** Writes a terminal status only if the deployment is still in flight: one writer, no flip-flop. */
async function settle(db: Db, id: string, status: "ready" | "failed" | "cancelled", steps: Step[], error: string | null, rolledBack = false): Promise<boolean> {
  const now = new Date();
  const finalSteps = status === "ready" ? steps : closeSteps(steps, status, now.toISOString());
  const n = await db.deployment.updateMany({
    where: { id, status: { in: [...IN_FLIGHT] } },
    data: { status, finishedAt: now, error, rolledBack, steps: finalSteps as unknown as Prisma.InputJsonValue },
  });
  return n.count === 1;
}

/** Mail for whoever started the deploy; best effort, so a full queue never fails the settle. */
async function queueFailureNotice(db: Db, deploymentId: string): Promise<void> {
  await enqueue(db, { kind: "deploy_notify", lane: "maintenance", payload: { deploymentId }, dedupeKey: `deploy_notify:${deploymentId}`, maxAttempts: 5 }).catch(() => undefined);
}

/** The green or red tick on the commit; best effort like the notice. Previews have their own, in the sticky comment's job. */
async function queueCommitStatus(db: Db, deploymentId: string): Promise<void> {
  await enqueue(db, { kind: "deploy_status", lane: "maintenance", payload: { deploymentId }, dedupeKey: `deploy_status:${deploymentId}`, maxAttempts: 5 }).catch(() => undefined);
}

/**
 * App.status only ever comes from what the daemon reports, by the observe pass's own rule
 * (observe/app-status.ts): a first deploy that failed with no container left reads failed, an app
 * that went live and lost its container reads missing.
 */
async function observeApp(deps: Pick<DeployDeps, "db" | "docker">, appId: string): Promise<void> {
  let container: { id: string; state: string; health: string | null; startedAt: string | null } | null = null;
  try {
    const info = await deps.docker.inspectContainer(canonicalName(appId));
    container = { id: info.Id, state: info.State.Status, health: info.State.Health?.Status ?? null, startedAt: info.State.StartedAt ?? null };
  } catch (e) {
    if (!isNotFound(e)) return;
  }
  await writeObservedStatus(deps.db, appId, container).catch(() => null);
}

/**
 * A push that landed while this deploy ran was coalesced into App.pendingDeployAt. Once the deploy
 * settles, promote it to a fresh deployment of the branch head, under the same per-app lock and
 * dedupe key the api's enqueue uses.
 */
export async function promotePending(db: Db, appId: string): Promise<string | null> {
  return db.$transaction(async (tx) => {
    const key = `deploy:${appId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const app = await tx.app.findUnique({ where: { id: appId }, select: { pendingDeployAt: true, gitBranch: true, desiredState: true, serverId: true } });
    if (!app?.pendingDeployAt || app.desiredState !== "running") return null;
    // Scoped like requestDeployTx: a preview in flight must not lose the push, nothing would retry it.
    const open = await tx.deployment.findFirst({ where: { appId, previewId: null, status: { in: [...IN_FLIGHT] } }, select: { id: true } });
    if (open) return null;
    const now = new Date().toISOString();
    const dep = await tx.deployment.create({
      data: { appId, serverId: app.serverId, trigger: "push", branch: app.gitBranch, actorType: "system", actorName: "Dockify", steps: [{ id: "queued", status: "done", startedAt: now, finishedAt: now }] },
      select: { id: true },
    });
    await tx.job.create({ data: { kind: "deploy", lane: "deploy", serverId: app.serverId, payload: { deploymentId: dep.id, appId }, dedupeKey: key } });
    await tx.app.update({ where: { id: appId }, data: { pendingDeployAt: null, status: "deploying" } });
    return dep.id;
  });
}

export const ORPHAN_ERROR = "The worker stopped before this deployment finished";
/** A deployment younger than this is never treated as orphaned (its job is created in the same transaction). */
const ORPHAN_MIN_AGE_MS = 2 * 60_000;

/**
 * Deployments still in flight whose deploy job is gone: completed, failed (for example by
 * failExhausted after three dead workers) or deleted. Nothing will ever run them, and an in-flight
 * row blocks every later deploy, push, env apply, rollback and alert of the app, so each is settled
 * (cancelled if a cancel was asked for, else failed), its app status is re-read from the daemon, and
 * a coalesced push is promoted. Runs on a timer.
 */
export async function settleOrphanedDeployments(deps: Pick<DeployDeps, "db" | "docker" | "serverId">, now = Date.now()): Promise<string[]> {
  const { db } = deps;
  const cutoff = new Date(now - ORPHAN_MIN_AGE_MS);
  const rows = await db.$queryRaw<{ id: string; appId: string; previewId: string | null; status: string; steps: unknown }[]>`
    SELECT d.id, d."appId", d."previewId", d.status::text AS status, d.steps FROM deployments d
    WHERE d.status IN ('queued', 'building', 'deploying', 'cancelling')
      AND d.provider = 'dockify'
      AND d."serverId" = ${deps.serverId}::uuid
      AND d."createdAt" < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM jobs j
        WHERE j.kind = 'deploy' AND j."completedAt" IS NULL AND j."failedAt" IS NULL
          AND j.payload->>'deploymentId' = d.id::text)`;
  const settled: string[] = [];
  for (const r of rows) {
    const steps = parseSteps(r.steps, new Date(now).toISOString());
    const ok = r.status === "cancelling"
      ? await settle(db, r.id, "cancelled", steps, null)
      : await settle(db, r.id, "failed", steps, ORPHAN_ERROR);
    if (!ok) continue;
    settled.push(r.id);
    if (r.previewId) {
      const pd = await db.previewDeployment.findUnique({ where: { id: r.previewId }, select: { envId: true } });
      if (pd) await settlePreview(db, pd.envId).catch(() => {});
      continue;
    }
    await observeApp(deps, r.appId);
    await promotePending(db, r.appId).catch(() => null);
  }
  return settled;
}

export async function handleDeploy(deps: DeployDeps, job: ClaimedJob, shutdown: AbortSignal): Promise<void> {
  const { db, vault, docker, config } = deps;
  const { deploymentId } = parsePayload(job.payload);
  const dep = await loadDeployment(db, deploymentId);
  if (!dep || !(IN_FLIGHT as readonly string[]).includes(dep.status)) return;

  const log = new DeployLog(dbSink(db, deploymentId));
  const track = new Tracker(db, deploymentId, dep.steps);
  // A preview deployment runs its own container and never touches the app row.
  const preview: PreviewContext | null = dep.previewId ? await loadPreviewContext(db, dep.previewId) : null;
  const observe = async () => {
    if (preview) await settlePreview(db, preview.envId).catch(() => {});
    // The mirror says what a Vercel app is; no container here does not mean it is down.
    else if (dep.app.deployTarget !== "vercel") await observeApp(deps, dep.appId);
  };
  // A job queued before the app moved to Vercel builds nothing: Vercel hosts it, so this would be a second copy.
  const onVercel = dep.app.deployTarget === "vercel";
  if (dep.status === "cancelling" || onVercel || (dep.previewId && !preview)) {
    log.system(dep.status === "cancelling" ? "cancelled before the build started" : onVercel ? "this app is hosted on Vercel, so nothing is built here" : "the preview was removed before the build started");
    await log.flush();
    await settle(db, deploymentId, "cancelled", track.steps, null);
    await observe();
    return;
  }

  const claimed = await db.deployment.updateMany({
    where: { id: deploymentId, status: { in: [...RUNNING] } },
    data: { status: "building", ...(dep.startedAt ? {} : { startedAt: new Date() }) },
  });
  if (claimed.count === 0) return handleDeploy(deps, job, shutdown);
  if (job.attempts > 1) log.system(`attempt ${job.attempts} of ${job.maxAttempts}; reusing whatever earlier attempts pinned`);

  // Cancel arrives as a status change; poll for it and abort the running step.
  const cancel = new AbortController();
  const poll = setInterval(() => {
    void db.deployment.findUnique({ where: { id: deploymentId }, select: { status: true } }).then((r) => {
      if (r?.status === "cancelling") cancel.abort();
    }, () => {});
  }, deps.cancelPollMs ?? 2_000);
  poll.unref?.();
  const signal = AbortSignal.any([cancel.signal, shutdown]);
  const checkCancel = () => {
    if (cancel.signal.aborted) throw new DeployCancelled();
    if (shutdown.aborted) throw new Error("the worker is shutting down; the deploy will resume");
  };
  /**
   * The cancel check at the last point a cancel can still win: the row itself, not the poll, which can
   * be up to cancelPollMs behind. A Cancel pressed in the last seconds of a build otherwise read as
   * cancelled in the activity while the deploy went on to serve.
   */
  const checkCancelNow = async () => {
    checkCancel();
    if (await cancelAsked(db, deploymentId)) {
      cancel.abort();
      throw new DeployCancelled();
    }
  };
  /** A cancel that came once the new version was serving: it is overruled, and the log says so. */
  const noteLateCancel = async () => {
    if (cancel.signal.aborted || (await cancelAsked(db, deploymentId).catch(() => false))) log.system(LATE_CANCEL);
  };

  const app = dep.app;
  let checkoutRoot: string | null = null;
  let retrying = false;
  // Who wrote the commit, once it is known: best effort, it can neither fail nor hold up the deploy.
  const noteAuthor = async (sha: string | null) => {
    if (!sha || !app.gitRepository) return;
    await recordCommitAuthor({ db, vault, apiBase: config.githubApiBase, ...(deps.commitAuthorFetch ? { fetch: deps.commitAuthorFetch } : {}) }, dep, app.gitRepository, sha, app.environment.project.gitInstallation?.installationId ?? null);
  };
  try {
    // A managed Postgres or Redis never takes the generic path below: no project variables, its own
    // credentials, its named volume and a pinned image (data/managed.ts).
    if (isServiceKind(app.kind)) {
      if (preview) throw new PermanentDeployError("a managed service is never deployed into a preview");
      await deployService(deps, dep, track, log, checkCancel);
      return;
    }
    // Env first: an undecryptable value fails before any expensive build.
    let vars: ResolvedVar[];
    if (dep.envSecretId) {
      vars = await openSnapshot(db, vault, dep.envSecretId);
    } else if (dep.trigger === "rollback" && dep.rollbackOfId) {
      const target = await db.deployment.findUnique({ where: { id: dep.rollbackOfId }, select: { envSecretId: true } });
      if (!target?.envSecretId) throw new PermanentDeployError("the rollback target has no env snapshot to restore");
      // Only the image and plain values roll back; secrets and removed keys follow today's env.
      const current = await resolveEnv(db, vault, { projectId: app.environment.projectId, environmentId: app.environmentId, appId: app.id });
      const rolled = rollbackEnv(await openSnapshot(db, vault, target.envSecretId), current);
      vars = rolled.vars;
      await sealSnapshot(db, vault, deploymentId, vars);
      log.system("restored the plain env values the rollback target shipped with");
      if (rolled.secretsKeptCurrent.length) log.system(`secrets keep their current values (a rollback never restores a rotated secret): ${rolled.secretsKeptCurrent.join(", ")}`);
      if (rolled.notRestored.length) log.system(`variables removed since then stay removed: ${rolled.notRestored.join(", ")}`);
    } else {
      vars = await resolveEnv(db, vault, { projectId: app.environment.projectId, environmentId: app.environmentId, appId: app.id });
      if (preview?.isolation === "own") {
        const withheld = vars.filter((v) => v.isSecret).map((v) => v.key);
        log.system(`this preview runs on its own network, without production's services${withheld.length ? `. An app that needs these fails here: ${withheld.join(", ")}` : ""}. A project owner can allow them in Preview settings.`);
      }
      if (preview) vars = previewVars(vars, preview, preview.isolatedDb ? await ensurePreviewDb(db, docker, preview, log, signal) : null);
      await sealSnapshot(db, vault, deploymentId, vars);
      if (preview?.fromFork) log.system("pull request from a fork: built and run without any secret");
    }
    // A retry reopens the snapshot, sealed under the setting of its day: apply today's. A recreated
    // preview database has a new password, too.
    if (preview && dep.envSecretId) vars = previewVars(vars, preview, preview.isolatedDb ? await ensurePreviewDb(db, docker, preview, log, signal) : null);
    log.redactor.conceal(vars.filter((v) => v.isSecret).map((v) => v.value));
    log.system(`this deploy has ${vars.length} ${vars.length === 1 ? "variable" : "variables"}, read when it started`);
    checkCancel();

    // The image: reuse a pinned one, pull an image app, or clone and build.
    let imageId = dep.imageId;
    // Defence in depth for the api's preview-promotion refusal: never run an image that was built
    // for a preview (fork/PR code) in the live app, whatever row pinned it here.
    if (imageId && !dep.previewId) {
      const fromPreview = await db.deployment.findFirst({ where: { imageId, previewId: { not: null } }, select: { id: true } });
      if (fromPreview) throw new PermanentDeployError("refusing to run a preview-built image in the live app");
    }
    if (imageId) {
      const present = await docker.inspectImage(imageId).then(() => true, (e) => (isNotFound(e) ? false : Promise.reject(e)));
      if (present) {
        log.system(`reusing pinned image ${imageId.slice(0, 19)}; no rebuild`);
        for (const s of ["clone", "build", "push"] as const) if (!stepDone(track.steps, s)) await track.set(s, "skipped");
        await noteAuthor(dep.commitSha);
      } else if (dep.trigger === "rollback") {
        throw new PermanentDeployError(`the image ${imageId.slice(0, 19)} of the rollback target is no longer on this server`);
      } else {
        log.system("the pinned image is gone; building the pinned commit again");
        imageId = null;
      }
    }
    let plannedAppPort: number | null = null;
    // A reused image takes no new room, so a rollback still works on a full disk; a build or a pull does.
    if (!imageId) await assertRoomToBuild(deps.diskUsage ?? hostDiskUsage(deps.host));
    if (!imageId && app.image) {
      await track.set("clone", "skipped");
      await track.set("build", "running");
      // A template's image runs the digest its first pull recorded until its image is changed, from
      // this server's copy when it has one; any other image app pulls its tag, as its owner expects a
      // redeploy to (pull.ts runs the copy here only when that pull fails on the way).
      const pinned = app.pinImage && pinFits(app.pinnedImage, app.image) ? app.pinnedImage : null;
      const auth = await pullAuth(db, vault, app.registryId, app.image);
      const pulled = await pullImage(docker, pinned ? digestRef(pinned) : app.image, auth, log, signal, { localFirst: !!pinned });
      imageId = pulled.imageId;
      if (app.pinImage && !pinned) {
        const digest = digestOf(pulled.imageRef);
        if (digest) await deps.db.app.update({ where: { id: app.id }, data: { pinnedImage: pinOf(app.image, digest) } });
      }
      await track.set("build", "done", { imageId, imageRef: pulled.imageRef });
      await track.set("push", "skipped");
    } else if (!imageId) {
      if (!app.gitRepository) throw new PermanentDeployError("the app has neither an image nor a repository");
      await track.set("clone", "running");
      const host = repoHost(app.gitRepository);
      const credential = await installationCredential({ db, vault, apiBase: config.githubApiBase }, (app.gitInstallation ?? app.environment.project.gitInstallation)?.installationId ?? null, host);
      const branch = dep.branch ?? app.gitBranch ?? app.environment.branch;
      const co = await checkout({
        url: app.gitRepository,
        branch,
        commit: dep.commitSha,
        root: config.buildRoot,
        credential,
        timeoutMs: config.cloneTimeoutMs,
        maxBytes: config.maxRepoBytes,
        signal,
      });
      checkoutRoot = co.root;
      log.system(`checked out ${co.commit.slice(0, 12)}${co.subject ? ` ${co.subject}` : ""} from ${branch}`);
      await track.set("clone", "done", { commitSha: co.commit, branch, ...(dep.message ? {} : { message: co.subject }) });
      await noteAuthor(co.commit);
      checkCancel();

      await track.set("build", "running");
      const built = await deps.builder.build({
        checkoutDir: co.dir,
        checkoutRoot: co.root,
        rootDir: app.rootDir ?? "",
        dockerfilePath: app.dockerfilePath ?? "",
        builder: app.builder,
        installCommand: app.installCommand?.trim() ?? "",
        buildCommand: app.buildCommand?.trim() ?? "",
        startCommand: app.startCommand?.trim() ?? "",
        cacheScope: buildCacheScope(app.id, preview),
        appId: app.id,
        deploymentId,
        vars,
        timeoutMs: config.buildTimeoutMs,
      }, log, signal);
      imageId = built.imageId;
      plannedAppPort = built.port ?? null;
      await track.set("build", "done", { imageId, imageRef: built.imageRef });
      // Images stay on this daemon; there is no registry push.
      await track.set("push", "skipped");
      await discard(co.root);
      checkoutRoot = null;
    }
    checkCancel();

    // A domain with no port is an app nobody could reach: what this build knows settles the port, for good.
    if (app.port === null && app.domains.length && imageId) {
      const port = plannedAppPort ?? exposedPort(await docker.inspectImage(imageId));
      if (port !== null) {
        await db.app.updateMany({ where: { id: app.id, port: null }, data: { port } });
        app.port = port;
        log.system(`the app has a domain and no port: using ${port}, as the build detected. Change it in the app's Settings.`);
      }
    }
    const swapApp = toSwapApp(app, await routedHosts(deps.routes, app.id));
    const env = runtimeEnv(vars, app.port);

    // A preview with no database of its own never runs the PR's release command: it would hit the base's, or none.
    const releaseCommand = preview && !preview.isolatedDb ? undefined : app.releaseCommand?.trim();
    if (preview && !preview.isolatedDb && app.releaseCommand?.trim()) log.system(`release command skipped: this preview ${preview.isolation === "base" ? "shares the base environment's database" : "has no database"} (turn on an isolated database to run it)`);
    if (releaseCommand && !stepDone(track.steps, "release")) {
      await track.set("release", "running");
      // A preview's image may be a fork's: its release command gets the preview's isolation, never the app's.
      const pinned = imageId;
      if (preview) await ensurePreviewNetwork(docker, preview);
      await runReleaseCommand(docker, swapApp, {
        command: releaseCommand, imageId, env, deploymentId, timeoutMs: config.releaseTimeoutMs,
        ...(preview ? { input: (name: string, command: string) => previewReleaseInput(preview, { name, command, imageId: pinned, env, deploymentId }) } : {}),
      }, log, signal);
      await track.set("release", "done");
    } else if (releaseCommand) {
      log.system("the release command already ran for this deployment; not running it twice");
    } else if (!stepDone(track.steps, "release")) {
      await track.set("release", "skipped");
    }
    await checkCancelNow();

    await db.deployment.updateMany({ where: { id: deploymentId, status: "building" }, data: { status: "deploying" } });
    await track.set("deploy", "running");
    await track.set("health", "running");
    if (preview) {
      const out = await previewSwap(
        { id: app.id, port: app.port, startCommand: swapApp.startCommand, health: swapApp.health },
        preview, deploymentId, imageId, env,
        { docker, log, routes: deps.routes, mode: deps.mode, dial: deps.dial, proxyContainer: PROXY_CONTAINER, dashboardHost: config.dashboardHost, ...(deps.swap?.probe ? { probe: deps.swap.probe } : {}), ...(deps.certificateReady ? { certificateReady: deps.certificateReady } : {}) },
        signal,
      );
      track.steps = setStep(setStep(track.steps, "health", "done", new Date().toISOString()), "deploy", "done", new Date().toISOString());
      log.system(`preview ready at https://${preview.hostname}`);
      await noteLateCancel();
      await log.flush();
      await settle(db, deploymentId, "ready", track.steps, null);
      await db.previewDeployment.update({ where: { id: preview.pdId }, data: { currentDeploymentId: deploymentId, containerId: out.containerId } });
      await settlePreview(db, preview.envId);
      return;
    }
    const result = await swap(swapApp, deploymentId, imageId, env, {
      docker,
      log,
      routes: deps.routes,
      mode: deps.mode,
      dial: deps.dial,
      proxyContainer: PROXY_CONTAINER,
      dashboardHost: config.dashboardHost,
      ...deps.swap,
    }, signal);
    track.steps = setStep(setStep(track.steps, "health", "done", new Date().toISOString()), "deploy", "done", new Date().toISOString());

    // Past the route flip a late cancel is overruled: what is serving is this deployment.
    log.system(result.mode === "zero_downtime" ? "deployed with zero downtime" : "deployed (stop then start)");
    await noteLateCancel();
    await log.flush();
    await settle(db, deploymentId, "ready", track.steps, null);
    await db.app.update({ where: { id: app.id }, data: { currentDeploymentId: deploymentId, containerId: result.containerId, status: "running", desiredState: "running" } });
    await queueCommitStatus(db, deploymentId);
    if (app.kind === "frontend") await queueIconFetch(db, app.id);
  } catch (e) {
    // Only a person cancels. The swap and the release command abort on either signal and throw
    // DeployCancelled for both, and a shutdown would otherwise read as a cancel, or use up the last attempt.
    if (cancel.signal.aborted) {
      log.system("deploy cancelled; whatever was serving before still serves");
      await log.flush();
      await settle(db, deploymentId, "cancelled", track.steps, null);
      await observe();
      return;
    }
    if (shutdown.aborted) {
      log.system("the worker is shutting down; the deploy will resume when it is back");
      await log.flush();
      await db.deployment.updateMany({ where: { id: deploymentId, status: { in: ["building", "deploying"] } }, data: { status: "queued" } });
      retrying = true;
      throw e;
    }
    const message = log.redactor.line(reason(e));
    const last = isPermanent(e) || job.attempts >= job.maxAttempts;
    if (!last) {
      log.error(`${message} (will retry)`);
      await log.flush();
      // Back to queued so the timeline reads truthfully while it waits.
      await db.deployment.updateMany({ where: { id: deploymentId, status: { in: ["building", "deploying"] } }, data: { status: "queued" } });
      retrying = true;
      throw new Error(message);
    }
    log.error(message);
    await log.flush();
    // A readiness failure that left the previous container serving shows the "rolled back" badge.
    const failed = await settle(db, deploymentId, "failed", track.steps, message, e instanceof RolledBackError);
    if (failed && !preview) {
      await queueFailureNotice(db, deploymentId);
      await queueCommitStatus(db, deploymentId);
    }
    await observe();
  } finally {
    clearInterval(poll);
    // Not awaited: a multi-GB checkout must not hold the claim open past a stop grace period,
    // where a SIGKILL would skip the release and spend the attempt. Each checkout has its own
    // directory under the build root, so a removal still running never touches a later deploy.
    if (checkoutRoot) void discard(checkoutRoot).catch(() => {});
    await log.flush();
    if (!retrying) await (preview ? promotePreview(db, preview.pdId) : promotePending(db, app.id)).catch(() => null);
  }
}

/**
 * The deploy of a managed Postgres or Redis (data/managed.ts does the container work). Settles
 * the deployment and the app row on success; on failure it throws for handleDeploy's own retry,
 * cancel and settle rules, as a RolledBackError when the previous container runs again.
 */
async function deployService(deps: DeployDeps, dep: Loaded, track: Tracker, log: DeployLog, checkCancel: () => void): Promise<void> {
  const { db, vault } = deps;
  const port = deps.services ?? new EngineDataPort(deps.docker as DockerClient);
  for (const s of ["clone", "push", "release"] as const) if (!stepDone(track.steps, s)) await track.set(s, "skipped");
  await track.set("build", "running");
  let out;
  try {
    out = await deployManagedService(
      {
        db, vault, docker: port, log: (line) => log.system(line), checkpoint: checkCancel,
        onImage: async ({ imageId, pin }) => {
          await track.set("build", "done", { imageId, ...(pin ? { imageRef: pin } : {}) });
          await db.deployment.updateMany({ where: { id: dep.id, status: "building" }, data: { status: "deploying" } });
          await track.set("deploy", "running");
          await track.set("health", "running");
        },
      },
      dep.app.id,
      { imageId: dep.trigger === "rollback" ? dep.imageId : null },
    );
  } catch (e) {
    if (e instanceof ManagedServiceError && e.rolledBack && e.permanent) throw new RolledBackError(e.message);
    throw e;
  }
  const now = new Date().toISOString();
  track.steps = setStep(setStep(track.steps, "health", "done", now), "deploy", "done", now);
  log.system("deployed (stop then start: a database has one writer)");
  await log.flush();
  await settle(db, dep.id, "ready", track.steps, null);
  await db.app.update({ where: { id: dep.app.id }, data: { currentDeploymentId: dep.id, containerId: out.containerId, status: "running", desiredState: "running" } });
}
