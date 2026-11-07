import { z } from "zod";
import { Branch, BuilderKind, Capability, Command, ExternalId, ImageRef, Iso, MetricRange, Port, RecentDeployment, RepoPath, Resource, Sysctls, Uuid } from "./common.ts";
import { DomainsPayload } from "./resources.ts";
import { BackupConfig, BackupRun, BackupSchedule } from "./backups.ts";
import { VercelLogRetention } from "./integrations.ts";

export const AppParams = z.strictObject({ id: Uuid });

/** A version a managed service can move to, and how: in place under its volume, or through a new service. */
export const ServiceVersionOption = z.object({ version: z.string(), path: z.enum(["in_place", "new_service"]) });
export const ServiceUpgradePhase = z.enum(["backing_up", "upgrading", "copying", "ready", "switching", "switched", "done", "failed"]);
const Counts = z.object({ tables: z.number(), rows: z.number() });
export const ServiceUpgradeState = z.object({
  phase: ServiceUpgradePhase,
  toVersion: z.string(),
  fromVersion: z.string(),
  at: Iso,
  target: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Tables and rows on each side at the last copy. Differences before the switch are writes since. */
  sourceCounts: Counts.nullable(),
  targetCounts: Counts.nullable(),
  copiedAt: Iso.nullable(),
  error: z.string().nullable(),
});
export const ServiceVersionView = z.object({
  kind: z.enum(["postgres", "redis"]),
  version: z.string().nullable(),
  image: z.string(),
  /** The digest this service runs, once its first pull recorded it. */
  pin: z.string().nullable(),
  /** Never older than what it runs: a downgrade is refused. */
  options: z.array(ServiceVersionOption),
  linkedApps: z.array(z.object({ id: z.string(), name: z.string() })),
  upgrade: ServiceUpgradeState.nullable(),
  /** After the switch: the service that links now lead to. */
  redirect: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** A version change is running. */
  busy: z.boolean(),
});
export const ServiceVersionChange = z.strictObject({
  version: z.string().regex(/^[\w.-]{1,20}$/),
  /** The service's name, typed. */
  confirm: z.string().min(1).max(64),
});
export const ServiceVersionConfirm = z.strictObject({ confirm: z.string().min(1).max(64) });

export const AppSettings = z.strictObject({
  /** Left out, a patch keeps the rule that a Dockerfile path means the Dockerfile builder. */
  builder: BuilderKind.optional(),
  installCommand: Command.optional(),
  buildCommand: Command,
  startCommand: Command,
  dockerfilePath: RepoPath,
  port: Port.nullable(),
  healthCheckPath: z.string().regex(/^(|\/[\x21-\x7e]{0,255})$/),
  cpuLimit: z.number().min(0.1).max(64).nullable(),
  memoryLimitMb: z.number().int().min(64).max(262_144).nullable(),
});
/**
 * Advanced fields change what runs or with what privilege, so a change to any of them needs a
 * step-up. Capabilities and sysctls come only from the shared allowlist.
 */
export const AppAdvanced = z.strictObject({
  rootDir: RepoPath.optional(),
  releaseCommand: Command.optional(),
  capAdd: z.array(Capability).max(2).optional(),
  sysctls: Sysctls.optional(),
});
/**
 * What the app runs: the image of an image app, the branch of a git app (null follows the
 * environment's branch). Either applies on the next deploy, through the same elevated patch.
 */
export const AppSource = z.strictObject({
  image: ImageRef.optional(),
  branch: Branch.nullable().optional(),
});
export const AppPatchBody = z.strictObject({ settings: AppSettings, advanced: AppAdvanced.optional(), source: AppSource.optional() });

export const AppUsage = z.object({ cpuPct: z.number(), memoryBytes: z.number(), memoryLimitBytes: z.number() });
export const AppDetail = Resource.extend({
  /** This caller can open a web terminal here: an admin's browser session, on this server, with the switch on. */
  terminal: z.boolean().optional(),
  url: z.string().nullable(),
  image: z.string().nullable(),
  /** The git repository URL the app builds from; null for an image source. */
  repo: z.string().nullable(),
  /** A git app's own branch; null follows its environment's branch, and an image app has none. */
  branch: z.string().nullable().optional(),
  /** Where it is built and served: vercel means Vercel hosts it and nothing of it runs on this server. */
  target: z.object({ kind: z.enum(["server", "vercel"]), vercelProjectId: z.string().nullable(), mode: z.enum(["follow", "deploy"]).optional() }).optional(),
  replicas: z.object({ desired: z.number(), running: z.number() }),
  ports: z.array(z.object({ container: z.number(), host: z.number().nullable(), protocol: z.enum(["tcp", "udp"]) })),
  settings: AppSettings,
  usage: AppUsage.optional(),
  metrics: z.array(z.object({ at: Iso, cpuPct: z.number(), memoryBytes: z.number() })).optional(),
  deployments: z.array(RecentDeployment),
});
export const AppLogsQuery = z.strictObject({ tail: z.coerce.number().int().min(1).max(1000).optional() });
export const AppLogs = z.object({
  lines: z.array(z.object({ at: Iso, stream: z.enum(["stdout", "stderr"]), text: z.string() })),
  /** vercel for a Vercel app: the tail of its current deployment's runtime logs, read from Vercel. */
  source: z.enum(["dockify", "vercel"]).optional(),
  /** Vercel apps only: how far back Vercel keeps these lines. */
  retention: VercelLogRetention.optional(),
});
export const DeployResponse = z.object({ deploymentId: z.string() });

