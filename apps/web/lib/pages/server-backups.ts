import "server-only";
import { connection } from "next/server";
import { apiRequest, apiStream } from "@/lib/api";
import { json as answer, NO_STORE, upstreamStatus } from "@/lib/http";
import { buildPreviewOverview } from "@/lib/preview-fixture";
import { previewSecurityOn, previewSecurityRelease } from "@/lib/preview-security";
import { previewElevated } from "@/lib/preview-step-up";
import type { SecurityRelease } from "@/lib/security-release";
import { STEP_UP_MESSAGE, STEP_UP_REQUIRED } from "@/lib/step-up";
import { TIME_ZONE_RE } from "@/lib/time-zones";
import type { AppKind, HostSnapshot, OverviewSource, Resource } from "@/lib/types";
import { isOrphan, UPDATE_STEPS } from "./server-backups-shared";
import { isPreviewMode } from "@/lib/preview-mode";
import { seeded } from "@/lib/preview-random";

export { NEW_DB_NAME } from "./server-backups-shared";

/*
 * Loader for the Server and Backups pages. Every call is in the API contract
 * (packages/contracts/src/endpoints.ts); the web app never reads the database itself, and every
 * call is bounded (lib/api.ts).
 *
 * Updates (signed, versioned releases only)
 *   A write that needs step-up answers 403 { error: "step_up_required" }; the route answers the
 *   shared refusal (lib/step-up.ts) and the page confirms it is you (components/step-up), then
 *   sends it again. The preview refuses the same writes outside its own window.
 *
 * Reads forward the session cookie with no-store, the same as fetchOverview. Without
 * DOCKIFY_API_URL the design preview (DOCKIFY_PREVIEW=1) serves fixtures derived from
 * buildPreviewOverview; otherwise the pages get no data and show their empty state.
 */

// -------------- Types --------------

export type MetricRange = "1h" | "24h" | "7d";

export interface MetricPoint {
  at: string;
  cpu: number;
  memory: number;
  disk: number;
  /** Mbps out, not a share: the link speed is often unknown. */
  network: number;
}

export interface ServerMetrics {
  range: MetricRange;
  points: MetricPoint[];
}

export type DiskSliceId = "images" | "buildCache" | "volumes" | "logs";

export interface DiskSlice {
  id: DiskSliceId;
  bytes: number;
  reclaimableBytes: number;
  /** Images, cache entries, volumes or log files counted in the slice, when known. */
  count?: number;
}

export type ContainerState = "running" | "restarting" | "unhealthy" | "exited";

export interface ContainerRow {
  id: string;
  name: string;
  /** The app it runs; null for Dockify's own containers. */
  app: { id: string; name: string; displayName?: string; projectSlug: string; environment: string; kind?: AppKind } | null;
  /** Share of the whole host's CPU. */
  cpuPct: number;
  memoryBytes: number;
  restarts: number;
  /** Null while the container is not running. */
  startedAt: string | null;
  state: ContainerState;
}

/**
 * The control plane's services: the API and Postgres by the API's own probes, the worker by its
 * heartbeat, the rest as the worker last saw their containers. redis is an id older APIs sent.
 */
export type ServiceId = "api" | "worker" | "proxy" | "postgres" | "redis" | "web" | "buildkit" | "socketProxy" | "updater" | "cloudflared";

export interface ServiceHealth {
  id: ServiceId;
  status: "ok" | "degraded" | "down";
  /** Round trip of the health probe, null when it did not answer. */
  latencyMs: number | null;
  detail: string;
}

export interface SystemInfo {
  os: string;
  kernel: string;
  docker: string;
  dockify: string;
  ip: string;
  cores: number;
  memoryBytes: number;
}

/** Dockify's own garbage collector: what it keeps, what it caps, and when it runs next. */
export interface JanitorStatus {
  /** The BuildKit cache, trimmed to its cap by size, never wiped by a timer. */
  buildCache: { bytes: number; capBytes: number };
  /** Ready images kept per app for instant rollback; the janitor never removes them. */
  pinnedImages: { count: number; bytes: number; perApp: number; apps: number };
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastFreedBytes: number | null;
}

/** The dump of Dockify's own database, taken daily and before every update. */
export interface ControlPlaneBackup {
  status: "ready" | "running" | "failed" | "none";
  lastAt: string | null;
  sizeBytes: number | null;
  /** Null means it stays on this server's disk. */
  storage: BackupStorageRef | null;
  encrypted: boolean;
  nextAt: string | null;
  error: string | null;
}

export interface ServerSnapshot {
  host: HostSnapshot;
  system: SystemInfo;
  disk: DiskSlice[];
  containers: ContainerRow[];
  services: ServiceHealth[];
  janitor?: JanitorStatus | null;
  controlPlaneBackup?: ControlPlaneBackup | null;
}

export type ReleaseChannel = "stable" | "beta";
/** manual: notify only. security: install critical releases on their own. all: every release on the channel. */
export type UpdateMode = "manual" | "security" | "all";

/** When automatic installs may run, in the policy's time zone. */
export interface UpdateWindow {
  /** 0 Sunday to 6 Saturday. */
  days: number[];
  /** "HH:MM". */
  start: string;
  /** "HH:MM"; at or before start, the window runs past midnight. */
  end: string;
}

export interface UpdatePolicy {
  mode: UpdateMode;
  channel: ReleaseChannel;
  /** Null: any time. */
  window: UpdateWindow | null;
  timeZone: string;
  skipVersion: string | null;
  pausedUntil: string | null;
}

export type UpdatePolicyBody = Pick<UpdatePolicy, "mode" | "channel" | "window" | "timeZone">;

/** The steps of an update, in order. A rollback adds its own step at the end. */
export type UpdateStepId = "preflight" | "pull" | "backup" | "migrate" | "swapApi" | "swapWorker" | "swapWeb" | "health" | "rollback";

export interface UpdateStepRow {
  id: UpdateStepId;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  startedAt: string | null;
  finishedAt: string | null;
  detail: string | null;
}

export interface UpdateJob {
  id: string;
  kind: "update" | "rollback";
  trigger: "manual" | "auto";
  /** Who clicked, or null for an automatic install. */
  actor: string | null;
  from: string;
  version: string;
  phase: UpdateStepId;
  /** waiting: preflight holds until a deploy or restore finishes. */
  state: "waiting" | "running" | "done" | "failed" | "rolledBack";
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** The control-plane dump taken before anything changed, and its sha256. */
  dumpId: string | null;
  dumpSha256: string | null;
  error: string | null;
  attempt: number;
  steps: UpdateStepRow[];
}

export interface ReleaseInfo {
  version: string;
  publishedAt: string;
  /** The oldest version that may move straight to this one. */
  minFrom: string;
  /** What the release does to the database, in a few words. */
  migration: string;
  /** A security release. */
  critical: boolean;
  notesUrl: string;
  /** Markdown from the signed manifest. Rendered by lib/markdown.ts: no raw HTML, https links only. */
  notes: string;
  /** Only signed releases are ever offered. */
  signed: true;
}

export interface UpdateStatus {
  current: string;
  channel: ReleaseChannel;
  /** False when the installer wrote no feed or key. */
  configured: boolean;
  feedUrl: string | null;
  checkedAt: string | null;
  nextCheckAt: string | null;
  /** The last check's failure, kept until a check succeeds. */
  checkError: string | null;
  policy: UpdatePolicy;
  /** The newest signed release this install may move to now, or null. */
  latest: ReleaseInfo | null;
  /** A newer release that needs `minFrom` first. */
  blocked: { version: string; minFrom: string } | null;
  /** When the scheduler installs `latest` on its own, or null (manual, skipped, paused, none). */
  autoAt: string | null;
  /** The update in flight, or the last one that finished. */
  job: UpdateJob | null;
  /** Newest first, at most 20. */
  history: UpdateJob[];
  /** The last good version this install can return to: within 7 days, its dump still on disk. */
  rollback: { updateId: string; version: string; until: string } | null;
  /**
   * The pending security release from the signed feed (lib/security-release.ts): the newest release
   * above `current` with a security block, kept while any pending release has one. Older APIs leave it out.
   */
  security?: SecurityRelease | null;
}

