import { z } from "zod";

/** The one page Traefik sends a sleeping preview's hosts to (worker edge/routes.ts, api modules/previews/asleep-route.ts). */
export const PREVIEW_ASLEEP_PATH = "/.well-known/dockify-preview-asleep";
/**
 * The password form's address on a protected preview's host. Traefik sends exactly this path to the
 * api, with the preview's id added by the route file so a visitor cannot pick another preview's.
 */
export const PREVIEW_GATE_PATH = "/.well-known/dockify-preview-gate";
/** What Traefik's forwardAuth asks on every request to a preview. Not under the api's public prefix. */
export const PREVIEW_GATE_CHECK_PATH = "/internal/preview-gate";

/** A name a frontend bundler reads at build time for the browser: public by nature, and it must reach the build as an ARG. */
export const isPublicBuildKey = (key: string): boolean => /^(?:NEXT_PUBLIC_|NUXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|GATSBY_|EXPO_PUBLIC_)/.test(key);

/** ISO 8601 timestamp as the API sends it. */
/** A zone this runtime knows (Intl accepts it), such as Europe/Berlin or UTC. */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A date as the API answers it; null stays null. */
export function iso(d: Date): string;
export function iso(d: Date | null | undefined): string | null;
export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export const Iso = z.string().max(40);
export const Uuid = z.uuid();
/** Opaque pagination cursor. */
export const Cursor = z.string().min(1).max(512).regex(/^[\w.:~=-]+$/);
/** An outside id (GitHub, Cloudflare, Vercel): short and URL safe. */
export const ExternalId = z.string().regex(/^[\w-]{1,64}$/);

export const Slug = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/, "Use lowercase letters, digits and dashes");
/**
 * Project slugs no project may take. "new" is the web's New project address (/projects/new), which
 * always wins over /projects/:slug, so a project called "new" could never be opened there. The web
 * mirrors this list in apps/web/lib/validation.ts.
 */
export const RESERVED_SLUGS: readonly string[] = ["new"];
export const isReservedSlug = (slug: string): boolean => RESERVED_SLUGS.includes(slug.trim().toLowerCase());
/**
 * Dockify's own container names and DNS aliases start with this: dk-<app id>, and dk-route-<id>, the
 * alias each app container's route points at. A managed service's app name is its DNS alias on
 * networks the proxy joins, so no app may take a name with this prefix and answer for one of those.
 */
export const RESERVED_NAME_PREFIX = "dk-";
export const AppName = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/, "Use lowercase letters, digits and dashes")
  .refine((v) => !v.startsWith(RESERVED_NAME_PREFIX), `Names starting with ${RESERVED_NAME_PREFIX} are reserved for Dockify`);
/**
 * Names no managed service may take. A service answers to its app name on its environment network,
 * which Docker's DNS searches before the control plane's internal networks while the worker or the
 * proxy has joined it. Nothing of Dockify's dials these names any more (the database and the socket
 * proxy have fixed addresses, the proxy's alias is dk-proxy), so this is the second layer: a tenant
 * can never answer for one even on an install whose compose file is older than that. Only a service
 * gets an alias, so an ordinary app called "web" or "api" stays fine. A service that already has one
 * of these names keeps it, and its alias: no existing data or connection string changes.
 */
export const RESERVED_SERVICE_NAMES: readonly string[] = [
  "api", "buildkit", "cloudflared", "dockify-proxy", "dockify-worker", "migrate", "postgres", "proxy", "proxy-direct", "socket-proxy", "updater", "web", "worker",
];
export const isReservedServiceName = (name: string): boolean => RESERVED_SERVICE_NAMES.includes(name.trim().toLowerCase());
export const RESERVED_SERVICE_MESSAGE = "Dockify's own services use this name. Try another, such as main-db";
/** A name for a service that is not one of those: a compose file's "postgres" becomes "postgres-db". */
export const unreservedServiceName = (name: string): string => (isReservedServiceName(name) ? `${name}-db` : name);
/** A managed service's app name: AppName, and none of the names above. */
export const ServiceName = AppName.refine((v) => !isReservedServiceName(v), RESERVED_SERVICE_MESSAGE);
/**
 * The CPU limit of a container whose app sets none: every core but one, so one app alone can never
 * take the whole server from the control plane and the other apps, and at least one core. Worker and
 * api call it with the host's core count, which both can read. A number, never "no limit".
 */
