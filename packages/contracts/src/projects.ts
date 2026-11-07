import { z } from "zod";
import {
  ActorKind, AppKind, AppName, Branch, BuilderKind, Command, ConfirmText, DisplayName, EnvKey, EnvName, EnvValue, Hostname, HttpsUrl, ImageRef, Iso,
  isReservedSlug, Port, RecentDeployment, RepoPath, RepoUrl, Resource, SafeLabel, Slug, TlsStatus, Uuid, VolumeName,
} from "./common.ts";
import { EnvRef, EnvRefView } from "./env-refs.ts";
import { GitRef } from "./integrations.ts";

export * from "./env-refs.ts";

export const SlugParams = z.strictObject({ slug: Slug });

// ------------------------------------------------------------------ projects

export const ProjectEnvironment = z.object({ name: z.string(), branch: z.string() });
export const AppUsage = z.object({ cpuPct: z.number(), memoryBytes: z.number(), memoryLimitBytes: z.number() });
export const AppSummary = Resource.extend({ url: z.string().nullable(), usage: AppUsage.optional(), lastDeployment: RecentDeployment.optional() });
export const ProjectDomain = z.object({
  id: z.string(),
  host: z.string(),
  appId: z.string(),
  appName: z.string(),
  environment: z.string(),
  tls: TlsStatus,
  expiresAt: Iso.nullable(),
});
export const ProjectDetail = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  repo: z.object({ url: z.string(), label: z.string() }).nullable(),
  defaultBranch: z.string(),
  autoDeploy: z.boolean(),
  createdAt: Iso,
  environments: z.array(ProjectEnvironment),
  apps: z.array(AppSummary),
  deployments: z.array(RecentDeployment),
  domains: z.array(ProjectDomain),
});
export const ProjectListItem = z.object({ id: z.string(), slug: z.string(), name: z.string(), createdAt: Iso, apps: z.number(), environments: z.array(z.string()) });

export const NewProjectBody = z.strictObject({
  /** Empty for a project that only runs images and services. */
  repoUrl: z.union([z.literal(""), RepoUrl]),
  /** The slug comes from the name; a reserved one (RESERVED_SLUGS) is refused here and again after slugify. */
  name: DisplayName.refine((n) => !isReservedSlug(n), "That name is reserved"),
  /** Left out, the instance's default branch (Settings, Instance). */
  defaultBranch: Branch.optional(),
  environments: z.array(EnvName).min(1).max(10),
  git: GitRef.optional(),
});
export const NewProjectResponse = z.object({ slug: z.string() });
export const ProjectPatchBody = z.strictObject({
  name: DisplayName.optional(),
  autoDeploy: z.boolean().optional(),
  environments: z.array(z.strictObject({ name: EnvName, branch: Branch })).max(10).optional(),
});
export const ConfirmBody = z.strictObject({ confirm: ConfirmText });

// ------------------------------------------------------------------ project env (simple)

export const EnvVarRow = z.object({ key: z.string(), value: z.string(), secret: z.boolean(), updatedAt: Iso });
export const ProjectEnv = z.object({ environments: z.array(z.object({ name: z.string(), vars: z.array(EnvVarRow) })) });
/**
 * Keys that change what code a container runs before the app's own code starts (loader and
 * interpreter hooks). Setting one needs an elevated session that says so explicitly, and it is
 * written to the activity log; a token can never set one.
 */
export const DANGEROUS_ENV_KEYS: ReadonlySet<string> = new Set([
  "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_PRESERVE_SYMLINKS",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "LD_DEBUG_OUTPUT", "GCONV_PATH", "GLIBC_TUNABLES",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "BASH_ENV", "ENV", "PROMPT_COMMAND", "ZDOTDIR", "SHELLOPTS", "BASHOPTS",
  "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PYTHONWARNINGS", "PYTHONINSPECT",
  "PERL5OPT", "PERL5LIB", "PERLLIB", "PERL5DB",
  "RUBYOPT", "RUBYLIB",
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "JAVA_OPTIONS",
  "DOTNET_STARTUP_HOOKS", "CORECLR_PROFILER", "CORECLR_PROFILER_PATH", "CORECLR_ENABLE_PROFILING",
  "GODEBUG", "GOFLAGS",
  "PHP_INI_SCAN_DIR", "PHPRC",
]);
export const isDangerousEnvKey = (key: string): boolean => DANGEROUS_ENV_KEYS.has(key.toUpperCase());