export interface UpdatesResult {
  source: OverviewSource;
  data: UpdateStatus | null;
  error?: string;
}

/** A release version such as 0.9.2, v0.9.2 or 1.0.0-rc.1, as the contract's ReleaseVersion. */
export const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/;
/** An update id, as the contract's Uuid. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** "HH:MM", 00:00 to 23:59. */
const HOUR_MINUTE_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface ServerResult {
  source: OverviewSource;
  data: ServerSnapshot | null;
  /** The 24h series, loaded with the page so the cards draw on first paint. */
  metrics: ServerMetrics | null;
  /** Null when the API has no updates endpoint or it failed; the card says so. */
  updates: UpdateStatus | null;
  error?: string;
  fetchedAt: string;
}

export interface MetricsResult {
  source: OverviewSource;
  data: ServerMetrics | null;
  error?: string;
}

export interface PruneResult {
  reclaimedBytes: number;
  disk: DiskSlice[];
}

export type BackupDestination = "s3" | "local";
/** Where a tier keeps its copies: this server's disk, or an S3 destination off it. */
export type BackupTier = "local" | "offsite";
export type BackupStatus = "running" | "ready" | "failed";
export type BackupKind = "scheduled" | "manual" | "preDeploy" | "preUpdate";
export type StorageProvider = "r2" | "s3" | "minio" | "custom";

export interface BackupDatabase {
  /** The service's name: what a restore confirms with. */
  name: string;
  /** What people read as its name today, while it has one. */
  displayName?: string;
  projectSlug: string;
  environment: string;
  /** Set once the app is deleted; its backups stay until they are deleted here. */
  deletedAt?: string | null;
}

/** A Settings, Integrations, Backup storage destination, as a schedule or run names it. */
export interface BackupStorageRef {
  id: string;
  name: string;
  provider: StorageProvider;
  bucket: string;
}

export interface BackupStorage extends BackupStorageRef {
  isDefault: boolean;
  lastTestedAt: string | null;
  error: string | null;
}

export interface BackupEncryption {
  enabled: boolean;
  /** The public fingerprint of the key that sealed the dump. */
  fingerprint: string | null;
}

export type RestoreTestStatus = "passed" | "failed" | "running" | "notTested";

export interface RestoreTest {
  status: RestoreTestStatus;
  testedAt: string | null;
  tables: number | null;
  rows: number | null;
  error: string | null;
}

export interface BackupConfig {
  destinations: BackupStorage[];
  encryption: { enabled: boolean; algorithm: string; fingerprint: string | null; createdAt: string | null };
  /** The automatic restore test of each database's newest backup. */
  restoreTests: { cron: string; nextRunAt: string | null };
}