export const defaultCpuCores = (hostCores: number): number => Math.min(64, Math.max(1, Math.floor(hostCores) - 1));
export const EnvName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "Use lowercase letters, digits and dashes");
export const EnvKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "Letters, digits and underscores, not starting with a digit");
/**
 * The prefix a stored env value carries when it is a reference to a managed service (env-refs.ts).
 * It starts with a NUL, so no typed or pasted value can ever be read as a reference.
 */
export const ENV_REF_MARK = "\u0000dockify-ref:v1:";
export const EnvValue = z
  .string()
  .max(64 * 1024)
  .refine((v) => !v.startsWith(ENV_REF_MARK), "A value cannot start with the reference marker");
export const VolumeName = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/);
/**
 * Characters no name or label may hold. C0 and C1 controls: Postgres refuses a NUL (a name with
 * one was a 500), and the rest are invisible or break the line. Direction marks, embeddings,
 * overrides and isolates: they make a name read in another order than it is stored. Zero-width
 * spaces and joiners, and the line and paragraph separators: they make two different names look
 * alike. The web checks the same set in apps/web/lib/validation.ts.
 */
export const UNSAFE_TEXT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], [0x7f, 0x9f], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff],
];
export const isSafeText = (v: string): boolean => {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    for (const [lo, hi] of UNSAFE_TEXT_RANGES) if (c >= lo && c <= hi) return false;
  }
  return true;
};
export const UNSAFE_TEXT_MESSAGE = "Remove control characters, direction marks and invisible characters";
/** A name: one line of visible text. Every display name (people, projects, tokens, the instance) uses it. */
export const DisplayName = z.string().trim().min(1).max(100).refine(isSafeText, UNSAFE_TEXT_MESSAGE);
/** A short label shown to people, a public status page included: the DisplayName rule with its own length. */
export const SafeLabel = (max: number, min = 0) => z.string().trim().min(min).max(max).refine(isSafeText, UNSAFE_TEXT_MESSAGE);
/**
 * What people read as an app's name: one line of visible text, 1 to 60 characters, any case. The
 * app's `name` (AppName) stays its identity for containers, volumes, links, preview hosts and the
 * CLI, so this one is free to change. The database holds the same length (apps_display_name_length).
 */
export const APP_DISPLAY_NAME_MAX = 60;
export const AppDisplayName = SafeLabel(APP_DISPLAY_NAME_MAX, 1);
/** The name to show for an app: its display name, else its name. */
export const appLabel = (a: { name: string; displayName?: string | null }): string => a.displayName || a.name;
export const Email = z.email().max(254);
/** Policy: at least 12 characters (the web checks the same in apps/web/lib/password.ts). */
export const NewPassword = z.string().min(12, "Use at least 12 characters").max(256);
export const Password = z.string().min(1).max(256);
export const TotpCode = z.string().regex(/^\d{6}$/, "Enter all 6 digits");

export const Branch = z.string().regex(/^(?!\/|.*\/\/|.*\.\.|.*\/$)[A-Za-z0-9._/-]{1,200}$/, "Not a valid branch name");
/** registry[:port]/path[:tag][@sha256:digest], lowercase, as Docker reads it. */
export const ImageRef = z
  .string()
  .max(512)
  .regex(
    /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::\d{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/,
    "Not a valid image reference",
  );
/** https only: git over ssh or plain http is refused at the edge. */
export const RepoUrl = z.string().max(300).regex(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\/[\w.-]+\/[\w.-]+?(?:\.git)?$/i, "Use an https repository URL");
/** Relative path inside a repository: no leading slash, no "..", no backslash. */
export const RepoPath = z
  .string()
  .max(200)
  .refine((v) => v === "" || (/^[\w.\-/]+$/.test(v) && !v.startsWith("/") && !v.split("/").includes("..")), "Use a relative path inside the repository");
/** One line, no control characters. Empty means the default. */
export const Command = z.string().max(1000).refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "One line, no control characters");
export const Port = z.number().int().min(1).max(65535);
/** How a repository builds. auto: its Dockerfile when it has one, else Railpack. */
export const BuilderKind = z.enum(["auto", "dockerfile", "railpack"]);
export const Hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Not a valid hostname");
export const HttpsUrl = z.url({ protocol: /^https$/ }).max(2048);
export const ConfirmText = z.string().min(1).max(200);

