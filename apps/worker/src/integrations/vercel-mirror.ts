/**
 * The Vercel deployment mirror. Every app linked to a Vercel project (deployTarget "vercel") shows
 * that project's deployments as ordinary deployment rows with provider "vercel", whoever started
 * them: this dashboard, a push through Vercel's Git integration, or the Vercel CLI. It only reads
 * Vercel and only writes these rows and the linked apps' status. Runs as vercel_mirror jobs:
 *
 *   { projectId }                 one Vercel project, queued by a verified webhook delivery
 *   { projectId, deploymentId }   the same, after Vercel said that deployment was deleted
 *   {}                            every linked project, queued by the timer below as the backstop, or by Sync now
 *
 * A Vercel project can be linked by several apps (one per environment) while a deployment has one
 * row, so each deployment goes to one app: see pickApp.
 *
 * A deployment deleted on Vercel goes from the list too. Nothing is removed on a webhook's word or on
 * absence alone: a row is removed only once Vercel answers 404 (or DELETED) for it by id, and only a
 * row the mirror itself copied in. A deploy Dockify started there keeps its row.
 */
import { enqueue, enqueueTx, readSecretValue, type AppStatus, type Db, type DeploymentStatus, type Prisma, type SecretVault } from "@dockify/db";
import { jsonOf, type HttpClient } from "@dockify/net-guard";
import { httpsOfHost, safeInspectorUrl } from "./vercel-host.ts";
import { VERCEL_API, vercelTargetFor } from "./vercel-target.ts";

const MIRROR_LIST_LIMIT = 50;
/** A webhook covers the gap, so the timer is only a backstop then. Without one the timer is all there is. */
const WITH_WEBHOOK_MS = 10 * 60_000;
const WITHOUT_WEBHOOK_MS = 2 * 60_000;
/** A deployment in flight is read this often whatever else holds, so it does not look stuck. */
const IN_FLIGHT_MS = 30_000;
/** A deploy Dockify started that Vercel never accepted, with no job left to say so. */
const NEVER_ACCEPTED_MS = 40 * 60_000;
/**
 * How long after it ended a failure nobody saw in flight is still news. A new link's backfill is
 * older than this, so it stays quiet. Longer than the slowest pass, so a pass never misses one.
 */
const FAILURE_NEWS_MS = 15 * 60_000;
/** The most failures one pass announces; a burst drains over the next passes. */
const NOTICES_PER_PASS = 10;
/** The most deployments one pass asks Vercel about by id because the list no longer shows them. */
const GONE_LOOKUPS_PER_PASS = 20;
/** Who started a row Dockify itself sent to Vercel; every other Vercel row was copied in by the mirror. */
const STARTED_HERE = ["user", "token"] as const;
export const REMOVED_ACTION = "vercel.deployments.removed";
export const NOT_FOLLOWED = "This app no longer deploys to Vercel, so Dockify stopped following this deployment";

export class VercelMirrorError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = "VercelMirrorError";
    this.permanent = permanent;
  }
}

/** One deployment as GET /v7/deployments and GET /v13/deployments/:id send it. */
export interface VercelDeployment {
  uid?: string;
  id?: string;
  url?: string | null;
  inspectorUrl?: string | null;
  created?: number;
  createdAt?: number;
  buildingAt?: number | null;
  ready?: number | null;
  state?: string;
  readyState?: string;
  target?: string | null;
  source?: string | null;
  creator?: { username?: string | null; githubLogin?: string | null } | null;
  meta?: Record<string, unknown> | null;
  errorMessage?: string | null;
  errorCode?: string | null;
}

export function mapDeploymentState(s: string | undefined): DeploymentStatus {
  switch (s) {
    case "READY": return "ready";
    case "ERROR": return "failed";
    case "CANCELED":
    case "DELETED": return "cancelled";
    case "BUILDING":
    case "INITIALIZING": return "building";
    // QUEUED, BLOCKED (a check holds it) and anything newer: it has not started as far as we can tell.
    default: return "queued";
  }
}

const TERMINAL: ReadonlySet<DeploymentStatus> = new Set(["ready", "failed", "cancelled"]);

/** Text from a third party, for one line of the page: no control characters, bounded. */
const plainText = (v: unknown, max = 500): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
  return t ? t.slice(0, max) : null;
};