/** One tier of a database's backups: its own cron, switch and how many automatic backups it keeps. */
export interface BackupTierSchedule {
  tier: BackupTier;
  enabled: boolean;
  /** Five field cron, evaluated in `timezone`. */
  cron: string;
  timezone: string;
  /** The newest this many automatic backups always stay. */
  keep: number;
  /** Also kept: every one from the last this many days (schedules from before tiers). */
  keepDays: number | null;
  destination: BackupDestination;
  /** Where offsite goes; null for local, or offsite with no S3 destination yet. */
  storage: BackupStorageRef | null;
  /** False when it cannot run: offsite with no S3 destination, local turned off on this server. */
  available: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface BackupSchedule {
  id: string;
  resourceId: string;
  database: BackupDatabase;
  /** The flat fields describe one tier (the one that is on, offsite first), for older readers. */
  cron: string;
  timezone: string;
  retentionDays: number;
  destination: BackupDestination;
  /** Where "s3" goes; null for local. */
  storage: BackupStorageRef | null;
  encryption: BackupEncryption;
  /** On when any tier is. */
  enabled: boolean;
  /** The soonest next run of the tiers that are on. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  tiers: Record<BackupTier, BackupTierSchedule>;
}

/** What the schedule dialog changes on one tier. */
export interface TierPatch {
  tier: BackupTier;
  enabled?: boolean;
  cron?: string;
  keep?: number;
  keepDays?: number | null;
  /** Offsite only: "s3" for the default destination, or a destination id. */
  destination?: string;
}

export interface BackupRun {
  id: string;
  scheduleId: string | null;
  resourceId: string;
  database: BackupDatabase;
  status: BackupStatus;
  kind: BackupKind;
  createdAt: string;
  finishedAt: string | null;
  sizeBytes: number | null;
  /** The tier the copy counts in, by where it is stored. */
  tier: BackupTier;
  destination: BackupDestination;
  storage: BackupStorageRef | null;
  encryption: BackupEncryption;
  restoreTest: RestoreTest;
  /** Retention removed the file; the run stays listed for the record. */
  expired: boolean;
  error?: string | null;
}

export interface BackupsData {
  schedules: BackupSchedule[];
  runs: BackupRun[];
  /** Null when the API does not serve /backups/config yet. */
  config: BackupConfig | null;
}

export type RestoreRequest = { mode: "replace"; confirm: string } | { mode: "new"; name: string };

export interface RestoreOutcome {
  ok: true;
  finishedAt: string;
  database: BackupDatabase & { resourceId: string };
}

/** A restore that outlasted the request: the API answered 202 with the job to follow. */
export interface RestoreAccepted {
  jobId: string;
  resourceId: string;
  status: "queued";
}
export type RestoreProgress = RestoreOutcome | { status: "running" | "failed"; error: string | null };

export interface OrphanDeleteResult {
  deleted: number;
  freedBytes: number;
}

export interface BackupsResult {
  source: OverviewSource;
  data: BackupsData | null;
  error?: string;
  fetchedAt: string;
}

/** What a mutation hands back to its route: a status and a JSON body. */
export interface ActionResult<T> {
  status: number;
  body: T | { error: string; code?: string };
}

// -------------- API access --------------

// Preview only when no API is configured at all: a set (even broken) API URL must never fall back to fixtures.

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One call to the Dockify API (lib/api.ts): the API's own message on a failure, else a line for its
 * status. `timeoutMs` covers the writes the API holds open while the worker runs them.
 */
async function api<T>(path: string, init?: { method?: Method; body?: unknown; timeoutMs?: number }): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string; code?: string }> {
  const r = await apiRequest<T>(path, { method: init?.method, body: init?.body, timeoutMs: init?.timeoutMs });
  // A success without a body (an empty 204, say) is still a success, not an outage.
  return r.ok ? { ok: true, data: (r.data ?? {}) as T } : { ok: false, status: r.status, error: r.error, code: r.code };
}

/** The API holds a prune open for up to 75 seconds and a restore for up to 90 while the worker runs them. */
const PRUNE_TIMEOUT_MS = 90_000;
const RESTORE_TIMEOUT_MS = 110_000;

/** Accepts a bare array or a `{ items }` / `{ data }` envelope. */
function list<T>(body: T[] | { items?: T[]; data?: T[] }): T[] {
  return Array.isArray(body) ? body : (body.items ?? body.data ?? []);
}

/**
 * Fills fields an older API leaves out, so the page never reads undefined: the kind from the
 * old `trigger`, no encryption, and no restore test yet.
 */
function normRun(r: BackupRun & { trigger?: "schedule" | "manual" }): BackupRun {
  return {
    ...r,
    tier: r.tier ?? (r.destination === "s3" ? "offsite" : "local"),
    kind: r.kind ?? (r.trigger === "manual" ? "manual" : "scheduled"),
    storage: r.storage ?? null,
    encryption: r.encryption ?? { enabled: false, fingerprint: null },
    restoreTest: r.restoreTest ?? { status: "notTested", testedAt: null, tables: null, rows: null, error: null },
  };
}

/** A tier an API from before tiers never sent: the one schedule it had, or off. */
function flatTier(s: BackupSchedule, tier: BackupTier): BackupTierSchedule {
  const mine = (s.destination === "s3" ? "offsite" : "local") === tier;
  return {
    tier,
    enabled: mine && s.enabled,
    cron: s.cron,
    timezone: s.timezone,
    keep: 3,
    keepDays: s.retentionDays,
    destination: tier === "offsite" ? "s3" : "local",
    storage: tier === "offsite" ? (s.storage ?? null) : null,
    available: tier === "local" || s.storage !== null,
    nextRunAt: mine ? s.nextRunAt : null,
    lastRunAt: mine ? s.lastRunAt : null,
  };
}

function normSchedule(s: BackupSchedule): BackupSchedule {
  const out = { ...s, storage: s.storage ?? null, encryption: s.encryption ?? { enabled: false, fingerprint: null } };
  return { ...out, tiers: s.tiers ?? { local: flatTier(out, "local"), offsite: flatTier(out, "offsite") } };
}

/**
 * Forwards a write, or answers it from the fixture in preview, or refuses with no source. The API's
 * own 4xx pass through with their code (401 ends the session, a step-up refusal asks for one);
 * `elevated` writes are refused in the preview outside its step-up window, as the API refuses them.
 */
async function mutate<T>(path: string, method: Method, body: unknown, simulate: () => T | null, opts: { elevated?: boolean; timeoutMs?: number } = {}): Promise<ActionResult<T>> {
  if (process.env.DOCKIFY_API_URL) {
    const r = await api<T>(path, { method, body, timeoutMs: opts.timeoutMs });
    return r.ok ? { status: 200, body: r.data } : { status: upstreamStatus(r.status), body: { error: r.error, code: r.code } };
  }
  if (isPreviewMode()) {
    if (opts.elevated && !previewElevated()) return { status: 403, body: { error: STEP_UP_MESSAGE, code: STEP_UP_REQUIRED } };
    // A short wait so the progress state is visible in the design preview.
    await new Promise((done) => setTimeout(done, 1400));
    const out = simulate();
    return out ? { status: 200, body: out } : { status: 404, body: { error: "Not found" } };
  }
  return { status: 503, body: { error: "No data source" } };
}

export function isRange(value: string | null): value is MetricRange {
  return value === "1h" || value === "24h" || value === "7d";
}

// -------------- Server --------------

export async function getServer(): Promise<ServerResult> {
  await connection();
  const fetchedAt = new Date().toISOString();

  if (process.env.DOCKIFY_API_URL) {
    const [snap, metrics, updates] = await Promise.all([
      api<ServerSnapshot>("/api/v1/server"),
      api<ServerMetrics>("/api/v1/server/metrics?range=24h"),
      api<UpdateStatus>("/api/v1/server/updates"),
    ]);
    if (!snap.ok) return { source: "api", data: null, metrics: null, updates: null, error: snap.error, fetchedAt };
    return { source: "api", data: snap.data, metrics: metrics.ok ? metrics.data : null, updates: updates.ok ? updates.data : null, fetchedAt };
  }

  // Design preview only. Never set in a deployed build.
  if (isPreviewMode()) {
    const now = new Date();
    return { source: "preview", data: buildPreviewServer(now), metrics: buildPreviewMetrics("24h", now), updates: buildPreviewUpdates(now), fetchedAt };
  }

  return { source: "none", data: null, metrics: null, updates: null, fetchedAt };
}

// -------------- Updates --------------

export async function getUpdates(): Promise<UpdatesResult> {
  if (process.env.DOCKIFY_API_URL) {
    const r = await api<UpdateStatus>("/api/v1/server/updates");
    return r.ok ? { source: "api", data: r.data } : { source: "api", data: null, error: r.error };
  }
  if (isPreviewMode()) return { source: "preview", data: buildPreviewUpdates(new Date()) };
  return { source: "none", data: null, error: "No data source" };
}

export function checkUpdates(): Promise<ActionResult<UpdateStatus>> {
  return mutate<UpdateStatus>("/api/v1/server/updates/check", "POST", {}, () => {
    const now = new Date();
    return { ...buildPreviewUpdates(now), checkedAt: now.toISOString(), nextCheckAt: new Date(now.getTime() + 6 * 3_600_000).toISOString() };
  });
}

/** Requires step-up on the API. */
export function applyUpdate(version: string): Promise<ActionResult<UpdateJob>> {
  return mutate<UpdateJob>("/api/v1/server/updates/apply", "POST", { version }, () => {
    const now = new Date();
    const s = buildPreviewUpdates(now);
    if (!s.latest || s.latest.version !== version) return null;
    return previewStartedJob("update", s.current, version, now);
  }, { elevated: true });
}

/** Requires step-up on the API. */
export function rollbackUpdate(updateId: string): Promise<ActionResult<UpdateJob>> {
  return mutate<UpdateJob>("/api/v1/server/updates/rollback", "POST", { updateId }, () => {
    const now = new Date();
    const s = buildPreviewUpdates(now);
    if (!s.rollback || s.rollback.updateId !== updateId) return null;
    return previewStartedJob("rollback", s.current, s.rollback.version, now);
  }, { elevated: true });
}

export function skipUpdate(version: string | null): Promise<ActionResult<UpdateStatus>> {
  return mutate<UpdateStatus>("/api/v1/server/updates/skip", "POST", { version }, () => {
    const s = buildPreviewUpdates(new Date());
    return { ...s, policy: { ...s.policy, skipVersion: version }, autoAt: version && s.latest?.version === version ? null : s.autoAt };
  });
}

export function pauseUpdates(days: 0 | 7): Promise<ActionResult<UpdateStatus>> {
  return mutate<UpdateStatus>("/api/v1/server/updates/pause", "POST", { days }, () => {
    const now = new Date();
    const s = buildPreviewUpdates(now);
    const pausedUntil = days ? new Date(now.getTime() + days * 86_400_000).toISOString() : null;
    return { ...s, policy: { ...s.policy, pausedUntil }, autoAt: pausedUntil ? null : s.autoAt };
  });
}

/** Requires step-up on the API. */
export function saveUpdatePolicy(body: UpdatePolicyBody): Promise<ActionResult<UpdateStatus>> {
  return mutate<UpdateStatus>("/api/v1/server/updates/policy", "PUT", body, () => {
    const now = new Date();
    const s = buildPreviewUpdates(now);
    const policy = { ...s.policy, ...body };
    return { ...s, channel: body.channel, policy, autoAt: previewAutoAt(policy, s.latest, now) };
  }, { elevated: true });
}

/**
 * Checks a policy body from the browser field by field, as the contract's UpdatePolicyBody does,
 * and returns only those fields, or an error message.
 */
export function parsePolicyBody(raw: Record<string, unknown>): { ok: true; body: UpdatePolicyBody } | { ok: false; error: string } {
  const { mode, channel, window, timeZone } = raw;
  if (mode !== "manual" && mode !== "security" && mode !== "all") return { ok: false, error: "Expected mode manual, security or all" };
  if (channel !== "stable" && channel !== "beta") return { ok: false, error: "Expected channel stable or beta" };
  if (typeof timeZone !== "string" || !TIME_ZONE_RE.test(timeZone)) return { ok: false, error: "Expected a time zone such as Etc/UTC" };
  if (window === null) return { ok: true, body: { mode, channel, window: null, timeZone } };
  if (!window || typeof window !== "object" || Array.isArray(window)) return { ok: false, error: "Expected window { days, start, end } or null" };
  const w = window as Record<string, unknown>;
  const days = w.days;
  if (!Array.isArray(days) || days.length > 7 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return { ok: false, error: "Expected window days 0 to 6" };
  if (typeof w.start !== "string" || !HOUR_MINUTE_RE.test(w.start) || typeof w.end !== "string" || !HOUR_MINUTE_RE.test(w.end)) return { ok: false, error: "Expected window times as HH:MM" };
  return { ok: true, body: { mode, channel, window: { days: [...new Set(days as number[])].sort(), start: w.start, end: w.end }, timeZone } };
}

export async function getServerMetrics(range: MetricRange): Promise<MetricsResult> {
  if (process.env.DOCKIFY_API_URL) {
    const r = await api<ServerMetrics>(`/api/v1/server/metrics?range=${range}`);
    return r.ok ? { source: "api", data: r.data } : { source: "api", data: null, error: r.error };
  }
  if (isPreviewMode()) return { source: "preview", data: buildPreviewMetrics(range, new Date()) };
  return { source: "none", data: null, error: "No data source" };
}

/** What a prune may remove. Volumes are never in it. */
export type PruneTarget = Exclude<DiskSliceId, "volumes">;
const PRUNABLE: readonly string[] = ["images", "buildCache", "logs"] satisfies PruneTarget[];

export function isPruneTarget(value: unknown): value is PruneTarget {
  return typeof value === "string" && PRUNABLE.includes(value);
}

export function pruneServer(targets: PruneTarget[]): Promise<ActionResult<PruneResult>> {
  const safe: DiskSliceId[] = [...new Set(targets)];
  return mutate<PruneResult>("/api/v1/server/prune", "POST", { targets: safe }, () => {
    const disk = buildPreviewServer(new Date()).disk;
    const reclaimedBytes = disk.filter((d) => safe.includes(d.id)).reduce((n, d) => n + d.reclaimableBytes, 0);
    return {
      reclaimedBytes,
      disk: disk.map((d) => (safe.includes(d.id) ? { ...d, bytes: d.bytes - d.reclaimableBytes, reclaimableBytes: 0 } : d)),
    };
  }, { timeoutMs: PRUNE_TIMEOUT_MS });
}

// -------------- Backups --------------

export async function getBackups(): Promise<BackupsResult> {
  await connection();
  const fetchedAt = new Date().toISOString();

  if (process.env.DOCKIFY_API_URL) {
    const [runs, schedules, config] = await Promise.all([
      api<BackupRun[] | { items?: BackupRun[] }>("/api/v1/backups"),
      api<BackupSchedule[] | { items?: BackupSchedule[] }>("/api/v1/backups/schedules"),
      api<BackupConfig>("/api/v1/backups/config"),
    ]);
    if (!runs.ok) return { source: "api", data: null, error: runs.error, fetchedAt };
    if (!schedules.ok) return { source: "api", data: null, error: schedules.error, fetchedAt };
    const sorted = list(runs.data)
      .map(normRun)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const cfg = config.ok && Array.isArray(config.data.destinations) ? config.data : null;
    return { source: "api", data: { runs: sorted, schedules: list(schedules.data).map(normSchedule), config: cfg }, fetchedAt };
  }

  if (isPreviewMode()) return { source: "preview", data: buildPreviewBackups(new Date()), fetchedAt };

  return { source: "none", data: null, fetchedAt };
}

export function patchSchedule(id: string, patch: TierPatch): Promise<ActionResult<BackupSchedule>> {
  return mutate<BackupSchedule>(`/api/v1/backups/schedules/${encodeURIComponent(id)}`, "PATCH", patch, () => {
    const now = new Date();
    const hit = buildPreviewBackups(now).schedules.find((s) => s.id === id);
    if (!hit) return null;
    const { tier, destination, ...rest } = patch;
    const before = hit.tiers[tier];
    const storage = tier === "offsite" ? (destination && destination !== "s3" ? (previewStorage(destination) ?? before.storage) : (before.storage ?? R2)) : null;
    const t: BackupTierSchedule = { ...before, ...rest, storage, available: tier === "local" || storage !== null };
    t.nextRunAt = t.enabled ? iso(firings(t.cron, now.getTime(), now.getTime() + 8 * DAY)[0]) : null;
    return withFlat({ ...hit, tiers: { ...hit.tiers, [tier]: t } });
  }, { elevated: true });
}

export function runBackup(resourceId?: string, tier?: BackupTier | "both"): Promise<ActionResult<{ runs: BackupRun[] }>> {
  return mutate<{ runs: BackupRun[] }>("/api/v1/backups/run", "POST", { ...(resourceId ? { resourceId } : {}), ...(tier ? { tier } : {}) }, () => {
    const now = new Date();
    const picked = buildPreviewBackups(now).schedules.filter((s) => (resourceId ? s.resourceId === resourceId : s.enabled));
    if (!picked.length) return null;
    return {
      runs: picked.flatMap((s) => {
        const on = (["local", "offsite"] as const).filter((k) => s.tiers[k].enabled && s.tiers[k].available);
        const tiers = tier === "both" ? (["local", "offsite"] as const) : tier ? [tier] : on.length ? on : [s.destination === "s3" ? "offsite" as const : "local" as const];
        return tiers.map((k) => ({
          id: `bkp_manual_${s.resourceId}_${k}_${now.getTime()}`,
          scheduleId: s.id,
          resourceId: s.resourceId,
          database: s.database,
          status: "running" as const,
          kind: "manual" as const,
          createdAt: now.toISOString(),
          finishedAt: null,
          sizeBytes: null,
          tier: k,
          destination: s.tiers[k].destination,
          storage: s.tiers[k].storage,
          encryption: s.encryption,
          restoreTest: { status: "notTested" as const, testedAt: null, tables: null, rows: null, error: null },
          expired: false,
        }));
      }),
    };
  });
}

export function restoreProgress(id: string, jobId: string) {
  return api<RestoreProgress>(`/api/v1/backups/${encodeURIComponent(id)}/restore/${encodeURIComponent(jobId)}`);
}

export function restoreBackup(id: string, req: RestoreRequest): Promise<ActionResult<RestoreOutcome | RestoreAccepted>> {
  return mutate<RestoreOutcome | RestoreAccepted>(`/api/v1/backups/${encodeURIComponent(id)}/restore`, "POST", req, () => {
    const run = buildPreviewBackups(new Date()).runs.find((r) => r.id === id);
    if (!run || run.status !== "ready" || run.expired) return null;
    const finishedAt = new Date().toISOString();
    if (req.mode === "replace") {
      if (isOrphan(run) || req.confirm !== `${run.database.projectSlug}/${run.database.name}`) return null;
      return { ok: true, finishedAt, database: { ...run.database, resourceId: run.resourceId } };
    }
    const { deletedAt: _gone, ...db } = run.database;
    return { ok: true, finishedAt, database: { ...db, name: req.name, resourceId: `res_${run.database.projectSlug}_${req.name}` } };
  }, { elevated: true, timeoutMs: RESTORE_TIMEOUT_MS });
}

export function testBackup(id: string): Promise<ActionResult<BackupRun>> {
  return mutate<BackupRun>(`/api/v1/backups/${encodeURIComponent(id)}/test`, "POST", {}, () => {
    const run = buildPreviewBackups(new Date()).runs.find((r) => r.id === id);
    if (!run || run.status !== "ready" || run.expired) return null;
    return { ...run, restoreTest: { status: "running", testedAt: new Date().toISOString(), tables: null, rows: null, error: null } };
  });
}

export function deleteOrphans(resourceId: string): Promise<ActionResult<OrphanDeleteResult>> {
  return mutate<OrphanDeleteResult>(`/api/v1/backups/orphans/${encodeURIComponent(resourceId)}`, "DELETE", {}, () => {
    const gone = buildPreviewBackups(new Date()).runs.filter((r) => r.resourceId === resourceId && isOrphan(r));
    if (!gone.length) return null;
    return { deleted: gone.length, freedBytes: gone.reduce((n, r) => n + (r.expired ? 0 : (r.sizeBytes ?? 0)), 0) };
  }, { elevated: true });
}

/**
 * Streams the dump from the API; there is no file to give in the preview. Elevated on the API: the
 * page confirms it is you before it starts the download (components/step-up `ensureStepUp`). A
 * refusal comes back as JSON with the API's status and code, never as a file.
 */
export async function downloadBackup(id: string, signal?: AbortSignal): Promise<Response> {
  if (!process.env.DOCKIFY_API_URL) return answer({ ok: false, error: "Downloads need the Dockify API" }, 503);
  const r = await apiStream(`/api/v1/backups/${encodeURIComponent(id)}/download`, { accept: "*/*", signal });
  if (!r.ok) return answer({ ok: false, error: r.error, code: r.code }, upstreamStatus(r.status));
  const out = new Headers(NO_STORE);
  for (const h of ["content-type", "content-length", "content-disposition"]) {
    const v = r.res.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(r.res.body, { status: r.res.status, headers: out });
}

// -------------- Preview fixtures --------------
// Built from buildPreviewOverview(now) so apps, ids, host numbers and in-flight builds agree with
// the Overview. Values are seeded, so every refresh draws the same server.

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Relative CPU and memory weight of each kind of container, before scaling to the host totals. */
const WEIGHT: Record<Resource["kind"], [cpu: number, mem: number]> = {
  frontend: [1.2, 1.4],
  backend: [2, 1.8],
  bot: [0.5, 0.6],
  postgres: [2.4, 3.2],
  redis: [0.6, 0.7],
  s3: [0.8, 1],
};

const SYSTEM: Array<[name: string, cpu: number, mem: number]> = [
  ["dockify-web", 1, 1.2],
  ["dockify-api", 1.5, 1.4],
  ["dockify-worker", 1, 1],
  ["dockify-proxy", 1.2, 0.5],
  ["dockify-postgres", 1.4, 2],
  ["dockify-redis", 0.4, 0.4],
  ["dockify-buildkit", 6, 4],
];

function buildPreviewServer(now: Date): ServerSnapshot {
  const o = buildPreviewOverview(now);
  const host = o.host!;
  const rnd = seeded(29);
  const bootAt = now.getTime() - host.uptimeSeconds * 1000;

  // App containers: started when their last ready deploy finished, otherwise shortly after boot.
  const raw = o.resources.map((r, i) => {
    const last = o.recentDeployments.find((d) => d.appId === r.id && d.status === "ready" && d.finishedAt);
    const state: ContainerState = r.status === "stopped" ? "exited" : r.status === "degraded" ? "unhealthy" : "running";
    const [cpu, mem] = WEIGHT[r.kind];
    return {
      id: `ctr_${r.id}`,
      name: `${r.projectSlug}-${r.name}${r.environment === "production" ? "" : "-dev"}-1`,
      app: { id: r.id, name: r.name, ...(r.displayName ? { displayName: r.displayName } : {}), projectSlug: r.projectSlug, environment: r.environment, kind: r.kind },
      cpu: state === "exited" ? 0 : cpu * (0.7 + rnd() * 0.6),
      mem: state === "exited" ? 0 : mem * (0.7 + rnd() * 0.6),
      restarts: state === "exited" ? 5 : state === "unhealthy" ? 3 : rnd() > 0.85 ? 1 : 0,
      startedAt: state === "exited" ? null : last?.finishedAt ?? new Date(bootAt + (40 + i * 7) * 1000).toISOString(),
      state,
    };
  });
  // Dockify's own containers always run in the preview.
  const running: ContainerState = "running";
  const system = SYSTEM.map(([name, cpu, mem], i) => ({
    id: `ctr_sys_${i}`,
    name,
    app: null,
    cpu,
    mem,
    restarts: 0,
    startedAt: new Date(bootAt + (8 + i * 3) * 1000).toISOString(),
    state: running,
  }));

  // Scale so the containers add up to the host's CPU and memory figures.
  const all = [...system, ...raw];
  const cpuSum = all.reduce((n, c) => n + c.cpu, 0);
  const memSum = all.reduce((n, c) => n + c.mem, 0);
  const containers: ContainerRow[] = all.map((c) => ({
    id: c.id,
    name: c.name,
    app: c.app,
    cpuPct: round1((c.cpu / cpuSum) * host.cpu.usedPct),
    memoryBytes: Math.round((c.mem / memSum) * host.memory.usedBytes),
    restarts: c.restarts,
    startedAt: c.startedAt,
    state: c.state,
  }));

  // 146 GB used, 38 GB of it reclaimable, the same totals as the Overview server card.
  const disk: DiskSlice[] = [
    { id: "images", bytes: 64 * GB, reclaimableBytes: 14 * GB, count: 87 },
    { id: "buildCache", bytes: 31 * GB, reclaimableBytes: 21 * GB, count: 412 },
    { id: "volumes", bytes: 42 * GB, reclaimableBytes: 0, count: 19 },
    { id: "logs", bytes: 9 * GB, reclaimableBytes: 3 * GB, count: 64 },
  ];

  const building = o.recentDeployments.filter((d) => d.status === "building" || d.status === "deploying").length;
  const queued = o.recentDeployments.filter((d) => d.status === "queued").length;

  // Every stateless app keeps its last five ready images; a few apps have fewer deploys so far.
  const stateless = o.resources.filter((r) => r.kind === "frontend" || r.kind === "backend" || r.kind === "bot").length;
  const t = now.getTime();
  const janitorAt = firings("30 4 * * *", t - 2 * 86_400_000, t + 2 * 86_400_000);
  const cpbAt = firings("0 2 * * *", t - 2 * 86_400_000, t + 2 * 86_400_000);
  const lastCpb = cpbAt.filter((x) => x < t).at(-1) ?? null;

  return {
    host,
    system: {
      os: "Ubuntu 24.04.1 LTS",
      kernel: "6.8.0-47-generic",
      docker: "27.3.1",
      dockify: "0.9.0",
      ip: "203.0.113.24",
      cores: host.cpu.cores,
      memoryBytes: host.memory.totalBytes,
    },
    disk,
    containers,
    // The rows the API sends (modules/platform/server.ts): the API and Postgres by probe, the
    // worker by its heartbeat, the rest from the worker's reading of the control plane's containers.
    services: [
      { id: "api", status: "ok", latencyMs: 4, detail: "serving this request" },
      { id: "worker", status: "ok", latencyMs: null, detail: `reported 12 s ago, ${building} building, ${queued} queued` },
      { id: "postgres", status: "ok", latencyMs: 1, detail: "answered in 1 ms" },
      { id: "web", status: "ok", latencyMs: null, detail: "up 9 d" },
      { id: "proxy", status: "ok", latencyMs: null, detail: `up 9 d, routing ${o.counts.domains} domains` },
      { id: "buildkit", status: "ok", latencyMs: null, detail: "up 9 d" },
      { id: "socketProxy", status: "ok", latencyMs: null, detail: "up 9 d" },
      { id: "updater", status: "ok", latencyMs: null, detail: "up 2 d" },
    ],
    janitor: {
      buildCache: { bytes: 31 * GB, capBytes: 40 * GB },
      pinnedImages: { count: stateless * 5 - 6, bytes: 42 * GB, perApp: 5, apps: stateless },
      nextRunAt: iso(janitorAt.find((x) => x > t)),
      lastRunAt: iso(janitorAt.filter((x) => x <= t).at(-1)),
      lastFreedBytes: Math.round(6.2 * GB),
    },
    controlPlaneBackup: {
      status: "ready",
      lastAt: iso(lastCpb === null ? undefined : lastCpb + 14_000),
      sizeBytes: 84 * MB,
      storage: R2,
      encrypted: true,
      nextAt: iso(cpbAt.find((x) => x > t)),
      error: null,
    },
  };
}

const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());

/** The R2 destination from Settings, Integrations, Backup storage (lib/pages/integrations.ts). */
const R2: BackupStorageRef = { id: "dst_r2", name: "Cloudflare R2", provider: "r2", bucket: "dockify-backups" };

/** The instance backup key's public fingerprint. */
const KEY_FINGERPRINT = "7F3A 9C21 E04B 5D18";

/** The preview's last Dockify update, minutes before the fixture's boot: every database was dumped first. */
const LAST_UPDATE_AT = Date.UTC(2026, 9, 17, 6, 4, 0);

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** How long each step takes in the preview, and what it reports. */
const PREVIEW_STEP: Record<UpdateStepId, { ms: number; detail: string }> = {
  preflight: { ms: 3_000, detail: "Disk 61% used, database reachable, nothing deploying or restoring" },
  pull: { ms: 41_000, detail: "api, worker and web verified against the signed digests" },
  backup: { ms: 6_000, detail: "Control-plane dump 4.2 MB, sha256 recorded" },
  migrate: { ms: 4_000, detail: "1 migration applied" },
  swapApi: { ms: 9_000, detail: "api healthy on the new image" },
  swapWorker: { ms: 7_000, detail: "worker healthy on the new image" },
  swapWeb: { ms: 11_000, detail: "web healthy on the new image" },
  health: { ms: 15_000, detail: "All services answered for 15 s" },
  rollback: { ms: 20_000, detail: "Previous digests restored, dump restored" },
};

/** The steps of a rollback job: a fresh dump, the old dump restored, the old images swapped back. */
const ROLLBACK_STEPS: UpdateStepId[] = ["preflight", "backup", "rollback", "swapApi", "swapWorker", "swapWeb", "health"];

const sha = (seed: string) => seededHex(seed, 64);

/** A stable hex string per seed, for preview checksums. */
function seededHex(seed: string, length: number) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  let out = "";
  while (out.length < length) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

/**
 * One finished preview job. `failAt` marks the step that failed: the ones after it are skipped,
 * and a rolled back update gets the rollback step at the end.
 */
function previewJob(o: {
  id: string;
  kind: UpdateJob["kind"];
  trigger: UpdateJob["trigger"];
  actor: string | null;
  from: string;
  version: string;
  startedAt: number;
  state: "done" | "failed" | "rolledBack";
  failAt?: UpdateStepId;
  error?: string;
}): UpdateJob {
  const ids = o.kind === "rollback" ? ROLLBACK_STEPS : UPDATE_STEPS;
  const failIdx = o.failAt ? ids.indexOf(o.failAt) : -1;
  let at = o.startedAt;
  const steps: UpdateStepRow[] = ids.map((id, i) => {
    if (failIdx >= 0 && i > failIdx) return { id, status: "skipped", startedAt: null, finishedAt: null, detail: null };
    const start = at;
    at += PREVIEW_STEP[id].ms;
    const failed = i === failIdx;
    return { id, status: failed ? "failed" : "done", startedAt: iso(start), finishedAt: iso(at), detail: failed ? (o.error ?? null) : PREVIEW_STEP[id].detail };
  });
  if (o.state === "rolledBack") {
    const start = at;
    at += PREVIEW_STEP.rollback.ms;
    steps.push({ id: "rollback", status: "done", startedAt: iso(start), finishedAt: iso(at), detail: PREVIEW_STEP.rollback.detail });
  }
  const dumped = steps.some((s) => s.id === "backup" && s.status === "done");
  return {
    id: o.id,
    kind: o.kind,
    trigger: o.trigger,
    actor: o.actor,
    from: o.from,
    version: o.version,
    phase: [...steps].reverse().find((s) => s.status !== "skipped")?.id ?? "preflight",
    state: o.state,
    startedAt: iso(o.startedAt)!,
    finishedAt: iso(at),
    durationMs: at - o.startedAt,
    dumpId: dumped ? `cpb_${o.id.slice(0, 8)}` : null,
    dumpSha256: dumped ? sha(o.id) : null,
    error: o.error ?? null,
    attempt: 1,
    steps,
  };
}

/** A job the preview just started: preflight running, the rest pending. The card advances it on a timer. */
function previewStartedJob(kind: UpdateJob["kind"], from: string, version: string, now: Date): UpdateJob {
  const ids = kind === "rollback" ? ROLLBACK_STEPS : UPDATE_STEPS;
  return {
    id: crypto.randomUUID(),
    kind,
    trigger: "manual",
    actor: "Sam",
    from,
    version,
    phase: ids[0]!,
    state: "running",
    startedAt: now.toISOString(),
    finishedAt: null,
    durationMs: null,
    dumpId: null,
    dumpSha256: null,
    error: null,
    attempt: 1,
    steps: ids.map((s, i) => ({ id: s, status: i === 0 ? "running" : "pending", startedAt: i === 0 ? now.toISOString() : null, finishedAt: null, detail: null })),
  };
}

/** Minutes east of UTC for a zone at a moment; 0 for a zone this runtime does not know. */
function zoneOffsetMin(timeZone: string, at: number) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(at));
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return Math.round((Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute")) - Math.floor(at / 60_000) * 60_000) / 60_000);
  } catch {
    return 0;
  }
}

/** When the preview's scheduler would install `latest`: the next window start on an allowed day. */
function previewAutoAt(policy: UpdatePolicy, latest: ReleaseInfo | null, now: Date): string | null {
  if (!latest || policy.mode === "manual" || (policy.mode === "security" && !latest.critical)) return null;
  if (policy.skipVersion === latest.version) return null;
  const t = now.getTime();
  if (policy.pausedUntil && Date.parse(policy.pausedUntil) > t) return null;
  if (!policy.window) return new Date(Math.ceil((t + 5 * 60_000) / 60_000) * 60_000).toISOString();
  if (!policy.window.days.length) return null;
  const [h = 0, m = 0] = policy.window.start.split(":").map(Number);
  const offset = zoneOffsetMin(policy.timeZone, t);
  const local = new Date(t + offset * 60_000);
  for (let d = 0; d <= 7; d++) {
    const day = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d);
    if (!policy.window.days.includes(new Date(day).getUTCDay())) continue;
    const at = day + (h * 60 + m - offset) * 60_000;
    if (at > t) return new Date(at).toISOString();
  }
  return null;
}

