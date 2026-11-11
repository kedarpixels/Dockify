import { z } from "zod";
import { AppKind, Cursor, HostSnapshot, Iso, MetricRange, QueryFlag, Slug, Uuid } from "./common.ts";
import { BackupStorageRef } from "./backups.ts";
import { VercelLogRetention, WebhookRef } from "./integrations.ts";
import { SecurityRelease } from "./security-release.ts";

export const DiskSliceId = z.enum(["images", "buildCache", "volumes", "logs"]);
export const DiskSlice = z.object({ id: DiskSliceId, bytes: z.number(), reclaimableBytes: z.number(), count: z.number().optional() });
/**
 * A problem the running worker reports about itself with every heartbeat: it keeps working, but some jobs
 * cannot run. `summary` fits a Services row; `message` says what fails and how to fix it.
 */
export const WorkerIssue = z.object({ key: z.string().max(40), summary: z.string().max(120), message: z.string().max(500), since: Iso });
export const ServerSnapshot = z.object({
  host: HostSnapshot,
  system: z.object({ os: z.string(), kernel: z.string(), docker: z.string(), dockify: z.string(), ip: z.string(), cores: z.number(), memoryBytes: z.number() }),
  disk: z.array(DiskSlice),
  containers: z.array(z.object({
    id: z.string(),
    name: z.string(),
    app: z.object({ id: z.string(), name: z.string(), displayName: z.string().optional(), projectSlug: z.string(), environment: z.string(), kind: AppKind.optional() }).nullable(),
    cpuPct: z.number(),
    memoryBytes: z.number(),
    restarts: z.number(),
    startedAt: Iso.nullable(),
    state: z.enum(["running", "restarting", "unhealthy", "exited"]),
  })),
  /**
   * The worker is down past two minutes without a heartbeat; the other services are as the worker last saw
   * their containers. redis is a legacy id: no control-plane service uses it.
   */
  services: z.array(z.object({
    id: z.enum(["api", "worker", "proxy", "postgres", "redis", "web", "buildkit", "socketProxy", "updater", "cloudflared"]),
    status: z.enum(["ok", "degraded", "down"]),
    latencyMs: z.number().nullable(),
    detail: z.string(),
  })),
  janitor: z.object({
    buildCache: z.object({ bytes: z.number(), capBytes: z.number() }),
    pinnedImages: z.object({ count: z.number(), bytes: z.number(), perApp: z.number(), apps: z.number() }),
    nextRunAt: Iso.nullable(),
    lastRunAt: Iso.nullable(),
    lastFreedBytes: z.number().nullable(),
  }).nullable().optional(),
  controlPlaneBackup: z.object({
    status: z.enum(["ready", "running", "failed", "none"]),
    lastAt: Iso.nullable(),
    sizeBytes: z.number().nullable(),
    storage: BackupStorageRef.nullable(),
    encrypted: z.boolean(),
    nextAt: Iso.nullable(),
    error: z.string().nullable(),
  }).nullable().optional(),
});
export const MetricsQuery = z.strictObject({ range: MetricRange.optional() });
export const ServerMetrics = z.object({
  range: MetricRange,
  points: z.array(z.object({ at: Iso, cpu: z.number(), memory: z.number(), disk: z.number(), network: z.number() })),
});
export const PruneBody = z.strictObject({ targets: z.array(z.enum(["images", "buildCache", "logs"])).min(1).max(3) });
export const PruneResult = z.object({ reclaimedBytes: z.number(), disk: z.array(DiskSlice) });