export const Empty = z.strictObject({});
/**
 * Mutations with no body: the web sends "{}". A missing body is accepted too, in both forms the
 * server can see it: Fastify hands over null for a POST with no content.
 */
export const EmptyBody = z.strictObject({}).nullish();

export const ApiError = z.object({
  error: z.string(),
  code: z.string().optional(),
  field: z.string().optional(),
  retryAfter: z.number().optional(),
  reason: z.string().optional(),
  /** New app and import: one entry per refused field, so the web can show each on its field. */
  refusals: z.array(z.object({ field: z.string(), reason: z.string() })).optional(),
  /** 409 ENV_CONFLICT: the current version to rebase on. */
  version: z.number().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

export const Role = z.enum(["admin", "viewer"]);
export type Role = z.infer<typeof Role>;
export const TokenScope = z.enum(["read", "deploy", "admin"]);
export type TokenScope = z.infer<typeof TokenScope>;
/**
 * Explicit powers a token may carry on top of its scope. A grant never widens the scope: env:write
 * needs the admin scope too, and even then a token can only write plain (non-secret) values.
 */
export const TokenGrant = z.enum(["env:write"]);
export type TokenGrant = z.infer<typeof TokenGrant>;

export const AppKind = z.enum(["frontend", "backend", "bot", "postgres", "redis", "s3"]);
export type AppKind = z.infer<typeof AppKind>;
/**
 * What the app is doing, as the daemon reports it (the worker's observe pass writes it). degraded:
 * running but failing its health check. restarting: Docker is restarting it or it is crash looping.
 * exited: its container stopped on its own. missing: it should run and has no container. failed: its
 * first deploy failed, so nothing ever ran. unknown: never deployed, or not observed yet.
 */
export const AppStatus = z.enum(["running", "stopped", "deploying", "degraded", "unknown", "restarting", "exited", "missing", "failed"]);
export type AppStatus = z.infer<typeof AppStatus>;
export const DeploymentStatus = z.enum(["queued", "building", "deploying", "ready", "failed", "cancelling", "cancelled"]);
export type DeploymentStatus = z.infer<typeof DeploymentStatus>;
export const MetricRange = z.enum(["1h", "24h", "7d"]);
export type MetricRange = z.infer<typeof MetricRange>;
export const TlsStatus = z.enum(["active", "pending", "failed"]);
export const StatefulKind = z.enum(["postgres", "redis", "s3"]);

/** Query-string flag: "1" or "0". */
export const QueryFlag = z.enum(["0", "1"]);

// ------------------------------------------------------------- container privilege allowlist
//
// The single allowlist for capabilities and sysctls. The api validates input against it and the
// worker's containerSpec() checks it again, so neither side can drift from the other.

export const CAPABILITY_ALLOWLIST = ["NET_ADMIN", "NET_RAW"] as const;
export const Capability = z.enum(CAPABILITY_ALLOWLIST);
export type Capability = z.infer<typeof Capability>;

const SYSCTL_KEY = /^(?:net\.ipv4\.[a-z0-9_]+(?:\.[a-z0-9_]+)*|net\.ipv6\.conf\.[a-z0-9_]+(?:\.[a-z0-9_]+)*)$/;
export const isAllowedSysctl = (key: string): boolean => key.length <= 128 && SYSCTL_KEY.test(key);
export const Sysctls = z
  .record(z.string(), z.string().max(64).regex(/^[\w.:-]*$/))
  .refine((m) => Object.keys(m).length <= 16 && Object.keys(m).every(isAllowedSysctl), "Only net.ipv4.* and net.ipv6.conf.* sysctls are allowed");

/**
 * What kind of caller acted: a person, an API token, Dockify itself (schedules, webhooks), or a
 * GitHub push author who is not a verified member.
 */
export const ActorKind = z.enum(["user", "token", "system", "github"]);
export type ActorKind = z.infer<typeof ActorKind>;
/**
 * Who started or changed something. For a member, `avatarUrl` is set only when a signed-in session
 * asks: a token caller cannot read the team, so it never sees their pictures. A `github` actor is
 * named by its public `login`, with its GitHub avatar.
 */
export const ActorRef = z.object({ name: z.string(), avatarUrl: z.string().nullable(), kind: ActorKind, login: z.string().optional() });
export type ActorRef = z.infer<typeof ActorRef>;

/** Only GitHub's own avatar host, so a payload or an API answer can never point the dashboard at another server. */
export function githubAvatarUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 300) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname === "avatars.githubusercontent.com" && !u.username && !u.password && !u.port ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Who wrote the commit a deployment shipped, whoever started the deployment. `login` is null when
 * the author has no GitHub account: `name` is then their git name, with no picture. `isActor` says
 * the deployment's `actor` is this same person.
 */
export const GitAuthor = z.object({ name: z.string(), login: z.string().nullable(), avatarUrl: z.string().nullable(), isActor: z.boolean() });
export type GitAuthor = z.infer<typeof GitAuthor>;

/**
 * A deployment that ran on another platform. Dockify mirrors it from there: state, commit, times and
 * links come from the provider, and its build log is read from the provider when it is asked for.
 */
export const ExternalDeployment = z.object({
  provider: z.literal("vercel"),
  /** The provider's id (Vercel's dpl_...); null until Vercel has accepted a deploy Dockify started. */
  id: z.string().nullable(),
  /** The deployment's own https address on the provider; null while the provider has none. */
  url: z.string().nullable(),
  /** The provider's page for this deployment (Vercel's inspector), https only. */
  inspectorUrl: z.string().nullable(),
  /** The provider's environment: production, or preview for every other deployment. */
  target: z.enum(["production", "preview"]).nullable(),
  /** How the provider says it started: git, cli, redeploy, api-trigger-git-deploy, and so on. */
  source: z.string().nullable(),
  /** The provider account that started it. */
  creator: z.string().nullable(),
});
export type ExternalDeployment = z.infer<typeof ExternalDeployment>;

export const RecentDeployment = z.object({
  id: z.string(),
  appId: z.string(),
  status: DeploymentStatus,
  commit: z.string().nullable(),
  branch: z.string().nullable(),
  message: z.string().nullable(),
  trigger: z.string(),
  createdAt: Iso,
  finishedAt: Iso.nullable(),
  /** `displayName` is what people read (absent: show `name`); `name` stays the app's identity. */
  app: z.object({ id: z.string(), name: z.string(), displayName: z.string().nullable().optional(), kind: AppKind.optional() }),
  projectSlug: z.string(),
  environment: z.string(),
  /** The app's git repository URL, for links to the commit and branch; null for an image source. */
  repo: z.string().nullable(),
  /** Who started it; null for a deployment Dockify queued itself. */
  actor: ActorRef.nullable().optional(),
  /** Who wrote its commit; null when nobody is known yet, as on a row from before this was recorded. */
  author: GitAuthor.nullable().optional(),
  /** What a deployment with no commit ran: a managed service's or an image app's reference. Null from Git. */
  image: z.string().nullable().optional(),
  /** Set when the deployment ran on Vercel (started by Dockify or by Vercel itself); null for a build here. */
  external: ExternalDeployment.nullable().optional(),
});
export type RecentDeployment = z.infer<typeof RecentDeployment>;

export const Resource = z.object({
  id: z.string(),
  /** The app's identity: containers, links, preview hosts and the CLI use it. */
  name: z.string(),
  /** What people read as its name; absent or null shows `name`. */
  displayName: z.string().nullable().optional(),
  kind: AppKind,
  status: AppStatus,
  projectId: z.string(),
  projectSlug: z.string(),
  environment: z.string(),
  /** Hosted by Vercel, followed or as a deploy target, so nothing of it runs on this server. Absent otherwise. */
  onVercel: z.literal(true).optional(),
});
export type Resource = z.infer<typeof Resource>;

export const HostSnapshot = z.object({
  name: z.string(),
  region: z.string(),
  uptimeSeconds: z.number(),
  containers: z.number(),
  load1: z.number(),
  cpu: z.object({ usedPct: z.number(), cores: z.number() }),
  memory: z.object({ usedBytes: z.number(), totalBytes: z.number() }),
  disk: z.object({ usedBytes: z.number(), totalBytes: z.number(), reclaimableBytes: z.number() }),
  /** capacityMbps is the link speed the installer was told (DOCKIFY_NET_CAPACITY_MBPS), or null when unknown. */
  network: z.object({ outMbps: z.number(), capacityMbps: z.number().nullable() }),
  history: z.array(z.object({ at: Iso, cpu: z.number(), memory: z.number(), disk: z.number(), network: z.number() })).optional(),
});
export type HostSnapshot = z.infer<typeof HostSnapshot>;