export const EnvPutBody = z.strictObject({
  environment: EnvName,
  vars: z.array(z.strictObject({ key: EnvKey, value: EnvValue, secret: z.boolean() })).min(1).max(200),
  /** Required (true) when a var sets a loader or interpreter hook key; see DANGEROUS_ENV_KEYS. */
  confirmDangerous: z.boolean().optional(),
});
export const EnvDeleteBody = z.strictObject({ environment: EnvName, key: EnvKey });

// ------------------------------------------------------------------ project env (versioned)

export const EnvTarget = z.enum(["build", "runtime", "both"]);
export const EnvEntry = z.object({
  key: z.string(),
  value: z.string().nullable(),
  secret: z.boolean(),
  target: EnvTarget,
  updatedAt: Iso,
  updatedBy: z.string().nullable(),
  /** Set when the variable links a managed service; `value` is then null. */
  ref: EnvRefView.optional(),
});
export const EnvState = z.object({
  version: z.number(),
  environments: z.array(z.object({ name: z.string(), vars: z.array(EnvEntry) })),
  overrides: z.array(z.object({ appId: z.string(), appName: z.string(), environment: z.string(), vars: z.array(EnvEntry) })),
});
export const EnvOp = z.enum(["add", "change", "remove"]);
export const EnvChange = z.strictObject({
  environment: EnvName,
  appId: Uuid.optional(),
  key: EnvKey,
  op: EnvOp,
  value: EnvValue.optional(),
  /** Links a service in this project instead of setting a value. Never sent with `value`. */
  ref: EnvRef.optional(),
  secret: z.boolean().optional(),
  target: EnvTarget.optional(),
}).refine((c) => c.value === undefined || c.ref === undefined, "A variable holds a value or a reference, not both");
export const EnvApplyBody = z.strictObject({
  baseVersion: z.number().int().min(0),
  changes: z.array(EnvChange).min(1).max(200),
  redeploy: z.boolean(),
  confirmDangerous: z.boolean().optional(),
});
export const EnvApplyResponse = z.object({ version: z.number(), deploymentIds: z.array(z.string()) });
/**
 * One value, opened for a signed-in Admin without a fresh step-up.
 * `purpose` says whether the eye or the copy button asked; both are audited the same.
 */
export const EnvRevealPurpose = z.enum(["view", "copy"]);
export const EnvRevealBody = z.strictObject({ environment: EnvName, appId: Uuid.optional(), key: EnvKey, purpose: EnvRevealPurpose.optional() });
export const EnvRevealResponse = z.object({ value: z.string() });
export const EnvVersionsQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(200).optional() });
export const EnvVersion = z.object({
  version: z.number(),
  at: Iso,
  actor: z.string(),
  actorAvatarUrl: z.string().nullable(),
  actorKind: ActorKind,
  source: z.enum(["dashboard", "api", "rollback"]),
  restoredFrom: z.number().optional(),
  changes: z.array(z.object({
    environment: z.string(),
    appId: z.string().optional(),
    appName: z.string().optional(),
    key: z.string(),
    op: EnvOp,
    secret: z.boolean(),
    target: EnvTarget,
  })),
  redeployed: z.number(),
});
export const EnvVersions = z.object({ versions: z.array(EnvVersion) });
export const EnvRollbackBody = z.strictObject({ version: z.number().int().min(1), baseVersion: z.number().int().min(0), redeploy: z.boolean(), confirmDangerous: z.boolean().optional() });
export const EnvRollbackResponse = z.object({ version: z.number() });