export const ReleaseVersion = z.string().regex(/^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/);
export const ReleaseChannel = z.enum(["stable", "beta"]);
export const UpdateMode = z.enum(["manual", "security", "all"]);
const HourMinute = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const UpdateWindow = z.strictObject({
  /** 0 Sunday to 6 Saturday, in the instance time zone. */
  days: z.array(z.number().int().min(0).max(6)).max(7),
  start: HourMinute,
  /** At or before start: the window runs past midnight. */
  end: HourMinute,
});
export const UpdatePolicy = z.object({
  mode: UpdateMode,
  channel: ReleaseChannel,
  /** null: any time. */
  window: UpdateWindow.nullable(),
  timeZone: z.string(),
  skipVersion: z.string().nullable(),
  pausedUntil: Iso.nullable(),
});
export const UpdatePolicyBody = z.strictObject({
  mode: UpdateMode,
  channel: ReleaseChannel,
  window: UpdateWindow.nullable(),
  timeZone: z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/),
});
/** The steps of an update, in order. A rollback adds its own step at the end. */
export const UpdateStepId = z.enum(["preflight", "pull", "backup", "migrate", "swapApi", "swapWorker", "swapWeb", "health", "rollback"]);
export const UpdateStepRow = z.object({
  id: UpdateStepId,
  status: z.enum(["pending", "running", "done", "failed", "skipped"]),
  startedAt: Iso.nullable(),
  finishedAt: Iso.nullable(),
  detail: z.string().nullable(),
});
export const UpdateJob = z.object({
  id: z.string(),
  kind: z.enum(["update", "rollback"]),
  trigger: z.enum(["manual", "auto"]),
  /** Who clicked, or null for an automatic install. */
  actor: z.string().nullable(),
  from: z.string(),
  version: z.string(),
  phase: UpdateStepId,
  state: z.enum(["waiting", "running", "done", "failed", "rolledBack"]),
  startedAt: Iso,
  finishedAt: Iso.nullable(),
  durationMs: z.number().nullable(),
  /** The control-plane dump taken before anything changed, and its sha256. */
  dumpId: z.string().nullable(),
  dumpSha256: z.string().nullable(),
  error: z.string().nullable(),
  attempt: z.number(),
  steps: z.array(UpdateStepRow),
});
export const ReleaseInfo = z.object({
  version: z.string(),
  publishedAt: Iso,
  minFrom: z.string(),
  migration: z.string(),
  critical: z.boolean(),
  notesUrl: z.string(),
  /** Markdown from the signed manifest. The dashboard escapes HTML and allows https links only. */
  notes: z.string(),
  signed: z.literal(true),
});
export const UpdateStatus = z.object({
  current: z.string(),
  channel: ReleaseChannel,
  /** False when the installer wrote no feed or key: the card says how to set them. */
  configured: z.boolean(),
  feedUrl: z.string().nullable(),
  checkedAt: Iso.nullable(),
  nextCheckAt: Iso.nullable(),
  /** The last check's failure, kept until a check succeeds. */
  checkError: z.string().nullable(),
  policy: UpdatePolicy,
  /** The newest signed release this install may move to now, or null. */
  latest: ReleaseInfo.nullable(),
  /** A newer release that needs `minFrom` first. */
  blocked: z.object({ version: z.string(), minFrom: z.string() }).nullable(),
  /** When the scheduler will install `latest` on its own, or null (manual, skipped, paused, none). */
  autoAt: Iso.nullable(),
  job: UpdateJob.nullable(),
  /** Newest first, at most 20. */
  history: z.array(UpdateJob),
  /** The last good version this install can return to: within 7 days, its dump still on disk. */
  rollback: z.object({ updateId: z.string(), version: z.string(), until: Iso }).nullable(),
  security: SecurityRelease.nullable(),
});
export const ApplyUpdateBody = z.strictObject({ version: ReleaseVersion });
export const RollbackUpdateBody = z.strictObject({ updateId: Uuid });
export const SkipUpdateBody = z.strictObject({ version: ReleaseVersion.nullable() });
export const PauseUpdatesBody = z.strictObject({ days: z.union([z.literal(0), z.literal(7)]) });

export const LogLevel = z.enum(["error", "warn", "info", "debug"]);
const AppIdList = z
  .string()
  .max(64 * 37)
  .transform((v) => v.split(",").filter(Boolean))
  .pipe(z.array(Uuid).max(64));
const LogFilter = {
  apps: AppIdList.optional(),
  q: z.string().max(200).optional(),
  regex: QueryFlag.optional(),
  stream: z.enum(["stdout", "stderr"]).optional(),
  level: LogLevel.optional(),
};
export const LogsQuery = z.strictObject({ ...LogFilter, from: Iso.optional(), to: Iso.optional(), cursor: Cursor.optional() });
export const LogStreamQuery = z.strictObject({ ...LogFilter, since: z.string().regex(/^[\w.:~-]{1,128}$/).optional() });
export const RuntimeLogLine = z.object({
  id: z.string(),
  ts: Iso,
  appId: z.string(),
  stream: z.enum(["stdout", "stderr"]),
  level: LogLevel.nullable().optional(),
  text: z.string(),
});
export const LogPage = z.object({ lines: z.array(RuntimeLogLine), nextCursor: z.string().nullable() });