const PREVIEW_NOTES = [
  "## Dockify 0.9.2",
  "",
  "A security release for every install on 0.8 or 0.9. Updating soon is recommended.",
  "",
  "### Security",
  "- Session cookies rotate after a step-up, so an old cookie stops working sooner",
  "- **Fixed** a path check in the log viewer that could read files outside the log folder",
  "",
  "### Changes",
  "- Restore tests record row counts per table",
  "- The janitor trims the build cache by size, set with `DOCKIFY_BUILD_CACHE_MAX`",
  "- Domain checks retry Cloudflare rate limits with backoff",
  "",
  "### Before you update",
  "Read the [upgrade notes](https://example.com/dockify/releases/0.9.2) if you run a custom proxy config.",
  "",
  'Notes are shown as text: <script>alert("not run")</script> stays literal, and [a javascript link](javascript:alert(1)) is not a link.',
].join("\n");

/** Update ids are UUIDs, as the API sends. Sam and Lena Hart are the settings fixture's team. */
const UPD = {
  j1: "6b1f3c2a-4d5e-4f60-9a71-b2c3d4e5f601",
  j2: "6b1f3c2a-4d5e-4f60-9a71-b2c3d4e5f602",
  j3: "6b1f3c2a-4d5e-4f60-9a71-b2c3d4e5f603",
  j4: "6b1f3c2a-4d5e-4f60-9a71-b2c3d4e5f604",
  j5: "6b1f3c2a-4d5e-4f60-9a71-b2c3d4e5f605",
  j6: "6b1f3c2a-4d5e-4f60-9a71-b2c3d4e5f606",
  j7: "6b1f3c2a-4d5e-4f60-9a71-b2c3d4e5f607",
};