// ------------------------------------------------------------------ environments

export const EnvironmentParams = z.strictObject({ slug: Slug, name: EnvName });
export const AddEnvironmentBody = z.strictObject({ name: EnvName, branch: Branch, copyFrom: EnvName.optional() });
export const EnvironmentBranchBody = z.strictObject({ branch: Branch });

// ------------------------------------------------------------------ previews

/** Every guardrail of a project's pull request previews. Defaults are the cheap ones. */
export const PreviewAccess = z.enum(["public", "password"]);
export type PreviewAccess = z.infer<typeof PreviewAccess>;
export const PreviewSettings = z.strictObject({
  enabled: z.boolean(),
  /** The environment each preview copies. Production is never the default. */
  baseEnvironment: EnvName,
  /** Apps marked "include in previews". Databases are never cloned. */
  appIds: z.array(Uuid).max(20),
  /** Overrides the instance preview domain for this project; null uses the instance one. */
  domain: Hostname.nullable(),
  maxConcurrent: z.number().int().min(1).max(20),
  /** The server-wide cap, shared by every project. */
  serverMaxConcurrent: z.number().int().min(1).max(50),
  cpuLimit: z.number().min(0.1).max(8),
  memoryMb: z.number().int().min(64).max(16_384),
  pidsLimit: z.number().int().min(16).max(4096),
  /** Stop a preview's containers after this many minutes without a request; 0 never sleeps. */
  idleMinutes: z.number().int().min(0).max(1440),
  /** Delete a preview after this many hours without a commit. */
  ttlHours: z.number().int().min(1).max(720),
  /** Build PRs from forks, never with a secret. */
  fromForks: z.boolean(),
  /** A throwaway Postgres per preview instead of the base environment's. */
  isolatedDb: z.boolean(),
  /** A same-repo preview of a production base may have production's secrets and network. Off by default. */
  productionAccess: z.boolean(),
  /** Who can open a preview's URL: anyone with the link, or whoever has the project's preview password. */
  access: PreviewAccess,
});
export type PreviewSettings = z.infer<typeof PreviewSettings>;

/** A saved settings answer. `password` appears once: when this save was the one that needed a first password. */
export const PreviewSettingsSaved = PreviewSettings.extend({ password: z.string().optional() });
export const PreviewPassword = z.object({ password: z.string(), setAt: Iso });

export const PREVIEW_DEFAULTS = {
  baseEnvironment: "development", maxConcurrent: 2, serverMaxConcurrent: 4, cpuLimit: 0.5, memoryMb: 512, pidsLimit: 128,
  idleMinutes: 30, ttlHours: 72, fromForks: false, isolatedDb: false, productionAccess: false, access: "password",
} as const;

/**
 * What a preview shares with its base environment:
 *   base  its secrets and its network
 *   own   neither: plain variables and a network of its own
 *   fork  neither: plain variables and the shared fork network
 */
export const PreviewIsolation = z.enum(["base", "own", "fork"]);
export type PreviewIsolation = z.infer<typeof PreviewIsolation>;

const PRODUCTION_NAMES = new Set(["production", "prod", "live"]);

/**
 * An environment holds real data when it is named so, or when it is the project's only one: a project
 * with one environment has nothing else to deploy to, whatever it calls it. Branches say nothing,
 * since a new project's environments all start on the default branch.
 */
export const isProductionEnvironment = (name: string, environmentCount: number): boolean => PRODUCTION_NAMES.has(name) || environmentCount < 2;

/**
 * Pure, and the one place this is decided: the worker reads it to run a preview, and the card, email
 * and comment read it to describe one. Pushing to a branch must not be enough to get production's
 * secrets, so that takes the project owner's explicit setting. A fork never gets them, setting or not.
 */