export const VercelLogsQuery = z.strictObject({
  /** A Dockify deployment id of this app that ran on Vercel; absent means the app's current one. */
  deployment: Uuid.optional(),
  tail: z.coerce.number().int().min(1).max(256).optional(),
});
export const VercelLogStreamQuery = z.strictObject({ deployment: Uuid.optional() });
export const VercelLogDeployment = z.object({
  id: z.string(),
  externalId: z.string(),
  url: z.string().nullable(),
  target: z.enum(["production", "preview"]).nullable(),
  createdAt: Iso,
});
/** LogPage's shape plus where the lines came from. nextCursor is always null: Vercel has no paging back. */
export const VercelLogPage = z.object({
  lines: z.array(RuntimeLogLine),
  nextCursor: z.null(),
  /** The deployment the lines belong to; null when the app has no finished Vercel deployment yet. */
  deployment: VercelLogDeployment.nullable(),
  retention: VercelLogRetention,
  fetchedAt: Iso,
});

/** The host disk alert's threshold when its rule sets none. One value for the worker, the api, the docs and the form. */
export const DISK_ALERT_DEFAULT_PCT = 85;

export const AlertMetric = z.enum(["disk", "service", "down", "crashLoop", "memory"]);
/** Where a rule sends besides its webhooks: email to owners and admins, and the in-app bell. */
export const AlertChannel = z.enum(["email", "bell"]);
export const ControlService = z.enum(["any", "api", "worker", "proxy", "database"]);
const AlertApp = z.object({ id: z.string(), name: z.string(), displayName: z.string().optional(), kind: AppKind, projectSlug: z.string(), environment: z.string() });
export const AlertRule = z.object({
  id: z.string(),
  metric: AlertMetric,
  app: AlertApp.nullable(),
  service: ControlService.nullable(),
  threshold: z.number().nullable(),
  durationMin: z.number(),
  channels: z.array(AlertChannel),
  webhooks: z.array(z.string()),
  enabled: z.boolean(),
  firing: z.boolean(),
  lastFiredAt: Iso.nullable(),
  createdAt: Iso,
});
export const AlertEvent = z.object({
  id: z.string(),
  /** Null once the rule is deleted; its events stay. */
  ruleId: z.string().nullable(),
  metric: AlertMetric,
  app: AlertApp.nullable(),
  service: ControlService.nullable(),
  status: z.enum(["firing", "resolved"]),
  startedAt: Iso,
  resolvedAt: Iso.nullable(),
  detail: z.string(),
  href: z.string(),
  muted: z.boolean(),
});
export const AlertMute = z.object({ appId: z.string(), until: Iso, createdAt: Iso });
export const AlertsPayload = z.object({
  rules: z.array(AlertRule),
  events: z.array(AlertEvent),
  mutes: z.array(AlertMute),
  /** Whether email is set up. discord and webhook are deprecated: whether an enabled webhook of that provider exists. */
  channels: z.object({ discord: z.boolean(), webhook: z.boolean(), email: z.boolean() }),
  webhooks: z.array(WebhookRef),
});
const RuleFields = {
  metric: AlertMetric,
  appId: Uuid.nullable(),
  service: ControlService.nullable(),
  threshold: z.number().min(0).max(1_000_000).nullable(),
  durationMin: z.number().int().min(1).max(1440),
  channels: z.array(AlertChannel).max(4),
  /** The webhooks to send to, by id. Left out on a create, none; on a patch, unchanged. */
  webhooks: z.array(Uuid).max(50).optional(),
  enabled: z.boolean(),
};
export const RuleBody = z.strictObject(RuleFields);
export const RulePatchBody = z.strictObject(RuleFields).partial();
export const MuteParams = z.strictObject({ appId: Uuid });
export const MuteBody = z.strictObject({ hours: z.union([z.literal(1), z.literal(8), z.literal(24)]) });

export const PublicStatusParams = z.strictObject({ slug: Slug });
const StatusState = z.enum(["operational", "degraded", "outage"]);
const IncidentStatus = z.enum(["investigating", "identified", "monitoring", "resolved"]);
export const PublicStatus = z.object({
  slug: z.string(),
  name: z.string(),
  logoUrl: z.string().nullable(),
  state: StatusState,
  updatedAt: Iso,
  components: z.array(z.object({
    name: z.string(),
    state: StatusState,
    days: z.array(z.object({ date: z.string(), state: z.enum(["ok", "minor", "major", "none"]), downMinutes: z.number(), degradedMinutes: z.number() })),
  })),
  incidents: z.array(z.object({
    key: z.string(),
    title: z.string(),
    impact: z.enum(["minor", "major"]),
    status: IncidentStatus,
    startedAt: Iso,
    resolvedAt: Iso.nullable(),
    affects: z.array(z.string()),
    updates: z.array(z.object({ at: Iso, status: IncidentStatus, body: z.string() })),
  })),
});