/**
 * The preview's update status: 0.9.0 with 0.9.2 available (a security release unless
 * `critical: false`), 1.0.0 behind it, every stable release installed automatically between 03:00
 * and 05:00 UTC, and a history with a rollback, a rolled back update and a failed one.
 */
function buildPreviewUpdates(now: Date, { critical = true }: { critical?: boolean } = {}): UpdateStatus {
  const t = now.getTime();
  const history: UpdateJob[] = [
    previewJob({ id: UPD.j1, kind: "update", trigger: "manual", actor: "Sam", from: "0.8.5", version: "0.9.0", startedAt: t - 2 * DAY - 3 * HOUR, state: "done" }),
    previewJob({
      id: UPD.j2,
      kind: "update",
      trigger: "auto",
      actor: null,
      from: "0.8.5",
      version: "0.9.0",
      startedAt: t - 3 * DAY - 5 * HOUR,
      state: "rolledBack",
      failAt: "health",
      error: "api did not pass its health check within 60 s. The previous images and the dump were restored",
    }),
    previewJob({ id: UPD.j3, kind: "update", trigger: "manual", actor: "Lena Hart", from: "0.8.4", version: "0.8.5", startedAt: t - 9 * DAY, state: "done" }),
    previewJob({ id: UPD.j4, kind: "rollback", trigger: "manual", actor: "Lena Hart", from: "0.8.5", version: "0.8.4", startedAt: t - 11 * DAY, state: "done" }),
    previewJob({ id: UPD.j5, kind: "update", trigger: "auto", actor: null, from: "0.8.4", version: "0.8.5", startedAt: t - 12 * DAY - 2 * HOUR, state: "done" }),
    previewJob({ id: UPD.j6, kind: "update", trigger: "auto", actor: null, from: "0.8.3", version: "0.8.4", startedAt: t - 19 * DAY, state: "done" }),
    previewJob({
      id: UPD.j7,
      kind: "update",
      trigger: "manual",
      actor: "Sam",
      from: "0.8.3",
      version: "0.8.4",
      startedAt: t - 20 * DAY,
      state: "failed",
      failAt: "pull",
      error: "The worker image digest does not match the signed manifest. Nothing was changed",
    }),
  ];
  const policy: UpdatePolicy = {
    mode: "all",
    channel: "stable",
    window: { days: [0, 1, 2, 3, 4, 5, 6], start: "03:00", end: "05:00" },
    timeZone: "Etc/UTC",
    skipVersion: null,
    pausedUntil: null,
  };
  const latest: ReleaseInfo = {
    version: "0.9.2",
    publishedAt: new Date(t - DAY - 4 * HOUR).toISOString(),
    minFrom: "0.8.0",
    migration: "Adds one column to update_jobs. No rows are rewritten",
    critical,
    notesUrl: "https://example.com/dockify/releases/0.9.2",
    notes: PREVIEW_NOTES,
    signed: true,
  };
  const last = history[0]!;
  return {
    current: "0.9.0",
    channel: "stable",
    configured: true,
    feedUrl: "https://releases.example.com/dockify/stable.json",
    checkedAt: new Date(t - 2 * HOUR).toISOString(),
    nextCheckAt: new Date(t + 4 * HOUR).toISOString(),
    checkError: null,
    policy,
    latest,
    blocked: { version: "1.0.0", minFrom: "0.9.2" },
    autoAt: previewAutoAt(policy, latest, now),
    job: last,
    history,
    rollback: { updateId: last.id, version: last.from, until: new Date(Date.parse(last.finishedAt!) + 7 * DAY).toISOString() },
    // The console's popup and banner read the same release (lib/preview-security.ts).
    security: critical && previewSecurityOn() ? previewSecurityRelease(now) : null,
  };
}