export function previewIsolation(p: {
  fromFork: boolean;
  baseEnvironment: { name: string };
  project: { previewProductionAccess: boolean; environments: readonly unknown[] };
}): PreviewIsolation {
  if (p.fromFork) return "fork";
  if (!isProductionEnvironment(p.baseEnvironment.name, p.project.environments.length)) return "base";
  return p.project.previewProductionAccess ? "base" : "own";
}

/**
 * The default instance preview domain: preview.<parent of the dashboard host>. dash.example.com
 * gives preview.example.com; an apex dashboard (example.com) gives preview.example.com too. A name
 * that spells its address (203-0-113-4.sslip.io) has no parent of its own: previews go under it, where
 * sslip.io still answers with that address.
 */
export function defaultPreviewDomain(publicUrl: string): string | null {
  let host: string;
  try {
    host = new URL(publicUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (!host || /^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return null;
  const labels = host.split(".");
  if (/^\d{1,3}(?:-\d{1,3}){3}\.(?:sslip|nip)\.io$/.test(host)) return `preview.${host}`;
  const parent = labels.length > 2 ? labels.slice(1).join(".") : host;
  return `preview.${parent}`;
}

export type PreviewDomainSource = "project" | "instance" | "derived";

/** Precedence: the project's override, then the instance setting, then the derived default. */
export function effectivePreviewDomain(project: string | null, instance: string | null, publicUrl: string): { domain: string | null; source: PreviewDomainSource } {
  if (project) return { domain: project.toLowerCase(), source: "project" };
  if (instance) return { domain: instance.toLowerCase(), source: "instance" };
  return { domain: defaultPreviewDomain(publicUrl), source: "derived" };
}

/** The wildcard record that serves a preview domain. */
export const previewWildcard = (domain: string): string => `*.${domain}`;

/** Memory a preview's throwaway Postgres may use. */
export const PREVIEW_DB_MEMORY_MB = 256;

/** The most a project's previews can use: "At most 2 previews, about 1 CPU and 1 GB". */
export function previewCeiling(s: Pick<PreviewSettings, "maxConcurrent" | "cpuLimit" | "memoryMb" | "isolatedDb">, apps: number): { previews: number; cpu: number; memoryMb: number } {
  const perPreview = Math.max(apps, 1);
  const cpu = Math.round(s.maxConcurrent * perPreview * s.cpuLimit * 100) / 100;
  const memoryMb = s.maxConcurrent * (perPreview * s.memoryMb + (s.isolatedDb ? PREVIEW_DB_MEMORY_MB : 0));
  return { previews: s.maxConcurrent, cpu, memoryMb };
}

export const PreviewStatus = z.enum(["building", "ready", "asleep", "failed", "blocked", "closing", "closed"]);
export const PreviewApp = z.object({
  appId: z.string(),
  name: z.string(),
  kind: AppKind,
  url: z.string().nullable(),
  /** The newest deployment of this app in the preview. */
  deployment: z.object({ id: z.string(), status: RecentDeployment.shape.status, commit: z.string().nullable(), error: z.string().nullable(), createdAt: Iso }).nullable(),
  cpuPct: z.number().nullable(),
  memoryBytes: z.number().nullable(),
});
export const PreviewRow = z.object({
  pr: z.number(),
  /** The ephemeral environment's name, pr-<n>. */
  name: z.string(),
  title: z.string(),
  branch: z.string(),
  author: z.string().nullable(),
  status: PreviewStatus,
  /** Why it is blocked or was removed (disk, cap, base, evicted, closed, merged, ttl, disabled, deleted). */
  reason: z.string().nullable(),
  error: z.string().nullable(),
  /** The first app's URL. */
  url: z.string().nullable(),
  commit: z.string().nullable(),
  /** The base repository the pull request is on, as https://github.com/owner/name. */
  repo: z.string().nullable(),
  fromFork: z.boolean(),
  isolatedDb: z.boolean(),
  /** What it shares with its base environment, under the project's setting now. */
  isolation: PreviewIsolation,
  baseEnvironment: z.string(),
  createdAt: Iso,
  updatedAt: Iso,
  lastCommitAt: Iso,
  lastRequestAt: Iso.nullable(),
  sleptAt: Iso.nullable(),
  /** When the TTL deletes it if nothing is pushed. */
  expiresAt: Iso.nullable(),
  usage: z.object({ cpuPct: z.number().nullable(), memoryBytes: z.number().nullable() }),
  apps: z.array(PreviewApp),
});
export const PreviewDns = z.object({
  /** The domain previews of this project use, and where it came from. */
  domain: z.string().nullable(),
  source: z.enum(["project", "instance", "derived"]),
  /** Whether *.domain resolves to this server, from the last check. Previews refuse to start until it does. */
  status: z.enum(["ok", "mismatch", "missing", "unchecked"]),
  detail: z.string().nullable(),
  checkedAt: Iso.nullable(),
  /** Cloudflare automation for the wildcard record. */
  cloudflare: z.enum(["none", "pending", "managed", "external", "failed"]),
  cloudflareMessage: z.string().nullable(),
  /** The record to create by hand (or the one Dockify made). */
  record: z.object({ type: z.enum(["CNAME", "A"]), name: z.string(), content: z.string() }).nullable(),
  /** How preview certificates are issued in this ingress mode. */
  tls: z.enum(["cloudflare", "wildcard_dns01", "per_host_http01"]),
});
export const PreviewState = z.object({
  settings: PreviewSettings,
  /** When the project's preview password was made; null while it has none. The password itself is never readable. */
  passwordSetAt: Iso.nullable(),
  /** Open previews first, then the 20 newest closed ones. */
  previews: z.array(PreviewRow),
  server: z.object({ running: z.number(), cap: z.number(), diskPct: z.number().nullable(), diskGuardPct: z.number() }),
  dns: PreviewDns,
  ceiling: z.object({ previews: z.number(), cpu: z.number(), memoryMb: z.number() }),
});
export const PreviewDetail = PreviewRow.extend({
  deployments: z.array(RecentDeployment),
});
export const PreviewParams = z.strictObject({ slug: Slug, pr: z.coerce.number().int().min(1).max(10_000_000) });

// ------------------------------------------------------------------ status page

export const StatusPageState = z.object({ enabled: z.boolean(), path: z.string(), publicApps: z.number() });
export const StatusPagePatch = z.strictObject({
  enabled: z.boolean().optional(),
  /** Shown on a public page: no control, direction or invisible characters (SafeLabel). */
  title: SafeLabel(100).nullable().optional(),
  logoUrl: HttpsUrl.nullable().optional(),
  /** Replaces the component list when present. */
  items: z.array(z.strictObject({ appId: Uuid, label: SafeLabel(60, 1) })).max(50).optional(),
});

// ------------------------------------------------------------------ new app ("host any application")

export const ServiceKind = z.enum(["postgres", "redis", "minio"]);
export const Builder = BuilderKind;
export const BuildSettings = z.strictObject({
  builder: Builder,
  framework: z.string().max(40).nullable(),
  rootDir: RepoPath,
  /** Replaces the install step of a Railpack build. */
  installCommand: Command.optional(),
  buildCommand: Command,
  startCommand: Command,
  dockerfilePath: RepoPath,
  port: Port.nullable(),
});
export const AppSource = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("git"), repoUrl: RepoUrl, branch: Branch, git: GitRef.optional() }),
  z.strictObject({ type: z.literal("image"), image: ImageRef, registryId: Uuid.nullable() }),
  z.strictObject({ type: z.literal("service"), service: ServiceKind, version: z.string().regex(/^[\w.-]{1,20}$/) }),
]);
/**
 * One app. Whatever the body says, the API never publishes a host port, never runs privileged,
 * adds no capabilities and mounts no host path: there is no field for any of those.
 */