const META_PREFIXES = ["github", "gitlab", "bitbucket"] as const;
function gitMeta(meta: Record<string, unknown> | null | undefined, suffix: string): string | null {
  for (const p of META_PREFIXES) {
    const v = plainText(meta?.[`${p}${suffix}`]);
    if (v) return v;
  }
  return null;
}

/** A commit message's subject: its first line, cleaned afterwards so the newline is still there to find. */
function firstLine(meta: Record<string, unknown> | null | undefined): string | null {
  for (const p of META_PREFIXES) {
    const v = meta?.[`${p}CommitMessage`];
    if (typeof v === "string" && v.trim()) return v.trim().split(/[\r\n]/)[0]!;
  }
  return null;
}

/** Vercel names the source; Dockify's own trigger set says what kind of start it was. */
function triggerOf(source: string | null): "push" | "redeploy" | "api" {
  if (source === "git" || source === "git-deploy-hook") return "push";
  if (source === "redeploy") return "redeploy";
  return "api";
}

/** Everything a row takes from Vercel's record. `seen` is what the row already held, when it exists. */
export function rowFieldsOf(d: VercelDeployment, seen: { finishedAt: Date | null } | null, now: Date) {
  const status = mapDeploymentState(d.readyState ?? d.state);
  const created = new Date(d.created ?? d.createdAt ?? now.getTime());
  const finished = !TERMINAL.has(status) ? null : d.ready ? new Date(d.ready) : (seen?.finishedAt ?? (seen ? now : created));
  const source = plainText(d.source, 64);
  const login = plainText(d.creator?.githubLogin, 64)?.toLowerCase() ?? gitMeta(d.meta, "CommitAuthorLogin")?.toLowerCase() ?? null;
  const creator = plainText(d.creator?.username, 128);
  return {
    status,
    commitSha: gitMeta(d.meta, "CommitSha"),
    branch: gitMeta(d.meta, "CommitRef"),
    message: plainText(firstLine(d.meta)),
    error: status === "failed" ? (plainText(d.errorMessage) ?? plainText(d.errorCode) ?? "Vercel reports this deployment failed") : null,
    startedAt: d.buildingAt ? new Date(d.buildingAt) : null,
    finishedAt: finished,
    externalUrl: httpsOfHost(d.url),
    inspectorUrl: safeInspectorUrl(d.inspectorUrl),
    externalTarget: d.target === "production" ? ("production" as const) : ("preview" as const),
    externalSource: source,
    externalCreator: creator,
    trigger: triggerOf(source),
    // A login that a verified member linked reads as that member, like a push on this server.
    actorType: login ? ("webhook" as const) : ("system" as const),
    actorName: creator,
    gitAuthor: login,
    // A commit whose author has no login of its own still names them.
    gitAuthorName: login ? null : gitMeta(d.meta, "CommitAuthorName"),
    createdAt: created,
  };
}

export interface LinkedApp {
  id: string;
  /** For the Activity line when deployments deleted on Vercel leave this app's list. */
  name?: string;
  environment: string;
  /** The branch this app follows: its own, or its environment's. */
  branch: string | null;
  serverId: string;
}

/**
 * The one app a deployment of a shared Vercel project belongs to. Production goes to the app in a
 * production environment. A preview goes to the app that follows its branch, then to a non-production
 * app, then to whatever is linked, so an app linked alone shows both.
 */
export function pickApp(links: readonly LinkedApp[], d: { target: "production" | "preview"; branch: string | null }): LinkedApp | null {
  const prod = links.filter((a) => vercelTargetFor(a.environment) === "production");
  const rest = links.filter((a) => vercelTargetFor(a.environment) !== "production");
  if (d.target === "production") return prod[0] ?? rest[0] ?? null;
  const byBranch = d.branch ? (rest.find((a) => a.branch === d.branch) ?? prod.find((a) => a.branch === d.branch)) : undefined;
  return byBranch ?? rest[0] ?? prod[0] ?? null;
}