function buildPreviewMetrics(range: MetricRange, now: Date): ServerMetrics {
  const host = buildPreviewOverview(now).host!;
  const history = host.history!;
  if (range === "24h") return { range, points: history.map((h) => ({ ...h })) };

  const last = history.at(-1)!;
  const rnd = seeded(range === "1h" ? 41 : 43);
  const count = range === "1h" ? 60 : 84;
  const stepMs = range === "1h" ? 60_000 : 2 * 3_600_000;
  const points = Array.from({ length: count }, (_, i): MetricPoint => {
    const at = new Date(now.getTime() - (count - 1 - i) * stepMs);
    if (i === count - 1) return { at: at.toISOString(), cpu: last.cpu, memory: last.memory, disk: last.disk, network: last.network };
    const day = Math.sin(((at.getUTCHours() - 8) / 24) * Math.PI * 2);
    if (range === "1h") {
      return {
        at: at.toISOString(),
        cpu: Math.round(last.cpu - 6 + rnd() * 12),
        memory: Math.round(last.memory - 1 + rnd() * 2),
        disk: last.disk,
        network: round1(last.network - 12 + rnd() * 24),
      };
    }
    return {
      at: at.toISOString(),
      cpu: Math.round(30 + day * 12 + rnd() * 10),
      memory: Math.round(32 + day * 3 + rnd() * 2),
      disk: round1(52 + (i / (count - 1)) * (last.disk - 52)),
      network: round1(30 + day * 15 + rnd() * 20),
    };
  });
  return { range, points };
}