export const AppSpec = z.strictObject({
  name: AppName,
  kind: AppKind,
  source: AppSource,
  build: BuildSettings.optional(),
  run: z.strictObject({ startCommand: Command, port: Port.nullable() }).optional(),
  env: z.array(z.strictObject({ key: EnvKey, value: EnvValue })).max(200).optional(),
  volumes: z.array(z.strictObject({ name: VolumeName, path: z.string().regex(/^\/[\w.\-/]{0,200}$/) })).max(10).optional(),
  target: z.enum(["server", "vercel"]),
});
/**
 * Apps a new Postgres or Redis is linked to as it is created: each gets DATABASE_URL or REDIS_URL as
 * a reference to the service (env-refs.ts), so a changed credential follows on its next deploy.
 * `replace` names the apps whose variable of that name the caller agreed to replace; any other app
 * that already has one makes the create answer 409 LINK_CONFLICT with those apps, and nothing is created.
 */
export const ServiceLink = z.strictObject({
  apps: z.array(Uuid).max(50),
  replace: z.array(Uuid).max(50).optional(),
});
/**
 * Two shapes, chosen by what the body holds rather than tried in turn. A z.union returns the only
 * branch that did not abort, and a strict object's "unrecognized key" does not abort: a full spec
 * with one bad field fell through to the bare shape and answered `Unrecognized key: "source"`
 * instead of naming the field. Routing keeps each shape's own errors, with their paths.
 */
