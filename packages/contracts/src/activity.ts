import { z } from "zod";
import { ActorKind, ActorRef, AppKind, AppStatus, Cursor, HostSnapshot, Iso, RecentDeployment, Resource, Role, Slug } from "./common.ts";

export const ActivityCategory = z.enum(["deploys", "config", "access", "system"]);
export const ActivityActor = z.object({ id: z.string(), name: z.string(), avatarUrl: z.string().nullable().optional(), kind: ActorKind.optional() });
export const ActivityEvent = z.object({
  id: z.string(),
  at: Iso,
  category: ActivityCategory,
  action: z.string(),
  actor: ActivityActor.nullable(),
  verb: z.string(),
  target: z.object({ label: z.string(), href: z.string().nullable() }).nullable(),
  suffix: z.string().nullable().optional(),
  tone: z.literal("bad").nullable().optional(),
  ip: z.string().nullable(),
  location: z.string().nullable(),
  changes: z.array(z.object({ key: z.string(), before: z.string().nullable(), after: z.string().nullable() })).optional(),
});
export const ActivityQuery = z.strictObject({
  cursor: Cursor.optional(),
  category: ActivityCategory.optional(),
  actor: z.string().max(64).optional(),
  q: z.string().max(200).optional(),
});
export const ActivityPage = z.object({ items: z.array(ActivityEvent), nextCursor: z.string().nullable(), actors: z.array(ActivityActor) });

const byKey = <K extends z.ZodEnum>(k: K) => z.record(k, z.number());
/** One control-plane notice. `id` is stable, so the bell can remember it was read. */
export const SystemNotice = z.object({
  id: z.string(),
  kind: z.enum(["updateAvailable", "updated", "updateFailed", "updateRolledBack"]),
  tone: z.enum(["info", "ok", "bad"]),
  title: z.string(),
  detail: z.string(),
  href: z.string(),
  at: Iso,
});
export const Overview = z.object({
  viewer: z
    .object({
      name: z.string(),
      role: z.union([Role, z.string()]),
      email: z.string().optional(),
      avatarUrl: z.string().optional(),
      /** How this user reads times: an IANA zone (null follows the browser) and the clock. */
      time: z.object({ timeZone: z.string().nullable(), hour12: z.boolean() }).optional(),
    })
    .optional(),
  counts: z.object({
    projects: z.object({ total: z.number(), active: z.number(), archived: z.number() }),
    environments: z.number(),
    apps: z.object({ total: z.number(), byKind: byKey(AppKind), byStatus: byKey(AppStatus) }),
    domains: z.number(),
    deployments: z.object({ total: z.number(), last24h: z.number(), inFlight: z.number() }),
  }),
  recentDeployments: z.array(RecentDeployment),
  /** Each app's newest deployment that left the queue, newest first: what a card says, however quiet the app. */
  lastDeployments: z.array(RecentDeployment),
  resources: z.array(Resource),
  deployTrend: z.array(z.object({ date: z.string(), total: z.number(), failed: z.number() })),
  appHealth: z.array(z.object({ date: z.string(), healthy: z.number(), total: z.number() })).optional(),
  host: HostSnapshot.optional(),
  /** Control-plane notices for the bell: update available, updated, update failed and rolled back. */
  system: z.array(SystemNotice).optional(),
});
export type Overview = z.infer<typeof Overview>;

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const DeploymentsQuery = z.strictObject({
  cursor: Cursor.optional(),
  status: z.enum(["all", "building", "ready", "failed", "cancelled"]).optional(),
  project: Slug.optional(),
  q: z.string().max(200).optional(),
  /** Half-open created_at window, UTC days (the overview heatmap day panel). */
  from: Day.optional(),
  to: Day.optional(),
  provider: z.enum(["dockify", "vercel"]).optional(),
});
export const DeploymentStats = z.object({
  inFlight: z.number(),
  queued: z.number(),
  succeeded24h: z.number(),
  failed24h: z.number(),
  succeededPrev24h: z.number().optional(),
  failedPrev24h: z.number().optional(),
  medianSeconds: z.number().nullable(),
  medianPrevSeconds: z.number().nullable().optional(),
  buckets: z.array(z.object({ at: Iso, ready: z.number(), failed: z.number(), medianSeconds: z.number().nullable() })).optional(),
});
export const DeploymentPage = z.object({ items: z.array(RecentDeployment), nextCursor: z.string().nullable(), stats: DeploymentStats.optional() });

export const StepId = z.enum(["queued", "clone", "build", "push", "release", "deploy", "health"]);
export const StepStatus = z.enum(["pending", "running", "done", "failed", "cancelled", "skipped"]);
export const DeploymentDetail = RecentDeployment.extend({
  actor: ActorRef.nullable(),
  current: z.boolean(),
  error: z.string().nullable(),
  steps: z.array(z.object({ id: StepId, status: StepStatus, startedAt: Iso.nullable(), finishedAt: Iso.nullable() })),
  /** A readiness failure left the previous container serving. */
  rolledBack: z.boolean(),
  /** Why this app cannot get zero downtime, shown before deploy. Empty when it can. */
  swapReasons: z.array(z.string()),
  /** Its app only follows Vercel: Dockify may not change anything there, cancel included. */
  followOnly: z.boolean().optional(),
  /** The pull request a preview deployment was built from; null for any other deployment. */
  pr: z.number().int().positive().nullable().optional(),
});
export const DeploymentLogsQuery = z.strictObject({ after: z.coerce.number().int().min(0).max(10_000_000).optional() });
export const DeploymentLogs = z.object({
  lines: z.array(z.object({ seq: z.number(), ts: Iso, stream: z.enum(["stdout", "stderr"]), text: z.string() })),
  done: z.boolean(),
  /** Where the lines come from: this server's build log, or Vercel's (read live from Vercel). */
  source: z.enum(["dockify", "vercel"]).optional(),
  /** Vercel's log was too large to show whole: these are its last lines, after one notice line. */
  truncated: z.boolean().optional(),
});
export const DeploymentActionResponse = z.object({ deployment: RecentDeployment });