interface PreviewTier {
  cron: string;
  keep: number;
  keepDays?: number;
  enabled?: boolean;
}

/**
 * The preview's backup plan for each project's database: a tier on this server and one offsite,
 * each with its own cron and count, and what a restore test finds in it. horseai is the owner's
 * own: every 12 hours here keeping 1, daily to the bucket keeping 7.
 */
const PLANS: Record<
  string,
  { local?: PreviewTier; offsite?: PreviewTier; encrypted: boolean; sizeGb: number; tables: number; rows: number; failRecent?: number }
> = {
  horseai: { local: { cron: "0 */12 * * *", keep: 1 }, offsite: { cron: "0 3 * * *", keep: 7 }, encrypted: true, sizeGb: 1.8, tables: 48, rows: 2_184_330 },
  inkwell: { offsite: { cron: "0 */12 * * *", keep: 14 }, encrypted: true, sizeGb: 0.64, tables: 61, rows: 1_236_904 },
  // The degraded brightlane database: its last two dumps lost the connection, and it stays on this disk.
  brightlane: { local: { cron: "30 4 * * *", keep: 7 }, encrypted: false, sizeGb: 0.22, tables: 22, rows: 318_442, failRecent: 2 },
  // From before tiers: kept by its old rule, the newest 3 and everything from 30 days.
  fieldnote: { offsite: { cron: "0 3 * * 0", keep: 3, keepDays: 30 }, encrypted: true, sizeGb: 0.41, tables: 35, rows: 604_118 },
};

/** A destination id the preview knows, for the schedule dialog's picker. */
const previewStorage = (id: string): BackupStorageRef | null => (id === R2.id ? R2 : null);

/** The flat fields older readers use, from the tiers (the api's own rule, backups/map.ts). */
function withFlat(s: BackupSchedule): BackupSchedule {
  const { local, offsite } = s.tiers;
  const main = offsite.enabled || (!local.enabled && offsite.storage) ? offsite : local;
  const nexts = [local.nextRunAt, offsite.nextRunAt].filter((x): x is string => !!x).sort();
  const lasts = [local.lastRunAt, offsite.lastRunAt].filter((x): x is string => !!x).sort();
  return {
    ...s,
    cron: main.cron,
    timezone: main.timezone,
    retentionDays: Math.max(main.keepDays ?? 0, main.keep),
    destination: main.destination,
    storage: main.storage,
    enabled: local.enabled || offsite.enabled,
    nextRunAt: nexts[0] ?? null,
    lastRunAt: lasts.at(-1) ?? null,
  };
}

/**
 * Databases whose apps were deleted. Their backups outlive them until deleted from the page.
 * The ids are not in lib/preview-fixture.ts on purpose: these apps no longer exist.
 */
const DELETED: Array<{ resourceId: string; projectSlug: string; name: string; deletedDaysAgo: number; cron: string; sizeGb: number }> = [
  { resourceId: "res_inkwell_analytics", projectSlug: "inkwell", name: "analytics", deletedDaysAgo: 12, cron: "0 1 * * *", sizeGb: 0.18 },
  { resourceId: "res_sword_legacy", projectSlug: "fieldnote", name: "legacy-postgres", deletedDaysAgo: 21, cron: "0 2 * * 0", sizeGb: 0.95 },
];

/** Restore tests run daily at 05:00 UTC on each database's newest backup. */
const TEST_CRON = "0 5 * * *";

/** Matches one cron field written as "*", "N" or "*\/N". Enough for the preview plans above. */
function fieldMatch(field: string, value: number) {
  if (field === "*") return true;
  if (field.startsWith("*/")) return value % Number(field.slice(2)) === 0;
  return Number(field) === value;
}