function routed<A extends z.ZodType, B extends z.ZodType>(isA: (v: Record<string, unknown>) => boolean, a: A, b: B) {
  return z.unknown().transform((v, ctx): z.output<A> | z.output<B> => {
    const schema = typeof v === "object" && v !== null && isA(v as Record<string, unknown>) ? a : b;
    const out = (schema as z.ZodType).safeParse(v);
    if (out.success) return out.data as z.output<A> | z.output<B>;
    for (const issue of out.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: [...issue.path] });
    return z.NEVER;
  });
}
const BARE_APP_KEYS = new Set(["name", "kind", "environment"]);
/** Old shape { name, kind, environment } stays valid: a bare app with no source yet. Any other key means the full spec. */
export const NewAppBody = routed(
  (v) => Object.keys(v).some((k) => !BARE_APP_KEYS.has(k)),
  AppSpec.extend({ environment: EnvName, link: ServiceLink.optional() }),
  z.strictObject({ name: AppName, kind: AppKind, environment: EnvName }),
);
export const NewAppResponse = z.object({ id: z.string() });
/** Compose text (YAML or JSON). dryRun returns the translation and its refusals without creating. */
export const ComposeImportBody = z.strictObject({ environment: EnvName, compose: z.string().min(1).max(256 * 1024), dryRun: z.boolean().optional() });
export const ImportAppsBody = routed(
  (v) => "apps" in v,
  z.strictObject({ environment: EnvName, apps: z.array(AppSpec).min(1).max(20) }),
  ComposeImportBody,
);
export const ImportAppsResponse = z.object({
  ids: z.array(z.string()),
  warnings: z.array(z.string()).optional(),
  refusals: z.array(z.object({ field: z.string(), reason: z.string() })).optional(),
});
export const DetectBody = z.strictObject({ repoUrl: RepoUrl, branch: Branch, rootDir: RepoPath, git: GitRef.optional() });
/** Ask again with the same body while `pending`: the read runs on the worker, and a repeat never starts a second one. */
export const DetectResult = z.object({
  pending: z.boolean(),
  detected: z.boolean(),
  builder: Builder,
  hasDockerfile: z.boolean(),
  framework: z.string().nullable(),
  /** Served as static files, so nothing of it needs a server process. */
  staticSite: z.boolean(),
  /** Why nothing was detected, in a sentence. */
  reason: z.string().nullable(),
  rootDir: z.string(),
  installCommand: z.string(),
  buildCommand: z.string(),
  startCommand: z.string(),
  dockerfilePath: z.string(),
  port: z.number().nullable(),
});