/** What a linked app reads as, from its own deployments and the one Vercel is serving. */
export function statusFor(rows: ReadonlyArray<{ status: DeploymentStatus; externalTarget: "production" | "preview" | null }>, production: boolean, serving: boolean): AppStatus | null {
  // Rows are newest first. In a production app a preview building says nothing about the site.
  const relevant = production ? rows.filter((r) => r.externalTarget !== "preview") : rows;
  if (relevant.some((r) => !TERMINAL.has(r.status))) return "deploying";
  if (serving) return "running";
  if (relevant[0]?.status === "failed") return "failed";
  return null;
}

/** A failure of one call, as the job should treat it. The token never appears in any of them. */
class Reader {
  private readonly http: HttpClient;
  private readonly token: string;
  private readonly teamId: string | null;
  constructor(http: HttpClient, token: string, teamId: string | null) {
    this.http = http;
    this.token = token;
    this.teamId = teamId;
  }
  private url(path: string): string {
    return `${VERCEL_API}${path}${this.teamId ? `${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(this.teamId)}` : ""}`;
  }
  async get<T>(path: string, missingOk = false): Promise<T | null> {
    const res = await this.http({ method: "GET", url: this.url(path), headers: { Authorization: `Bearer ${this.token}` }, timeoutMs: 20_000 }).catch((e: unknown) => {
      throw new VercelMirrorError(e instanceof Error ? e.message : "Vercel could not be reached", false);
    });
    if (res.status === 401 || res.status === 403) throw new VercelMirrorError("Vercel refused the stored token; reconnect Vercel", true);
    if (res.status === 404 || res.status === 410) {
      if (missingOk) return null;
      throw new VercelMirrorError("The linked Vercel project no longer exists", true);
    }
    if (res.status < 200 || res.status >= 300) throw new VercelMirrorError(`Vercel answered ${res.status}`, res.status < 429 || (res.status > 429 && res.status < 500));
    const out = jsonOf<T>(res);
    if (out === null) throw new VercelMirrorError("Vercel sent a body that is not JSON", false);
    return out;
  }
}

export interface VercelMirrorDeps {
  db: Db;
  vault: SecretVault;
  http: HttpClient;
  /** Nothing older is copied in: the janitor drops rows past this age and must not fight the mirror. */
  retentionDays: number;
  now?: () => Date;
}

/** Writes under integrations(vercel).config, with the same lock as the deploy target's sync state. */
async function setMirrorState(db: Db, id: string, patch: { triedAt: string; syncedAt?: string; error: string | null }): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dockify.integration.vercel'))`;
    const row = await tx.integration.findUnique({ where: { id }, select: { config: true } });
    const config = (row?.config ?? {}) as Record<string, unknown>;
    const mirror = { ...((config.mirror ?? {}) as Record<string, unknown>), ...patch };
    await tx.integration.update({ where: { id }, data: { config: { ...config, mirror } as Prisma.InputJsonValue } });
  });
}

/**
 * Queues the failure notice of one deployment, once ever. A job row of any age counts, and the check
 * and the insert share the key's lock, so overlapping passes, a retry or a restart cannot queue a second.
 */