/** Every UTC firing of `cron` in [from, to), oldest first. */
function firings(cron: string, from: number, to: number) {
  const [min, hour, , , dow] = cron.split(" ");
  const out: number[] = [];
  const start = Math.floor(from / 3_600_000) * 3_600_000;
  for (let t = start; t < to; t += 3_600_000) {
    const d = new Date(t);
    if (!fieldMatch(hour!, d.getUTCHours()) || !fieldMatch(dow!, d.getUTCDay())) continue;
    const at = t + Number(min) * 60_000;
    if (at >= from && at < to) out.push(at);
  }
  return out;
}

const NOT_TESTED: RestoreTest = { status: "notTested", testedAt: null, tables: null, rows: null, error: null };

function buildPreviewBackups(now: Date): BackupsData {
  const o = buildPreviewOverview(now);
  const t = now.getTime();
  const windowStart = t - 30 * 86_400_000;
  const dbs = o.resources.filter((r) => r.kind === "postgres" && PLANS[r.projectSlug]);
  const schedules: BackupSchedule[] = [];
  const runs: BackupRun[] = [];
  const sealed = (on: boolean): BackupEncryption => ({ enabled: on, fingerprint: on ? KEY_FINGERPRINT : null });

  dbs.forEach((r, k) => {
    const plan = PLANS[r.projectSlug]!;
    const database: BackupDatabase = { name: r.name, ...(r.displayName ? { displayName: r.displayName } : {}), projectSlug: r.projectSlug, environment: r.environment };
    const id = `bks_${r.projectSlug}`;
    const encryption = sealed(plan.encrypted);
    const rnd = seeded(61 + k * 13);
    const tiers = {} as Record<BackupTier, BackupTierSchedule>;

    for (const tier of ["local", "offsite"] as const) {
      const p = plan[tier];
      const storage = tier === "offsite" ? R2 : null;
      const destination: BackupDestination = tier === "offsite" ? "s3" : "local";
      // Scheduled dumps, one before the last Dockify update, and one before a stateful redeploy of horseai and inkwell.
      const planned: Array<{ at: number; kind: BackupKind }> = p ? firings(p.cron, windowStart, t).map((at) => ({ at, kind: "scheduled" })) : [];
      const main = tier === (plan.offsite ? "offsite" : "local");
      if (main && LAST_UPDATE_AT >= windowStart && LAST_UPDATE_AT < t) planned.push({ at: LAST_UPDATE_AT, kind: "preUpdate" });
      if (main && r.projectSlug === "horseai") planned.push({ at: t - (3 * 24 + 2) * 3_600_000, kind: "preDeploy" });
      if (main && r.projectSlug === "inkwell") planned.push({ at: t - (9 * 24 + 5) * 3_600_000, kind: "preDeploy" });
      planned.sort((a, b) => a.at - b.at);
      const scheduled = planned.filter((x) => x.kind === "scheduled");
      const made: BackupRun[] = [];

      planned.forEach(({ at, kind }, i) => {
        const fromEnd = kind === "scheduled" ? scheduled.length - 1 - scheduled.findIndex((x) => x.at === at) : -1;
        const failed = kind === "scheduled" && ((plan.failRecent !== undefined && fromEnd < plan.failRecent) || (r.projectSlug === "inkwell" && fromEnd === 19));
        // Dumps grow a little over the month.
        const size = plan.sizeGb * GB * (0.9 + (i / Math.max(1, planned.length - 1)) * 0.1) * (0.98 + rnd() * 0.04);
        const secs = Math.round(failed ? 6 + rnd() * 20 : 8 + plan.sizeGb * 38 + rnd() * 10);
        // The daily test covers scheduled dumps of the last week; one inkwell test caught a short dump.
        const tested = kind === "scheduled" && !failed && t - at < 7 * 86_400_000 && at + 2 * 3_600_000 < t;
        const testFailed = tested && r.projectSlug === "inkwell" && fromEnd === 5;
        const restoreTest: RestoreTest = tested
          ? {
              status: testFailed ? "failed" : "passed",
              testedAt: new Date(Math.floor((at + 2 * 3_600_000) / 3_600_000) * 3_600_000).toISOString(),
              tables: testFailed ? plan.tables - 1 : plan.tables,
              rows: Math.round(plan.rows * (0.96 + (i / Math.max(1, planned.length)) * 0.04)),
              error: testFailed ? "Table bets is missing after restore" : null,
            }
          : NOT_TESTED;
        made.push({
          id: `bkp_${r.projectSlug}_${tier}_${at}`,
          scheduleId: kind === "scheduled" ? id : null,
          resourceId: r.id,
          database,
          status: failed ? "failed" : "ready",
          kind,
          createdAt: new Date(at).toISOString(),
          finishedAt: new Date(at + secs * 1000).toISOString(),
          sizeBytes: failed ? null : Math.round(size / MB) * MB,
          tier,
          destination,
          storage,
          encryption,
          restoreTest,
          expired: false,
          error: failed ? (tier === "offsite" ? "Upload to S3 timed out after 300s" : "pg_dump: connection to server lost") : null,
        });
      });
      // Retention as the worker runs it: the newest `keep` good ones stay, and with keepDays every one that young.
      const good = made.filter((x) => x.status === "ready").reverse();
      good.forEach((x, i) => {
        if (i >= (p?.keep ?? 7) && (!p?.keepDays || t - Date.parse(x.createdAt) > p.keepDays * DAY)) x.expired = true;
      });
      runs.push(...made);

      const next = p ? firings(p.cron, t, t + 8 * 86_400_000)[0] : undefined;
      tiers[tier] = {
        tier,
        enabled: p ? p.enabled !== false : false,
        cron: p?.cron ?? "0 3 * * *",
        timezone: "UTC",
        keep: p?.keep ?? 7,
        keepDays: p?.keepDays ?? null,
        destination,
        storage,
        available: true,
        nextRunAt: p && next ? new Date(next).toISOString() : null,
        lastRunAt: scheduled.length ? new Date(scheduled.at(-1)!.at).toISOString() : null,
      };
    }

    schedules.push(withFlat({
      id,
      resourceId: r.id,
      database,
      cron: "",
      timezone: "UTC",
      retentionDays: 0,
      destination: "local",
      storage: null,
      encryption,
      enabled: false,
      nextRunAt: null,
      lastRunAt: null,
      tiers,
    }));
  });

  // Orphans: scheduled dumps up to the day the app was deleted, kept 30 days.
  for (const d of DELETED) {
    const deletedAt = t - d.deletedDaysAgo * 86_400_000;
    const database: BackupDatabase = { name: d.name, projectSlug: d.projectSlug, environment: "production", deletedAt: new Date(deletedAt).toISOString() };
    for (const at of firings(d.cron, windowStart, deletedAt)) {
      runs.push({
        id: `bkp_${d.resourceId}_${at}`,
        scheduleId: null,
        resourceId: d.resourceId,
        database,
        status: "ready",
        kind: "scheduled",
        createdAt: new Date(at).toISOString(),
        finishedAt: new Date(at + 22_000).toISOString(),
        sizeBytes: Math.round((d.sizeGb * GB) / MB) * MB,
        tier: "offsite",
        destination: "s3",
        storage: R2,
        encryption: sealed(true),
        restoreTest: NOT_TESTED,
        expired: false,
        error: null,
      });
    }
  }

  runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const nextTest = firings(TEST_CRON, t, t + 2 * 86_400_000)[0];
  return {
    schedules,
    runs,
    config: {
      destinations: [{ ...R2, isDefault: true, lastTestedAt: new Date(t - 12 * 60_000).toISOString(), error: null }],
      encryption: { enabled: true, algorithm: "age, X25519", fingerprint: KEY_FINGERPRINT, createdAt: new Date(Date.UTC(2026, 7, 30, 9, 0, 0)).toISOString() },
      restoreTests: { cron: TEST_CRON, nextRunAt: nextTest ? new Date(nextTest).toISOString() : null },
    },
  };
}