// ------------------------------------------------------------------ app tabs

export const RangeQuery = z.strictObject({ range: MetricRange.optional() });
export const AppMetrics = z.object({
  range: MetricRange,
  points: z.array(z.object({ at: Iso, cpuPct: z.number(), memoryBytes: z.number(), netInBps: z.number(), netOutBps: z.number(), restarts: z.number() })),
  limits: z.object({ cpuCores: z.number(), memoryBytes: z.number(), pids: z.number() }),
  current: z.object({ cpuPct: z.number(), memoryBytes: z.number(), pids: z.number() }).nullable(),
  lastRestartAt: Iso.nullable(),
});
export const AppDomains = DomainsPayload;

const Cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const PgColumn = z.object({ name: z.string(), type: z.string(), nullable: z.boolean().optional(), primary: z.boolean().optional() });
export const PgTables = z.object({ database: z.string(), tables: z.array(z.object({ schema: z.string(), name: z.string(), rows: z.number(), sizeBytes: z.number() })) });
export const PgRowsQuery = z.strictObject({
  table: z.string().regex(/^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_$]{0,62}$/i),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export const PgRows = z.object({ table: z.string(), columns: z.array(PgColumn), rows: z.array(z.array(Cell)), total: z.number() });
export const RedisKeysQuery = z.strictObject({
  match: z.string().max(200).regex(/^[\x20-\x7e]*$/).optional(),
  count: z.coerce.number().int().min(1).max(1000).optional(),
});
export const RedisKeys = z.object({
  keys: z.array(z.object({ key: z.string(), type: z.enum(["string", "hash", "list", "set", "zset", "stream"]), ttlSeconds: z.number().nullable(), sizeBytes: z.number() })),
  total: z.number(),
  truncated: z.boolean(),
});
export const QueryBody = z.strictObject({ sql: z.string().min(1).max(20_000) });
export const QueryResult = z.object({ columns: z.array(PgColumn), rows: z.array(z.array(Cell)), rowCount: z.number(), durationMs: z.number(), truncated: z.boolean() });
export const AppBackups = z.object({ schedule: BackupSchedule.nullable(), runs: z.array(BackupRun), config: BackupConfig.nullable() });

export const HealthCheck = z.strictObject({
  path: z.string().regex(/^(|\/[\x21-\x7e]{0,255})$/),
  expectedStatus: z.number().int().min(100).max(599),
  timeoutSeconds: z.number().int().min(1).max(120),
  gracePeriodSeconds: z.number().int().min(0).max(600),
  intervalSeconds: z.number().int().min(2).max(300),
});
export const AppLimits = z.strictObject({
  cpuCores: z.number().min(0.1).max(64).nullable(),
  memoryMb: z.number().int().min(64).max(262_144).nullable(),
  pids: z.number().int().min(16).max(65_536).nullable(),
});
/**
 * follow: Dockify only reads the Vercel project, and nothing is ever sent to it. deploy: Dockify
 * pushes the app's variables and secrets to it and asks it to deploy. Sent without a mode, a link follows.
 */
export const VercelLinkMode = z.enum(["follow", "deploy"]);
const DeployTargetRef = z.strictObject({ kind: z.enum(["server", "vercel"]), vercelProjectId: ExternalId.nullable(), mode: VercelLinkMode.optional() });
export const AppConfig = z.object({
  health: HealthCheck,
  limits: AppLimits,
  defaults: z.object({ cpuCores: z.number(), memoryMb: z.number(), pids: z.number() }),
  release: z.object({ command: z.string() }),
  zeroDowntime: z.object({ possible: z.boolean(), blockers: z.array(z.enum(["volume", "fixed-port"])) }),
  target: DeployTargetRef.nullable(),
  vercel: z
    .object({
      connected: z.boolean(),
      projects: z.array(z.object({ id: z.string(), name: z.string(), framework: z.string().nullable() })),
      sync: z
        .object({
          state: z.enum(["synced", "pending", "failed"]),
          at: Iso.nullable(),
          envVars: z.number(),
          lastDeploy: z.object({ url: z.string(), state: z.enum(["ready", "building", "error"]), at: Iso }).nullable(),
          error: z.string().nullable().optional(),
        })
        .nullable(),
    })
    .nullable(),
});
export const AppConfigPatch = z
  .strictObject({
    health: HealthCheck.optional(),
    limits: AppLimits.optional(),
    release: z.strictObject({ command: z.string().max(500).refine((v) => !/[\r\n\0]/.test(v), "One line") }).optional(),
    target: DeployTargetRef.optional(),
    /** Required, as true, by any change that starts sending this app's variables and secrets to Vercel. */
    confirmSendSecrets: z.literal(true).optional(),
  })
  .refine((p) => !p.target || (p.target.kind === "vercel") === (p.target.vercelProjectId !== null), "A Vercel target needs its project id")
  .refine((p) => p.target?.kind !== "server" || p.target.mode === undefined, "Only a Vercel link has a mode");

export const TerminalTicket = z.object({ ticket: z.string(), expiresAt: Iso });