async function noticeOnce(db: Db, deploymentId: string): Promise<boolean> {
  const dedupeKey = `deploy_notify:${deploymentId}`;
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dedupeKey}))`;
    if (await tx.job.findFirst({ where: { dedupeKey }, select: { id: true } })) return false;
    await enqueueTx(tx, { kind: "deploy_notify", lane: "maintenance", payload: { deploymentId }, dedupeKey, maxAttempts: 5 });
    return true;
  });
}

/**
 * Every Vercel deployment that failed lately becomes one notice. This reads the rows rather than
 * adding a call to each writer: the mirror, the deploy target's job and the sweep for a deploy Vercel
 * never accepted all write them, and a crash after a write is caught on the next pass.
 */
async function announceFailures(db: Db, now: Date): Promise<void> {
  const rows = await db.deployment.findMany({
    where: { provider: "vercel", status: "failed", finishedAt: { gt: new Date(now.getTime() - FAILURE_NEWS_MS) } },
    select: { id: true },
    orderBy: { finishedAt: "asc" },
    take: 100,
  });
  let told = 0;
  for (const r of rows) {
    if (told >= NOTICES_PER_PASS) break;
    if (await noticeOnce(db, r.id)) told += 1;
  }
}

const isDeleted = (d: VercelDeployment) => (d.readyState ?? d.state) === "DELETED";

/**
 * Removes the rows of deployments Vercel says are gone, but only rows the mirror copied in: never a
 * deploy Dockify started, never a preview of this server. One Activity line per app says so.
 */
async function removeGone(db: Db, links: LinkedApp[], gone: string[], now: Date): Promise<void> {
  if (!gone.length) return;
  const rows = await db.deployment.findMany({
    where: { provider: "vercel", appId: { in: links.map((a) => a.id) }, externalId: { in: gone }, previewId: null, actorType: { notIn: [...STARTED_HERE] } },
    select: { id: true, appId: true, externalId: true, status: true },
  });
  if (!rows.length) return;
  const removed = await db.deployment.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, provider: "vercel", actorType: { notIn: [...STARTED_HERE] } } });
  if (!removed.count) return;
  for (const app of links) {
    const mine = rows.filter((r) => r.appId === app.id);
    if (!mine.length) continue;
    await db.activityLog.create({
      data: {
        at: now, category: "deploys", action: REMOVED_ACTION, actorType: "system", actorName: "Dockify",
        verb: `removed ${mine.length} deployment${mine.length === 1 ? "" : "s"} deleted on Vercel from`,
        targetType: "app", targetId: app.id, targetLabel: app.name ?? "this app",
        changes: mine.map((r) => ({ key: r.externalId, before: r.status, after: null })) as Prisma.InputJsonValue,
      },
    });
  }
}

async function mirrorProject(deps: VercelMirrorDeps, api: Reader, projectId: string, links: LinkedApp[], now: Date, hint: string | null = null): Promise<number> {
  const { db } = deps;
  const project = encodeURIComponent(projectId);
  const since = now.getTime() - deps.retentionDays * 86_400_000;
  const listed = await api.get<{ deployments: VercelDeployment[] }>(`/v7/deployments?projectId=${project}&limit=${MIRROR_LIST_LIMIT}&since=${since}`);
  const page = listed?.deployments ?? [];
  const appIds = links.map((a) => a.id);
  const gone: string[] = [];
  // One Vercel lists as deleted is gone already, whatever else it says.
  const list = page.filter((d) => {
    const uid = d.uid ?? d.id;
    if (uid && isDeleted(d)) gone.push(uid);
    return !isDeleted(d);
  });
  const asked = new Set(page.map((d) => d.uid ?? d.id));
  const ask = async (externalId: string) => {
    asked.add(externalId);
    const one = await api.get<VercelDeployment>(`/v13/deployments/${encodeURIComponent(externalId)}`, true);
    if (one && !isDeleted(one)) list.push({ ...one, uid: externalId });
    else gone.push(externalId);
  };

  // A row in flight that fell out of the page (or was deleted on Vercel) is asked about by itself.
  const open = await db.deployment.findMany({
    where: { provider: "vercel", appId: { in: appIds }, status: { notIn: [...TERMINAL] }, externalId: { not: null } },
    select: { externalId: true },
  });
  for (const { externalId } of open) {
    if (externalId && !asked.has(externalId)) await ask(externalId);
  }

  // A finished row the list should show and does not was most likely deleted on Vercel. The page
  // covers every deployment since the retention cut when it is not full, else back to its oldest
  // entry; a row inside that span is asked about by id, and so is one a deletion webhook named.
  const oldest = Math.min(...page.map((d) => d.created ?? d.createdAt ?? Number.POSITIVE_INFINITY));
  const span = page.length < MIRROR_LIST_LIMIT ? { gte: new Date(since) } : Number.isFinite(oldest) ? { gt: new Date(oldest) } : null;
  const mirrored = { provider: "vercel" as const, appId: { in: appIds }, previewId: null, externalId: { not: null }, actorType: { notIn: [...STARTED_HERE] } };
  const missing = [
    ...(hint ? await db.deployment.findMany({ where: { ...mirrored, externalId: hint }, select: { externalId: true } }) : []),
    ...(span ? await db.deployment.findMany({ where: { ...mirrored, createdAt: span }, select: { externalId: true }, orderBy: { createdAt: "desc" }, take: 500 }) : []),
  ];
  let lookups = 0;
  for (const { externalId } of missing) {
    if (!externalId || asked.has(externalId)) continue;
    if (lookups++ >= GONE_LOOKUPS_PER_PASS) break;
    await ask(externalId);
  }

  await removeGone(db, links, gone, now);
  // What is left in flight was started here: it keeps its row, settled, since nothing will finish it.
  if (gone.length) {
    await db.deployment.updateMany({
      where: { provider: "vercel", externalId: { in: gone }, status: { notIn: [...TERMINAL] } },
      data: { status: "cancelled", finishedAt: now, error: "Vercel no longer has this deployment" },
    });
  }

  const uids = list.map((d) => d.uid ?? d.id).filter((u): u is string => !!u);
  const known = new Map(
    (await db.deployment.findMany({ where: { provider: "vercel", externalId: { in: uids } }, select: { id: true, externalId: true, status: true, finishedAt: true, actorType: true } })).map((r) => [r.externalId!, r]),
  );
  let written = 0;
  for (const d of list) {
    const uid = d.uid ?? d.id;
    if (!uid) continue;
    const seen = known.get(uid) ?? null;
    const { trigger, actorType, actorName, gitAuthor, gitAuthorName, createdAt, ...fields } = rowFieldsOf(d, seen, now);
    if (seen) {
      const wasInFlight = !TERMINAL.has(seen.status);
      // A deploy a person started keeps its trigger and actor; the rest is Vercel's to say.
      await db.deployment.update({ where: { id: seen.id }, data: { ...fields, ...(seen.actorType === "user" || seen.actorType === "token" ? {} : { actorType, actorName, gitAuthor, gitAuthorName }) } });
      // Followed in flight and now failed: news however long ago it ended, say while the worker was down.
      if (fields.status === "failed" && wasInFlight) await noticeOnce(db, seen.id);
    } else {
      const app = pickApp(links, { target: fields.externalTarget, branch: fields.branch });
      if (!app) continue;
      await db.deployment.create({ data: { ...fields, trigger, actorType, actorName, gitAuthor, gitAuthorName, createdAt, appId: app.id, serverId: app.serverId, provider: "vercel", externalId: uid } }).catch((e: unknown) => {
        // The deploy target or another pass wrote this id first: the next pass updates that row.
        if ((e as { code?: string }).code !== "P2002") throw e;
      });
    }
    written++;
  }

  // What each app is serving now. Vercel names production's current deployment; a rollback made on
  // Vercel moves it, so that is read every pass rather than guessed from the newest ready row.
  const meta = await api.get<{ targets?: { production?: { id?: string } | null } | null }>(`/v9/projects/${project}`, true);
  const productionId = meta?.targets?.production?.id ?? null;
  for (const app of links) {
    const production = vercelTargetFor(app.environment) === "production";
    const rows = await db.deployment.findMany({
      where: { appId: app.id, provider: "vercel", previewId: null },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, status: true, externalId: true, externalTarget: true },
    });
    const newestReady = rows.find((r) => r.status === "ready" && (!production || r.externalTarget === "production"));
    const serving = (production && productionId ? rows.find((r) => r.externalId === productionId) : undefined) ?? newestReady ?? null;
    const status = statusFor(rows, production, !!serving);
    const data = { ...(serving ? { currentDeploymentId: serving.id } : {}), ...(status ? { status } : {}) };
    if (Object.keys(data).length) await db.app.updateMany({ where: { id: app.id, deployTarget: "vercel" }, data });
  }
  return written;
}

/** Rows nothing will ever settle: an app moved off Vercel, a deploy Vercel never took and no job left. */
async function settleStrays(db: Db, now: Date): Promise<void> {
  await db.deployment.updateMany({
    where: { provider: "vercel", status: { notIn: [...TERMINAL] }, app: { deployTarget: { not: "vercel" } } },
    data: { status: "cancelled", finishedAt: now, error: NOT_FOLLOWED },
  });
  const stuck = await db.deployment.findMany({
    where: { provider: "vercel", externalId: null, status: { notIn: [...TERMINAL] }, createdAt: { lt: new Date(now.getTime() - NEVER_ACCEPTED_MS) } },
    select: { id: true, appId: true },
  });
  for (const r of stuck) {
    const job = await db.job.findFirst({ where: { dedupeKey: `vercel_sync:${r.appId}:deploy`, completedAt: null, failedAt: null }, select: { id: true } });
    if (job) continue;
    await db.deployment.updateMany({ where: { id: r.id, status: { notIn: [...TERMINAL] } }, data: { status: "failed", finishedAt: now, error: "Vercel never accepted this deploy" } });
  }
}

export async function runVercelMirror(deps: VercelMirrorDeps, payload: unknown): Promise<void> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const only = typeof (payload as { projectId?: unknown } | null)?.projectId === "string" ? (payload as { projectId: string }).projectId : null;
  // Only a lead: the pass asks Vercel about it and believes that answer, never the webhook's.
  const named = (payload as { deploymentId?: unknown } | null)?.deploymentId;
  const hint = only && typeof named === "string" && /^[\w-]{1,128}$/.test(named) ? named : null;
  await settleStrays(db, now);
  const row = await db.integration.findUnique({ where: { kind_name: { kind: "vercel", name: "default" } } });
  if (!row?.secretId || row.status === "disconnected") return;
  const token = await readSecretValue(db, deps.vault, row.secretId);
  if (!token) return;
  const apps = await db.app.findMany({
    where: { deployTarget: "vercel", vercelProjectId: only ?? { not: null } },
    select: { id: true, name: true, vercelProjectId: true, gitBranch: true, serverId: true, environment: { select: { name: true, branch: true } } },
    orderBy: { createdAt: "asc" },
  });
  const byProject = new Map<string, LinkedApp[]>();
  for (const a of apps) {
    const list = byProject.get(a.vercelProjectId!) ?? [];
    list.push({ id: a.id, name: a.name, environment: a.environment.name, branch: a.gitBranch?.trim() || a.environment.branch, serverId: a.serverId });
    byProject.set(a.vercelProjectId!, list);
  }
  const teamId = (row.config as { team?: { id?: string } | null } | null)?.team?.id ?? null;
  const api = new Reader(deps.http, token, teamId);
  let problem: VercelMirrorError | null = null;
  for (const [projectId, links] of byProject) {
    try {
      await mirrorProject(deps, api, projectId, links, now, hint);
    } catch (e) {
      if (!(e instanceof VercelMirrorError)) throw e;
      // One project that is gone must not hold up the others; a refused token stops them all anyway.
      problem = e;
      if (/token/.test(e.message)) break;
    }
  }
  await announceFailures(db, now);
  await setMirrorState(db, row.id, problem ? { triedAt: now.toISOString(), error: problem.message } : { triedAt: now.toISOString(), syncedAt: now.toISOString(), error: null });
  // A permanent failure has been said on the card; the next timer pass tries again, so no retries here.
  if (problem && !problem.permanent) throw problem;
}

/**
 * The periodic backstop, ticking every 30 s. A pass is due when a mirrored deployment is in flight,
 * or when the last pass is older than the webhook state allows. Costs two small reads when nothing
 * is linked, and never calls Vercel itself.
 */
export async function queueVercelMirrorIfDue(db: Db, now = Date.now()): Promise<boolean> {
  const row = await db.integration.findUnique({ where: { kind_name: { kind: "vercel", name: "default" } }, select: { secretId: true, status: true, config: true } });
  if (!row?.secretId || row.status === "disconnected") return false;
  const linked = await db.app.count({ where: { deployTarget: "vercel", vercelProjectId: { not: null } } });
  if (!linked) return false;
  const config = (row.config ?? {}) as { webhook?: { state?: string } | null; mirror?: { triedAt?: string | null } | null };
  const last = config.mirror?.triedAt ? Date.parse(config.mirror.triedAt) : 0;
  const open = await db.deployment.count({ where: { provider: "vercel", status: { notIn: [...TERMINAL] } } });
  const every = open ? IN_FLIGHT_MS : config.webhook?.state === "active" ? WITH_WEBHOOK_MS : WITHOUT_WEBHOOK_MS;
  if (now - last < every) return false;
  await enqueue(db, { kind: "vercel_mirror", lane: "maintenance", payload: {}, dedupeKey: "vercel_mirror:all", maxAttempts: 3 });
  return true;
}
