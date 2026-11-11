import "server-only";
import { isPreviewVercelApp, PREVIEW_VERCEL_PROJECT, previewVercelEnv, previewVercelProject, previewVercelRows } from "@/lib/preview-vercel";
import { connection } from "next/server";
import { cache } from "react";
import { apiRequest, plainError, UNREADABLE, type Method } from "@/lib/api";
import { appEnvPath, envFromState } from "@/lib/pages/app-env";
import { buildPreviewOverview, PREVIEW_REPOS, previewRepo } from "@/lib/preview-fixture";
import { PREVIEW_OWNER_AVATAR } from "@/lib/preview-owner";
import { previewElevated } from "@/lib/preview-step-up";
import { getDomains, type DomainRow } from "@/lib/pages/resources-domains";
import { getBackups, isRange, type BackupConfig, type BackupRun, type BackupSchedule, type MetricRange } from "@/lib/pages/server-backups";
import { STEP_UP_MESSAGE, STEP_UP_REQUIRED, stepUpRefusal } from "@/lib/step-up";
import type { ActorKind, AppKind, OverviewSource, RecentDeployment, Resource } from "@/lib/types";
import { BRANCH_NAME, ENV_NAME } from "@/lib/validation";
import { isReservedProjectSlug } from "@/lib/validation";
import { isPreviewMode } from "@/lib/preview-mode";
import { hex, seeded } from "@/lib/preview-random";

// Server loaders for the project and app pages. The browser never calls the API directly:
// writes go through POST /api/project-detail, which maps a typed action onto a route (toUpstream).

export type TlsStatus = "active" | "pending" | "failed";

export interface ProjectEnvironment {
  name: string;
  /** The branch that deploys to this environment. */
  branch: string;
}

export interface AppUsage {
  cpuPct: number;
  memoryBytes: number;
  memoryLimitBytes: number;
}

export interface AppSummary extends Resource {
  url: string | null;
  usage?: AppUsage;
  lastDeployment?: RecentDeployment;
}

export interface ProjectDomain {
  id: string;
  host: string;
  appId: string;
  appName: string;
  appDisplayName?: string;
  environment: string;
  tls: TlsStatus;
  expiresAt: string | null;
}

export interface ProjectDetail {
  id: string;
  slug: string;
  name: string;
  repo: { url: string; label: string } | null;
  defaultBranch: string;
  autoDeploy: boolean;
  createdAt: string;
  environments: ProjectEnvironment[];
  apps: AppSummary[];
  /** Newest first. */
  deployments: RecentDeployment[];
  domains: ProjectDomain[];
}

export interface EnvVar {
  key: string;
  value: string;
  secret: boolean;
  updatedAt: string;
  /** Set when the variable links a service. Edited on the project's Env tab, where links are staged. */
  ref?: EnvRefView;
}

export interface ProjectEnv {
  environments: Array<{ name: string; vars: EnvVar[] }>;
}

export interface AppSettings {
  /** auto: the Dockerfile when the repository has one, else Railpack. */
  builder?: "auto" | "dockerfile" | "railpack";
  installCommand?: string;
  buildCommand: string;
  startCommand: string;
  dockerfilePath: string;
  port: number | null;
  healthCheckPath: string;
  /** Cores, decimals allowed. Null uses the server default (never "no limit"). */
  cpuLimit: number | null;
  /** MiB. Null uses the server default (never "no limit"). */
  memoryLimitMb: number | null;
}

/** What an app runs, changed from the next deploy: an image app's image, a git app's branch (null follows its environment). */
export interface AppSource {
  image?: string;
  branch?: string | null;
}

export interface AppDetail extends Resource {
  /** This caller can open a web terminal: an admin, on this server, with the instance's switch on. */
  terminal?: boolean;
  url: string | null;
  /** Managed services (postgres, redis, s3) run from an image and have no build step. */
  image: string | null;
  /** How many volumes of its own the app keeps: with one or more it has backups of its files. Absent from older APIs. */
  volumes?: number;
  repo?: string | null;
  /** A git app's own branch; null follows its environment's branch. Absent from older APIs. */
  branch?: string | null;
  replicas: { desired: number; running: number };
  ports: Array<{ container: number; host: number | null; protocol: "tcp" | "udp" }>;
  settings: AppSettings;
  usage?: AppUsage;
  /** Hourly samples, oldest first. Absent until the metrics sampler runs. */
  metrics?: Array<{ at: string; cpuPct: number; memoryBytes: number }>;
  /** Where it is built and served. Absent from an API that does not send it, which means this server. */
  target?: VercelTargetRef;
  /** Newest first. */
  deployments: RecentDeployment[];
}

export interface LogLine {
  at: string;
  stream: "stdout" | "stderr";
  text: string;
}

export interface NewProjectInput {
  name: string;
  /** Left out, the project starts with one environment, production (the API's default). */
  environments?: string[];
}

export interface NewAppInput {
  name: string;
  kind: AppKind;
  environment: string;
}

export interface ProjectPatch {
  name?: string;
  autoDeploy?: boolean;
  environments?: ProjectEnvironment[];
}

export interface PageResult<T> {
  source: OverviewSource;
  data: T | null;
  notFound?: boolean;
  error?: string;
  fetchedAt: string;
}

export interface ProjectPage {
  project: ProjectDetail;
  env: ProjectEnv | null;
  envError?: string;
}

export interface AppPage {
  app: AppDetail;
  env: ProjectEnv | null;
  envError?: string;
  logs: LogLine[] | null;
  logsError?: string;
}

export type Mutation =
  | { type: "app.action"; id: string; op: "deploy" | "restart" | "stop" | "start" }
  | { type: "app.settings"; id: string; settings: AppSettings; source?: AppSource }
  /** The name people read; null goes back to the app's name, which never changes. */
  | { type: "app.rename"; id: string; displayName: string | null }
  | { type: "app.create"; slug: string; app: NewAppInput }
  | { type: "app.delete"; id: string; confirm: string }
  | { type: "env.put"; slug: string; environment: string; vars: Array<Pick<EnvVar, "key" | "value" | "secret">> }
  | { type: "env.delete"; slug: string; environment: string; key: string }
  | { type: "project.create"; project: NewProjectInput }
  | { type: "project.patch"; slug: string; patch: ProjectPatch }
  | { type: "project.delete"; slug: string; confirm: string }
  | AppTabMutation;

export interface MutationResult {
  ok: boolean;
  source: OverviewSource;
  error?: string;
  /** The machine code of a refusal: step_up_required (lib/step-up.ts) or the API's own, such as SLUG_TAKEN. */
  code?: string;
  /** The API's HTTP status for a refusal (0 when it never answered), which the route answers with. */
  status?: number;
  /** Whatever the API answered with, for example { slug } or { deploymentId }. */
  data?: unknown;
}

type Got<T> = { ok: true; data: T } | { ok: false; status: number; error: string; code?: string };

/** One read (lib/api.ts, 10 second timeout). Failures read as a line for the status, never the API's wording. */
async function apiGet<T>(path: string): Promise<Got<T>> {
  const r = await apiRequest<T>(path);
  if (!r.ok) return { ok: false, status: r.status, error: plainError(r), code: r.code };
  // A read always answers a JSON body; an empty one is as unreadable as a broken one.
  return r.data === null || r.data === undefined ? { ok: false, status: 502, error: UNREADABLE, code: "unreadable" } : { ok: true, data: r.data };
}

/** One write (lib/api.ts, 30 second timeout). A refusal keeps the API's status, code and message. */
async function apiWrite<T>(up: Upstream): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string; code?: string; body?: Record<string, unknown> }> {
  const r = await apiRequest<T>(up.path, { method: up.method, body: up.body });
  return r.ok ? { ok: true, data: r.data } : { ok: false, status: r.status, error: r.error, code: r.code, body: r.body };
}

type Upstream = { method: Method; path: string; body: unknown };

const enc = encodeURIComponent;

/** Cached per request, so metadata and the page share one fetch. */
export const getProjectPage = cache(fetchProjectPage);
export const getAppPage = cache(fetchAppPage);

async function fetchProjectPage(slug: string): Promise<PageResult<ProjectPage>> {
  await connection();
  const fetchedAt = new Date().toISOString();

  if (process.env.DOCKIFY_API_URL) {
    // The project page reads env through the secret-free env/state route (project-extras), so the
    // raw env endpoint is not fetched here: its values would ship to the browser in the page data.
    const project = await apiGet<ProjectDetail>(`/api/v1/projects/${enc(slug)}`);
    if (!project.ok) return { source: "api", data: null, notFound: project.status === 404, error: project.error, fetchedAt };
    return { source: "api", data: { project: project.data, env: null }, fetchedAt };
  }

  // Design preview only. Never set in a deployed build: production must always read the API.
  if (isPreviewMode()) {
    const project = previewProject(slug, new Date());
    if (!project) return { source: "preview", data: null, notFound: true, fetchedAt };
    return { source: "preview", data: { project, env: previewEnv(project) }, fetchedAt };
  }

  return { source: "none", data: null, fetchedAt };
}

async function fetchAppPage(id: string): Promise<PageResult<AppPage>> {
  await connection();
  const fetchedAt = new Date().toISOString();

  if (process.env.DOCKIFY_API_URL) {
    const app = await apiGet<AppDetail>(`/api/v1/apps/${enc(id)}`);
    if (!app.ok) return { source: "api", data: null, notFound: app.status === 404, error: app.error, fetchedAt };
    // This result ships to the browser in the page data, so it reads the secret-free env/state route;
    // env/reveal is the only path to a secret value.
    const [env, logs] = await Promise.all([
      apiGet<EnvState>(appEnvPath(app.data.projectSlug)),
      app.data.target?.kind === "vercel" ? Promise.resolve({ ok: true as const, data: { lines: [] as LogLine[] } }) : apiGet<{ lines: LogLine[] }>(`/api/v1/apps/${enc(id)}/logs?tail=200`),
    ]);
    return {
      source: "api",
      data: {
        app: app.data,
        env: env.ok ? envFromState(env.data) : null,
        envError: env.ok ? undefined : env.error,
        logs: logs.ok ? logs.data.lines : null,
        logsError: logs.ok ? undefined : logs.error,
      },
      fetchedAt,
    };
  }

  if (isPreviewMode()) {
    const now = new Date();
    const app = previewApp(id, now);
    if (!app) return { source: "preview", data: null, notFound: true, fetchedAt };
    const project = previewProject(app.projectSlug, now)!;
    // Linked rows read as the API sends them: a chip, no value, so the app page matches the project Env tab.
    const env: ProjectEnv = {
      environments: previewEnv(project).environments.map((e) => ({
        ...e,
        vars: e.vars.map((v) => {
          const ref = previewRef(project, e.name, v.key);
          return ref ? { ...v, value: "", secret: true, ref } : v;
        }),
      })),
    };
    return { source: "preview", data: { app, env, logs: previewLogs(app, now) }, fetchedAt };
  }

  return { source: "none", data: null, fetchedAt };
}

/** The taken slugs feed the popup's inline check. When that read fails, the API's own 409 (SLUG_TAKEN) still refuses a duplicate. */
export async function getNewProjectContext(): Promise<{ source: OverviewSource; taken: string[] }> {
  await connection();
  if (process.env.DOCKIFY_API_URL) {
    const r = await apiGet<Array<{ slug?: unknown }>>("/api/v1/projects");
    const taken = r.ok && Array.isArray(r.data) ? r.data.map((p) => p?.slug).filter((s): s is string => typeof s === "string") : [];
    return { source: "api", taken };
  }
  if (isPreviewMode()) {
    return { source: "preview", taken: [...new Set(buildPreviewOverview(new Date()).resources.map((r) => r.projectSlug))] };
  }
  return { source: "none", taken: [] };
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** The writes the API guards with a step-up (apps/api/src/policy.ts); the preview asks for the same ones. */
const elevated = (m: Mutation) => (m.type === "app.action" ? m.op === "restart" || m.op === "stop" : m.type !== "project.create");

/** Maps one action onto its API route. Ids and slugs are checked so nothing can steer the path. */
function toUpstream(m: Mutation): Upstream | null {
  const ok = (...ids: string[]) => ids.every((v) => typeof v === "string" && ID.test(v));
  switch (m.type) {
    case "app.action":
      if (!ok(m.id) || !["deploy", "restart", "stop", "start"].includes(m.op)) return null;
      return { method: "POST", path: `/api/v1/apps/${m.id}/${m.op}`, body: {} };
    case "app.settings":
      return ok(m.id) ? { method: "PATCH", path: `/api/v1/apps/${m.id}`, body: { settings: m.settings, ...(m.source ? { source: m.source } : {}) } } : null;
    case "app.rename":
      return ok(m.id) && (m.displayName === null || typeof m.displayName === "string") ? { method: "PUT", path: `/api/v1/apps/${m.id}/name`, body: { displayName: m.displayName } } : null;
    case "app.delete":
      return ok(m.id) ? { method: "DELETE", path: `/api/v1/apps/${m.id}`, body: { confirm: m.confirm } } : null;
    case "app.create":
      return ok(m.slug) ? { method: "POST", path: `/api/v1/projects/${m.slug}/apps`, body: m.app } : null;
    case "env.put":
      return ok(m.slug) ? { method: "PUT", path: `/api/v1/projects/${m.slug}/env`, body: { environment: m.environment, vars: m.vars } } : null;
    case "env.delete":
      return ok(m.slug) ? { method: "DELETE", path: `/api/v1/projects/${m.slug}/env`, body: { environment: m.environment, key: m.key } } : null;
    case "project.create":
      // A project names no repository (apps carry their own) and, unless asked, one environment: the
      // api starts it with production on the instance's default branch, editable in the project's settings.
      return { method: "POST", path: "/api/v1/projects", body: { repoUrl: "", name: m.project.name, ...(m.project.environments ? { environments: m.project.environments } : {}) } };
    case "project.patch":
      return ok(m.slug) ? { method: "PATCH", path: `/api/v1/projects/${m.slug}`, body: m.patch } : null;
    case "project.delete":
      return ok(m.slug) ? { method: "DELETE", path: `/api/v1/projects/${m.slug}`, body: { confirm: m.confirm } } : null;
    default:
      return appTabUpstream(m);
  }
}

export async function runMutation(m: Mutation): Promise<MutationResult> {
  const base = process.env.DOCKIFY_API_URL;
  const source: OverviewSource = base ? "api" : isPreviewMode() ? "preview" : "none";
  // "new" is the New project popup's own address, so no project may take it (packages/contracts RESERVED_SLUGS).
  if (m.type === "project.create" && typeof m.project?.name === "string" && isReservedProjectSlug(m.project.name)) {
    return { ok: false, source, error: "That name is reserved", status: 400 };
  }
  const up = toUpstream(m);
  if (!up) return { ok: false, source, error: "That request is not valid", status: 400 };

  if (base) {
    const r = await apiWrite<unknown>(up);
    return r.ok ? { ok: true, source: "api", data: r.data ?? undefined } : { ok: false, source: "api", error: r.error, code: r.code, status: r.status };
  }

  // The design preview accepts every valid write and changes nothing on the server. An elevated
  // write outside the preview's step-up window is refused the way the API refuses it.
  if (isPreviewMode()) {
    if (elevated(m) && !previewElevated()) return { ...stepUpRefusal(), source: "preview", status: 403 };
    // A refused preview query answers like the API would: a failed write with its reason.
    const data = previewAnswer(m);
    if (data && typeof data === "object" && "error" in data) return { ok: false, source: "preview", error: String(data.error), status: 400 };
    return { ok: true, source: "preview", data };
  }

  return { ok: false, source: "none", error: "No data source, set DOCKIFY_API_URL for this dashboard", status: 503 };
}

// Preview fixture, derived from buildPreviewOverview so apps, ids, statuses and deployments match the overview.

const MB = 1024 ** 2;
const GB = 1024 ** 3;

const PREVIEW_META: Record<string, { name: string; ageDays: number; domains: Array<[host: string, app: string, env: string, tls: TlsStatus]> }> = {
  horseai: {
    name: "Horseai",
    ageDays: 212,
    domains: [
      ["horseai.example", "web", "production", "active"],
      ["www.horseai.example", "web", "production", "active"],
      ["api.horseai.example", "api", "production", "active"],
      ["admin.horseai.example", "admin", "production", "active"],
    ],
  },
  inkwell: {
    name: "Inkwell",
    ageDays: 164,
    domains: [
      ["inkwell.example", "web", "production", "active"],
      ["api.inkwell.example", "api", "production", "active"],
      ["admin.inkwell.example", "admin", "production", "active"],
      ["ws.inkwell.example", "api", "production", "pending"],
    ],
  },
  brightlane: {
    name: "Brightlane",
    ageDays: 61,
    domains: [
      ["brightlane.example", "web", "production", "active"],
      ["www.brightlane.example", "web", "production", "active"],
      ["api.brightlane.example", "api", "production", "active"],
      ["scraper.brightlane.example", "scraper", "production", "active"],
      ["beta.brightlane.example", "web", "production", "failed"],
      ["status.brightlane.example", "api", "production", "pending"],
    ],
  },
  fieldnote: {
    name: "Fieldnote",
    ageDays: 38,
    domains: [
      ["fieldnote.example", "web", "production", "active"],
      ["api.fieldnote.example", "api", "production", "active"],
      ["dev-api.fieldnote.example", "api", "development", "active"],
    ],
  },
};

const indexOf = (id: string) => Number(id.replace(/\D/g, "")) || 0;

/** Memory limit and a stable usage figure per app; nothing used when stopped. */
function previewUsage(r: Resource): AppUsage {
  const limit = { frontend: 1, backend: 2, bot: 0.5, postgres: 4, redis: 1, s3: 2 }[r.kind] * GB;
  const rnd = seeded(31 + indexOf(r.id) * 7);
  if (r.status === "stopped") return { cpuPct: 0, memoryBytes: 0, memoryLimitBytes: limit };
  const hot = r.status === "degraded" ? 0.6 : 0;
  return { cpuPct: Math.round(4 + rnd() * 30 + hot * 60), memoryBytes: Math.round(limit * (0.18 + rnd() * 0.4 + hot * 0.3)), memoryLimitBytes: limit };
}

function previewHosts(slug: string) {
  return (PREVIEW_META[slug]?.domains ?? []).map(([host, app, env, tls], i) => ({ host, app, env, tls, i }));
}

function previewUrl(r: Resource) {
  const hit = previewHosts(r.projectSlug).find((d) => d.app === r.name && d.env === r.environment && d.tls === "active");
  return hit ? `https://${hit.host}` : null;
}

function previewProject(slug: string, now: Date): ProjectDetail | null {
  const o = buildPreviewOverview(now);
  const resources = o.resources.filter((r) => r.projectSlug === slug);
  const meta = PREVIEW_META[slug];
  if (!resources.length || !meta) return null;
  const deployments = o.recentDeployments.filter((d) => d.projectSlug === slug);
  const envNames = [...new Set(resources.map((r) => r.environment))];
  const t = now.getTime();

  const apps: AppSummary[] = resources.map((r) => ({
    ...r,
    url: previewUrl(r),
    usage: previewUsage(r),
    lastDeployment: deployments.find((d) => d.appId === r.id),
  }));

  const domains: ProjectDomain[] = previewHosts(slug).map((d) => {
    const app = resources.find((r) => r.name === d.app && r.environment === d.env) ?? resources[0]!;
    return {
      id: `dom_${slug}_${d.i}`,
      host: d.host,
      appId: app.id,
      appName: app.name,
      ...(app.displayName ? { appDisplayName: app.displayName } : {}),
      environment: d.env,
      tls: d.tls,
      expiresAt: d.tls === "active" ? new Date(t + (24 + ((d.i * 17) % 60)) * 86_400_000).toISOString() : null,
    };
  });

  return {
    id: resources[0]!.projectId,
    slug,
    name: meta.name,
    repo: PREVIEW_REPOS[slug] ? { url: PREVIEW_REPOS[slug], label: PREVIEW_REPOS[slug].replace("https://github.com/", "") } : null,
    defaultBranch: "main",
    autoDeploy: true,
    createdAt: new Date(t - meta.ageDays * 86_400_000).toISOString(),
    environments: envNames.map((name) => ({ name, branch: name === "production" ? "main" : "dev" })),
    apps,
    deployments,
    domains,
  };
}

/** A stable random token, so the masked values have a believable length. */
function token(seed: number, n: number) {
  const rnd = seeded(seed);
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: n }, () => abc[Math.floor(rnd() * abc.length)]).join("");
}

function previewEnv(p: ProjectDetail): ProjectEnv {
  const kinds = new Set(p.apps.map((a) => a.kind));
  const seed = p.slug.length * 101;
  return {
    environments: p.environments.map((e, ei) => {
      const host = p.domains.find((d) => d.environment === e.name && d.appName === "api")?.host;
      const at = (days: number) => new Date(Date.parse(p.createdAt) + days * 86_400_000).toISOString();
      const vars: EnvVar[] = [
        { key: "NODE_ENV", value: e.name, secret: false, updatedAt: at(1) },
        { key: "DATABASE_URL", value: `postgres://${p.slug}:${token(seed + ei, 24)}@postgres:5432/${p.slug}`, secret: true, updatedAt: at(1) },
        { key: "SESSION_SECRET", value: token(seed + 7 + ei, 48), secret: true, updatedAt: at(9) },
      ];
      if (kinds.has("redis")) vars.push({ key: "REDIS_URL", value: "redis://redis:6379/0", secret: true, updatedAt: at(3) });
      if (kinds.has("s3")) vars.push({ key: "S3_SECRET_KEY", value: token(seed + 13, 40), secret: true, updatedAt: at(4) });
      if (host) vars.push({ key: "NEXT_PUBLIC_API_URL", value: `https://${host}`, secret: false, updatedAt: at(2) });
      if (kinds.has("bot")) vars.push({ key: "DISCORD_BOT_TOKEN", value: token(seed + 21, 59), secret: true, updatedAt: at(12) });
      vars.push({ key: "LOG_LEVEL", value: e.name === "production" ? "info" : "debug", secret: false, updatedAt: at(5) });
      return { name: e.name, vars };
    }),
  };
}

const SETTINGS: Record<AppKind, Omit<AppSettings, "cpuLimit" | "memoryLimitMb">> = {
  frontend: { buildCommand: "pnpm build", startCommand: "pnpm start", dockerfilePath: "", port: 3000, healthCheckPath: "/" },
  backend: { buildCommand: "pnpm build", startCommand: "node dist/main.js", dockerfilePath: "Dockerfile", port: 3001, healthCheckPath: "/health" },
  bot: { buildCommand: "pnpm build", startCommand: "node dist/bot.js", dockerfilePath: "", port: null, healthCheckPath: "" },
  postgres: { buildCommand: "", startCommand: "", dockerfilePath: "", port: 5432, healthCheckPath: "" },
  redis: { buildCommand: "", startCommand: "", dockerfilePath: "", port: 6379, healthCheckPath: "" },
  s3: { buildCommand: "", startCommand: "", dockerfilePath: "", port: 9000, healthCheckPath: "/minio/health/live" },
};

/** A preview bot runs a published image, so the preview shows an image app's Settings too. */
const IMAGES: Partial<Record<AppKind, string>> = { bot: "ghcr.io/sam/discord-bot:1.4", postgres: "postgres:17-alpine", redis: "redis:7.4-alpine", s3: "minio/minio:latest" };

function previewApp(id: string, now: Date): AppDetail | null {
  const o = buildPreviewOverview(now);
  const r = o.resources.find((x) => x.id === id);
  if (!r) return null;
  const usage = previewUsage(r);
  const up = r.status === "stopped" ? 0 : 1;
  const base = SETTINGS[r.kind];
  const rnd = seeded(53 + indexOf(r.id) * 11);
  const metrics =
    r.status === "stopped"
      ? undefined
      : Array.from({ length: 24 }, (_, i) => {
          const hour = new Date(now.getTime() - (23 - i) * 3_600_000);
          const wave = Math.sin(((hour.getUTCHours() - 8) / 24) * Math.PI * 2);
          const last = i === 23;
          return {
            at: hour.toISOString(),
            cpuPct: last ? usage.cpuPct : Math.max(1, Math.round(usage.cpuPct * (0.7 + wave * 0.25 + rnd() * 0.3))),
            memoryBytes: last ? usage.memoryBytes : Math.round(usage.memoryBytes * (0.9 + wave * 0.05 + rnd() * 0.1)),
          };
        });
  return {
    ...r,
    terminal: !isPreviewVercelApp(r.projectSlug, r.name),
    url: previewUrl(r),
    image: IMAGES[r.kind] ?? null,
    repo: previewRepo(r.projectSlug, r.kind),
    replicas: { desired: 1, running: up },
    ports: base.port ? [{ container: base.port, host: null, protocol: "tcp" }] : [],
    settings: { ...base, cpuLimit: r.kind === "postgres" ? 2 : 1, memoryLimitMb: Math.round(usage.memoryLimitBytes / MB) },
    usage,
    metrics,
    deployments: previewVercelRows(o.recentDeployments.filter((d) => d.appId === r.id)),
    ...(isPreviewVercelApp(r.projectSlug, r.name) ? { target: { kind: "vercel" as const, vercelProjectId: PREVIEW_VERCEL_PROJECT, mode: "follow" as const } } : {}),
  };
}

const LOGS: Record<AppKind, Array<[stream: LogLine["stream"], text: string]>> = {
  frontend: [
    ["stdout", "▲ Next.js 16.4.3"],
    ["stdout", "- Local: http://0.0.0.0:3000"],
    ["stdout", "✓ Ready in 412ms"],
    ["stdout", "GET / 200 in 38ms"],
    ["stdout", "GET /leaderboard 200 in 61ms"],
    ["stdout", "GET /api/session 200 in 12ms"],
    ["stderr", "Warning: revalidate took 1204ms for /partners"],
    ["stdout", "GET /partners 200 in 44ms"],
  ],
  backend: [
    ["stdout", "api listening on :3001"],
    ["stdout", "migrations up to date"],
    ["stdout", "POST /v1/auth/session 200 18ms"],
    ["stdout", "GET /v1/leaderboard 200 9ms"],
    ["stderr", "upstream partner feed slow, 2.1s"],
    ["stdout", "GET /health 200 1ms"],
    ["stdout", "cron: refreshed affiliate stats"],
  ],
  bot: [
    ["stdout", "gateway connected, shard 0"],
    ["stdout", "registered 6 slash commands"],
    ["stdout", "interaction /payout handled in 140ms"],
    ["stderr", "socket closed, reconnecting in 5s"],
    ["stdout", "gateway resumed"],
  ],
  postgres: [
    ["stdout", "database system is ready to accept connections"],
    ["stdout", "checkpoint starting: time"],
    ["stdout", "checkpoint complete: wrote 412 buffers"],
    ["stderr", "could not receive data from client: connection reset by peer"],
  ],
  redis: [
    ["stdout", "Ready to accept connections tcp"],
    ["stdout", "100 changes in 300 seconds. Saving..."],
    ["stdout", "Background saving terminated with success"],
  ],
  s3: [
    ["stdout", "MinIO Object Storage Server"],
    ["stdout", "API: http://0.0.0.0:9000"],
    ["stdout", "Status: 1 Online, 0 Offline"],
  ],
};

function previewLogs(app: AppDetail, now: Date): LogLine[] {
  if (app.status === "stopped") return [];
  const pool = LOGS[app.kind];
  const rnd = seeded(71 + indexOf(app.id) * 3);
  const n = 60;
  return Array.from({ length: n }, (_, i) => {
    /* The first three lines are the boot banner; the rest repeat the pool, or the banner when that is all there is. */
    const tail = pool.length - 3;
    const [stream, text] = i < 3 || tail <= 0 ? pool[i % pool.length]! : pool[3 + Math.floor(rnd() * tail)]!;
    return { at: new Date(now.getTime() - (n - i) * 47_000).toISOString(), stream, text };
  });
}


// Project extras (env, environments, previews, status page), loaded on the client through /api/project-extras.
// A linked variable stores a reference, not the credential; the API resolves it at deploy time.

export type EnvTarget = "build" | "runtime" | "both";

export type StatefulKind = "postgres" | "redis" | "s3";
export type EnvRefField = "url" | "urlNoTls" | "host" | "port" | "user" | "password" | "database" | "endpoint" | "bucket" | "accessKey" | "secretKey";

export interface EnvRef {
  resourceId: string;
  field: EnvRefField;
}

export interface EnvRefView extends EnvRef {
  resourceName: string;
  /** Null when the service was deleted since. */
  kind: StatefulKind | null;
  environment: string;
  missing?: boolean;
}

export interface EnvEntry {
  key: string;
  /** Null for secrets: the API never sends a secret value outside /env/reveal. */
  value: string | null;
  secret: boolean;
  target: EnvTarget;
  updatedAt: string;
  updatedBy: string | null;
  /** Set when the variable links a service; `value` is then null. */
  ref?: EnvRefView;
}

export interface EnvOverride {
  appId: string;
  appName: string;
  environment: string;
  vars: EnvEntry[];
}

export interface EnvState {
  version: number;
  environments: Array<{ name: string; vars: EnvEntry[] }>;
  /** Per-app variables that win over the shared ones. Apps without any are left out. */
  overrides: EnvOverride[];
}

export type EnvOp = "add" | "change" | "remove";

/** A change without `value` keeps the stored value. `ref` links a service instead; the two never travel together. */
export interface EnvChange {
  environment: string;
  appId?: string;
  key: string;
  op: EnvOp;
  value?: string;
  ref?: EnvRef;
  secret?: boolean;
  target?: EnvTarget;
}

export interface EnvVersion {
  version: number;
  at: string;
  actor: string;
  /** The team member's picture, null for tokens, Dockify and anyone without one. */
  actorAvatarUrl: string | null;
  actorKind: ActorKind;
  source: "dashboard" | "api" | "rollback";
  /** Set on a rollback: the version it restored. */
  restoredFrom?: number;
  changes: Array<{ environment: string; appId?: string; appName?: string; key: string; op: EnvOp; secret: boolean; target: EnvTarget }>;
  redeployed: number;
}

export interface PreviewSettings {
  enabled: boolean;
  /** The environment each preview copies. Production is never the default. */
  baseEnvironment: string;
  /** Apps marked "include in previews". */
  appIds: string[];
  /** Overrides the instance preview domain; null uses the instance one. */
  domain: string | null;
  maxConcurrent: number;
  /** Server-wide cap, shared by every project. */
  serverMaxConcurrent: number;
  cpuLimit: number;
  memoryMb: number;
  pidsLimit: number;
  /** 0 never sleeps. */
  idleMinutes: number;
  ttlHours: number;
  fromForks: boolean;
  isolatedDb: boolean;
  /** A same-repo preview of a production base may have production's secrets and network. */
  productionAccess: boolean;
  /** Who can open a preview URL: anyone with the link, or whoever has the project's preview password. */
  access: "public" | "password";
}

export type PreviewStatus = "building" | "ready" | "asleep" | "failed" | "blocked" | "closing" | "closed";

export interface PreviewApp {
  appId: string;
  name: string;
  kind: AppKind;
  url: string | null;
  deployment: { id: string; status: RecentDeployment["status"]; commit: string | null; error: string | null; createdAt: string } | null;
  cpuPct: number | null;
  memoryBytes: number | null;
}

export interface PreviewDeployment {
  pr: number;
  /** pr-<n> */
  name: string;
  title: string;
  branch: string;
  author: string | null;
  status: PreviewStatus;
  reason: string | null;
  error: string | null;
  url: string | null;
  commit: string | null;
  /** The base repository the pull request is on (https://github.com/owner/name); absent from older APIs. */
  repo?: string | null;
  fromFork: boolean;
  isolatedDb: boolean;
  /** "own": kept out of production's secrets and network. Absent from older APIs. */
  isolation?: "base" | "own" | "fork";
  baseEnvironment: string;
  createdAt: string;
  updatedAt: string;
  lastCommitAt: string;
  lastRequestAt: string | null;
  sleptAt: string | null;
  expiresAt: string | null;
  usage: { cpuPct: number | null; memoryBytes: number | null };
  apps: PreviewApp[];
}

export interface PreviewDns {
  domain: string | null;
  source: "project" | "instance" | "derived";
  status: "ok" | "mismatch" | "missing" | "unchecked";
  detail: string | null;
  checkedAt: string | null;
  cloudflare: "none" | "pending" | "managed" | "external" | "failed";
  cloudflareMessage: string | null;
  record: { type: "CNAME" | "A"; name: string; content: string } | null;
  tls: "cloudflare" | "wildcard_dns01" | "per_host_http01";
}

export interface PreviewState {
  settings: PreviewSettings;
  /** When the preview password was made; null while there is none. The password is never readable. */
  passwordSetAt: string | null;
  /** Open previews first, then recent closed ones. */
  previews: PreviewDeployment[];
  server: { running: number; cap: number; diskPct: number | null; diskGuardPct: number };
  dns: PreviewDns;
  ceiling: { previews: number; cpu: number; memoryMb: number };
}

export interface StatusPageState {
  enabled: boolean;
  /** Public path, /status/<slug>. */
  path: string;
  /** Apps with a public domain, which are the ones the page lists. */
  publicApps: number;
}

export interface ProjectExtras {
  env: EnvState | null;
  envError?: string;
  versions: EnvVersion[] | null;
  versionsError?: string;
  previews: PreviewState | null;
  previewsError?: string;
  statusPage: StatusPageState | null;
  statusPageError?: string;
}

export type ExtrasMutation =
  | { type: "env.apply"; slug: string; baseVersion: number; changes: EnvChange[]; redeploy: boolean; confirmDangerous?: boolean }
  | { type: "env.reveal"; slug: string; environment: string; appId?: string; key: string; purpose?: "view" | "copy" }
  | { type: "env.rollback"; slug: string; version: number; baseVersion: number; redeploy: boolean; confirmDangerous?: boolean }
  | { type: "environment.add"; slug: string; name: string; branch: string; copyFrom?: string }
  | { type: "environment.branch"; slug: string; name: string; branch: string }
  | { type: "environment.remove"; slug: string; name: string; confirm: string }
  | { type: "previews.settings"; slug: string; settings: PreviewSettings }
  | { type: "previews.password"; slug: string }
  | { type: "previews.delete"; slug: string; pr: number }
  | { type: "previews.wake"; slug: string; pr: number }
  | { type: "previews.dnsCheck"; slug: string }
  | { type: "statusPage.set"; slug: string; enabled: boolean };

export interface ExtrasMutationResult extends MutationResult {
  /** step_up_required, "conflict" (the env version moved on), "dangerous" (a process hook key needs confirming), or the API's own code. */
  code?: typeof STEP_UP_REQUIRED | "conflict" | "dangerous" | (string & {});
  /** With "dangerous": the keys that need confirming. */
  keys?: string[];
}

export async function getProjectExtras(slug: string): Promise<PageResult<ProjectExtras>> {
  await connection();
  const fetchedAt = new Date().toISOString();

  if (process.env.DOCKIFY_API_URL) {
    if (!ID.test(slug)) return { source: "api", data: null, notFound: true, fetchedAt };
    const s = enc(slug);
    const [env, versions, previews, statusPage] = await Promise.all([
      apiGet<EnvState>(`/api/v1/projects/${s}/env/state`),
      apiGet<{ versions: EnvVersion[] }>(`/api/v1/projects/${s}/env/versions?limit=50`),
      apiGet<PreviewState>(`/api/v1/projects/${s}/previews`),
      apiGet<StatusPageState>(`/api/v1/projects/${s}/status-page`),
    ]);
    return {
      source: "api",
      data: {
        env: env.ok ? env.data : null,
        envError: env.ok ? undefined : env.error,
        versions: versions.ok ? versions.data.versions : null,
        versionsError: versions.ok ? undefined : versions.error,
        previews: previews.ok ? previews.data : null,
        previewsError: previews.ok ? undefined : previews.error,
        statusPage: statusPage.ok ? statusPage.data : null,
        statusPageError: statusPage.ok ? undefined : statusPage.error,
      },
      fetchedAt,
    };
  }

  if (isPreviewMode()) {
    const data = previewExtras(slug, new Date());
    return data ? { source: "preview", data, fetchedAt } : { source: "preview", data: null, notFound: true, fetchedAt };
  }

  return { source: "none", data: null, fetchedAt };
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const TARGETS: readonly string[] = ["build", "runtime", "both"];
const REF_FIELDS: readonly string[] = ["url", "urlNoTls", "host", "port", "user", "password", "database", "endpoint", "bucket", "accessKey", "secretKey"];
const OPS: readonly string[] = ["add", "change", "remove"];
/** One value at most 32 KiB, one apply at most 500 changes. */
const MAX_VALUE = 32 * 1024;
const MAX_CHANGES = 500;

const isInt = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;
const isBool = (b: unknown): b is boolean => typeof b === "boolean";
const isStr = (v: unknown, re: RegExp): v is string => typeof v === "string" && re.test(v);

/** Rebuilds one change from checked fields only, or null when anything is off. */
function cleanChange(c: unknown): EnvChange | null {
  if (!c || typeof c !== "object") return null;
  const x = c as Record<string, unknown>;
  if (!isStr(x.environment, ENV_NAME) || !isStr(x.key, ENV_KEY_RE) || typeof x.op !== "string" || !OPS.includes(x.op)) return null;
  if (x.appId !== undefined && !isStr(x.appId, ID)) return null;
  if (x.value !== undefined && (typeof x.value !== "string" || x.value.length > MAX_VALUE)) return null;
  if (x.secret !== undefined && !isBool(x.secret)) return null;
  if (x.target !== undefined && (typeof x.target !== "string" || !TARGETS.includes(x.target))) return null;
  const ref = x.ref === undefined ? undefined : cleanRef(x.ref);
  if (ref === null || (ref && x.value !== undefined)) return null;
  const op = x.op as EnvOp;
  // An add carries everything (a value or a link); a remove carries nothing else.
  if (op === "add" && ((typeof x.value !== "string" && !ref) || !isBool(x.secret) || x.target === undefined)) return null;
  if (op === "remove") return { environment: x.environment, appId: x.appId, key: x.key, op };
  if (ref) return { environment: x.environment, appId: x.appId, key: x.key, op, ref, target: x.target as EnvTarget | undefined };
  return { environment: x.environment, appId: x.appId, key: x.key, op, value: x.value, secret: x.secret, target: x.target as EnvTarget | undefined };
}

/** A link rebuilt from checked fields: the API decides whether the service is in this project. */
function cleanRef(r: unknown): EnvRef | null {
  if (!r || typeof r !== "object") return null;
  const x = r as Record<string, unknown>;
  return isStr(x.resourceId, ID) && typeof x.field === "string" && REF_FIELDS.includes(x.field) ? { resourceId: x.resourceId, field: x.field as EnvRefField } : null;
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const isNum = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;

function cleanPreviewSettings(s: unknown): PreviewSettings | null {
  if (!s || typeof s !== "object") return null;
  const x = s as Record<string, unknown>;
  const ok =
    isBool(x.enabled) &&
    isStr(x.baseEnvironment, ENV_NAME) &&
    Array.isArray(x.appIds) &&
    x.appIds.length <= 20 &&
    x.appIds.every((id) => isStr(id, ID)) &&
    (x.domain === null || isStr(x.domain, HOST_RE)) &&
    isInt(x.maxConcurrent, 1, 20) &&
    isInt(x.serverMaxConcurrent, 1, 50) &&
    isNum(x.cpuLimit, 0.1, 8) &&
    isInt(x.memoryMb, 64, 16_384) &&
    isInt(x.pidsLimit, 16, 4096) &&
    isInt(x.idleMinutes, 0, 1440) &&
    isInt(x.ttlHours, 1, 720) &&
    isBool(x.fromForks) &&
    isBool(x.isolatedDb) &&
    (x.access === "public" || x.access === "password");
  if (!ok) return null;
  return {
    enabled: x.enabled as boolean,
    baseEnvironment: x.baseEnvironment as string,
    appIds: x.appIds as string[],
    domain: x.domain as string | null,
    maxConcurrent: x.maxConcurrent as number,
    serverMaxConcurrent: x.serverMaxConcurrent as number,
    cpuLimit: x.cpuLimit as number,
    memoryMb: x.memoryMb as number,
    pidsLimit: x.pidsLimit as number,
    idleMinutes: x.idleMinutes as number,
    ttlHours: x.ttlHours as number,
    fromForks: x.fromForks as boolean,
    isolatedDb: x.isolatedDb as boolean,
    productionAccess: x.productionAccess === true,
    access: x.access as PreviewSettings["access"],
  };
}

/** The extras writes the API guards with a step-up (apps/api/src/policy.ts); the preview asks for the same ones. */
const EXTRAS_ELEVATED: ReadonlySet<ExtrasMutation["type"]> = new Set(["env.apply", "env.rollback", "environment.branch", "environment.remove", "previews.settings", "previews.password", "previews.delete"]);

/** Maps one extras action onto its API route. Ids, names and keys are checked so nothing can steer the path. */
function toExtrasUpstream(m: ExtrasMutation): Upstream | null {
  const slugOk = "slug" in m && isStr(m.slug, ID);
  const p = slugOk ? `/api/v1/projects/${enc(m.slug)}` : "";
  switch (m.type) {
    case "env.apply": {
      if (!slugOk || !isInt(m.baseVersion, 0, 1e9) || !isBool(m.redeploy) || !Array.isArray(m.changes)) return null;
      if (!m.changes.length || m.changes.length > MAX_CHANGES) return null;
      const changes = m.changes.map(cleanChange);
      if (changes.some((c) => c === null)) return null;
      if (m.confirmDangerous !== undefined && !isBool(m.confirmDangerous)) return null;
      return { method: "POST", path: `${p}/env/apply`, body: { baseVersion: m.baseVersion, redeploy: m.redeploy, changes, ...(m.confirmDangerous ? { confirmDangerous: true } : {}) } };
    }
    case "env.reveal":
      if (!slugOk || !isStr(m.environment, ENV_NAME) || !isStr(m.key, ENV_KEY_RE)) return null;
      if (m.appId !== undefined && !isStr(m.appId, ID)) return null;
      if (m.purpose !== undefined && m.purpose !== "view" && m.purpose !== "copy") return null;
      return { method: "POST", path: `${p}/env/reveal`, body: { environment: m.environment, appId: m.appId, key: m.key, ...(m.purpose ? { purpose: m.purpose } : {}) } };
    case "env.rollback":
      if (!slugOk || !isInt(m.version, 1, 1e9) || !isInt(m.baseVersion, 0, 1e9) || !isBool(m.redeploy)) return null;
      if (m.confirmDangerous !== undefined && !isBool(m.confirmDangerous)) return null;
      return { method: "POST", path: `${p}/env/rollback`, body: { version: m.version, baseVersion: m.baseVersion, redeploy: m.redeploy, ...(m.confirmDangerous ? { confirmDangerous: true } : {}) } };
    case "environment.add":
      if (!slugOk || !isStr(m.name, ENV_NAME) || m.name === "preview" || !isStr(m.branch, BRANCH_NAME)) return null;
      if (m.copyFrom !== undefined && !isStr(m.copyFrom, ENV_NAME)) return null;
      return { method: "POST", path: `${p}/environments`, body: { name: m.name, branch: m.branch, copyFrom: m.copyFrom } };
    case "environment.branch":
      if (!slugOk || !isStr(m.name, ENV_NAME) || !isStr(m.branch, BRANCH_NAME)) return null;
      return { method: "PATCH", path: `${p}/environments/${enc(m.name)}`, body: { branch: m.branch } };
    case "environment.remove":
      // Production is the one environment that can never go.
      if (!slugOk || !isStr(m.name, ENV_NAME) || m.confirm !== m.name || m.name === "production") return null;
      return { method: "DELETE", path: `${p}/environments/${enc(m.name)}`, body: { confirm: m.confirm } };
    case "previews.settings": {
      const settings = slugOk ? cleanPreviewSettings(m.settings) : null;
      return settings ? { method: "PATCH", path: `${p}/previews/settings`, body: settings } : null;
    }
    case "previews.password":
      return slugOk ? { method: "POST", path: `${p}/previews/password`, body: {} } : null;
    case "previews.delete":
      return slugOk && isInt(m.pr, 1, 1e9) ? { method: "DELETE", path: `${p}/previews/${m.pr}`, body: {} } : null;
    case "previews.wake":
      return slugOk && isInt(m.pr, 1, 1e9) ? { method: "POST", path: `${p}/previews/${m.pr}/wake`, body: {} } : null;
    case "previews.dnsCheck":
      return slugOk ? { method: "POST", path: `${p}/previews/dns/check`, body: {} } : null;
    case "statusPage.set":
      return slugOk && isBool(m.enabled) ? { method: "PATCH", path: `${p}/status-page`, body: { enabled: m.enabled } } : null;
    default:
      return null;
  }
}

export async function runExtrasMutation(m: ExtrasMutation): Promise<ExtrasMutationResult> {
  const base = process.env.DOCKIFY_API_URL;
  const up = toExtrasUpstream(m);
  if (!up) return { ok: false, source: base ? "api" : isPreviewMode() ? "preview" : "none", error: "That request is not valid", status: 400 };

  if (base) {
    const r = await apiWrite<unknown>(up);
    if (r.ok) return { ok: true, source: "api", data: r.data ?? undefined };
    const env = m.type === "env.apply" || m.type === "env.rollback";
    if (r.status === 409 && r.code === "DANGEROUS_KEY_CONFIRM" && env) {
      const keys = Array.isArray(r.body?.keys) ? r.body.keys.filter((k): k is string => typeof k === "string") : [];
      return { ok: false, source: "api", code: "dangerous", keys, error: r.error, status: 409 };
    }
    if (r.status === 409 && env) {
      return { ok: false, source: "api", code: "conflict", error: "Variables changed somewhere else. Reload to see the latest version.", status: 409 };
    }
    return { ok: false, source: "api", error: r.error, code: r.code, status: r.status };
  }

  if (isPreviewMode()) {
    // Outside the preview's step-up window an elevated write is refused, as the API refuses it.
    if (EXTRAS_ELEVATED.has(m.type) && !previewElevated()) return { ...stepUpRefusal(), source: "preview", status: 403 };
    return previewExtrasMutation(m);
  }

  return { ok: false, source: "none", error: "No data source, set DOCKIFY_API_URL for this dashboard", status: 503 };
}

// Preview fixture, built on previewProject and previewEnv. Secret values stay on the server here too.

/** NEXT_PUBLIC_ names are inlined at build time; NODE_ENV matters to both. */
const previewTarget = (key: string): EnvTarget => (key.startsWith("NEXT_PUBLIC_") ? "build" : key === "NODE_ENV" ? "both" : "runtime");

function previewOverrides(p: ProjectDetail): Array<EnvOverride & { values: Record<string, string> }> {
  const out: Array<EnvOverride & { values: Record<string, string> }> = [];
  const at = (days: number) => new Date(Date.parse(p.createdAt) + days * 86_400_000).toISOString();
  for (const a of p.apps) {
    const vars: EnvEntry[] = [];
    const values: Record<string, string> = {};
    const add = (key: string, value: string, secret: boolean, target: EnvTarget, day: number) => {
      vars.push({ key, value: secret ? null : value, secret, target, updatedAt: at(day), updatedBy: "Sam" });
      values[key] = value;
    };
    if (a.kind === "frontend" && a.url) add("NEXT_PUBLIC_SITE_URL", a.url, false, "build", 6);
    if (a.kind === "backend" && a.name === "api") add("LOG_LEVEL", a.environment === "production" ? "warn" : "trace", false, "runtime", 14);
    if (a.name === "worker") add("CONCURRENCY", "4", false, "runtime", 11);
    if (a.name === "scraper") add("FEED_API_KEY", token(p.slug.length * 37, 32), true, "runtime", 8);
    if (a.name === "discord-bot") add("DISCORD_GUILD_ID", "100000000000000001", false, "runtime", 10);
    if (vars.length) out.push({ appId: a.id, appName: a.name, environment: a.environment, vars, values });
  }
  return out;
}

const previewVersion = (slug: string) => 10 + slug.length * 2;

/** DATABASE_URL links the environment's own Postgres where there is one, the way a new project would. */
function previewRef(p: ProjectDetail, env: string, key: string): EnvRefView | undefined {
  const db = key === "DATABASE_URL" ? p.apps.find((a) => a.kind === "postgres" && a.environment === env) : undefined;
  return db ? { resourceId: db.id, resourceName: db.name, kind: "postgres", environment: env, field: "url" } : undefined;
}

function previewEnvState(p: ProjectDetail): EnvState {
  return {
    version: previewVersion(p.slug),
    environments: previewEnv(p).environments.map((e) => ({
      name: e.name,
      vars: e.vars.map((v) => {
        const ref = previewRef(p, e.name, v.key);
        const entry: EnvEntry = { key: v.key, value: v.secret || ref ? null : v.value, secret: v.secret || !!ref, target: previewTarget(v.key), updatedAt: v.updatedAt, updatedBy: "Sam" };
        return ref ? { ...entry, ref } : entry;
      }),
    })),
    overrides: previewOverrides(p).map((o) => ({ appId: o.appId, appName: o.appName, environment: o.environment, vars: o.vars })),
  };
}

function previewVersions(p: ProjectDetail, now: Date): EnvVersion[] {
  const top = previewVersion(p.slug);
  const prod = previewEnv(p).environments.find((e) => e.name === "production");
  if (!prod) return [];
  const pick = (i: number) => prod.vars[i % prod.vars.length]!;
  const overrides = previewOverrides(p);
  const stateless = p.apps.filter((a) => a.environment === prod.name && a.kind !== "postgres" && a.kind !== "redis").length;
  const hours = [3, 27, 76, 150, 260, 410, 620, 900];
  return hours.map((h, i): EnvVersion => {
    const version = top - i;
    const v = pick(i * 2 + 1);
    const w = pick(i * 3 + 2);
    const changes: EnvVersion["changes"] = [{ environment: prod.name, key: v.key, op: i % 3 === 2 ? "add" : "change", secret: v.secret, target: previewTarget(v.key) }];
    if (i % 2 === 0 && w.key !== v.key) changes.push({ environment: prod.name, key: w.key, op: "change", secret: w.secret, target: previewTarget(w.key) });
    const o = overrides[i % Math.max(1, overrides.length)];
    if (o && i % 3 === 1) changes.push({ environment: o.environment, appId: o.appId, appName: o.appName, key: o.vars[0]!.key, op: "add", secret: o.vars[0]!.secret, target: o.vars[0]!.target });
    if (i === 5) changes.push({ environment: prod.name, key: "LEGACY_PARTNER_URL", op: "remove", secret: false, target: "runtime" });
    const rollback = i === 4;
    return {
      version,
      at: new Date(now.getTime() - h * 3_600_000).toISOString(),
      actor: i === 6 ? "Deploy token, ci" : "Sam",
      actorAvatarUrl: i === 6 ? null : PREVIEW_OWNER_AVATAR,
      actorKind: i === 6 ? "token" : "user",
      source: rollback ? "rollback" : i === 6 ? "api" : "dashboard",
      restoredFrom: rollback ? version - 2 : undefined,
      changes,
      redeployed: stateless,
    };
  });
}

function previewPreviews(p: ProjectDetail, now: Date): PreviewState {
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const domain = "preview.example.com";
  const base = p.apps.some((a) => a.environment === "development") ? "development" : "production";
  const apps = p.apps.filter((a) => a.environment === base && (a.kind === "frontend" || a.kind === "backend")).slice(0, 2);
  const rows: Record<string, Array<[pr: number, title: string, branch: string, status: PreviewStatus, min: number]>> = {
    horseai: [
      [148, "Partner page redesign", "feat/partner-page", "building", 6],
      [146, "Leaderboard pagination", "fix/leaderboard-pages", "asleep", 190],
    ],
    brightlane: [[37, "Monthly board freeze window", "fix/board-freeze", "failed", 95]],
    fieldnote: [[22, "Contoso partner card", "feat/contoso-card", "ready", 44]],
  };
  const list = rows[p.slug] ?? [];
  const settings: PreviewSettings = {
    enabled: list.length > 0, baseEnvironment: base, appIds: apps.map((a) => a.id), domain: null, maxConcurrent: 2, serverMaxConcurrent: 4,
    cpuLimit: 0.5, memoryMb: 512, pidsLimit: 128, idleMinutes: 30, ttlHours: 72, fromForks: false, isolatedDb: false, productionAccess: false, access: "password",
  };
  const n = Math.max(apps.length, 1);
  return {
    settings,
    passwordSetAt: list.length > 0 ? ago(5 * 1440) : null,
    previews: list.map(([pr, title, branch, status, min]) => {
      const live = status !== "closed";
      const running = status === "ready" || status === "building" || status === "failed";
      return {
        pr, name: `pr-${pr}`, title, branch, author: "sam", status, reason: null, error: status === "failed" ? "npm ERR! Missing script: build" : null,
        url: live ? `https://pr-${pr}-${apps[0]?.name ?? "web"}.${domain}` : null, commit: token(pr * 13, 40), repo: PREVIEW_REPOS[p.slug] ?? null, fromFork: false, isolatedDb: false, baseEnvironment: base,
        createdAt: ago(min + 60), updatedAt: ago(min), lastCommitAt: ago(min), lastRequestAt: status === "asleep" ? ago(min) : ago(3), sleptAt: status === "asleep" ? ago(min - 30) : null,
        expiresAt: new Date(now.getTime() + (72 * 60 - min) * 60_000).toISOString(),
        usage: { cpuPct: running ? 2.4 * n : null, memoryBytes: running ? 180 * 1024 ** 2 * n : null },
        apps: apps.map((a, k) => ({
          appId: a.id, name: a.name, kind: a.kind, url: `https://pr-${pr}-${a.name}.${domain}`,
          deployment: { id: `dep_${pr}_${k}`, status: status === "asleep" ? "ready" : status === "building" ? "building" : status === "failed" ? "failed" : "ready", commit: token(pr * 13, 40), error: null, createdAt: ago(min) },
          cpuPct: running ? 2.4 : null, memoryBytes: running ? 180 * 1024 ** 2 : null,
        })),
      };
    }),
    server: { running: 3, cap: 4, diskPct: 61, diskGuardPct: 85 },
    dns: { domain, source: "derived", status: "ok", detail: null, checkedAt: ago(12), cloudflare: "managed", cloudflareMessage: `Created *.${domain} on Cloudflare.`, record: { type: "CNAME", name: `*.${domain}`, content: "tunnel.cfargotunnel.com" }, tls: "cloudflare" },
    ceiling: { previews: 2, cpu: 2 * n * 0.5, memoryMb: 2 * n * 512 },
  };
}

function previewExtras(slug: string, now: Date): ProjectExtras | null {
  const p = previewProject(slug, now);
  if (!p) return null;
  return {
    env: previewEnvState(p),
    versions: previewVersions(p, now),
    previews: previewPreviews(p, now),
    statusPage: { enabled: slug === "horseai", path: `/status/${slug}`, publicApps: p.apps.filter((a) => a.url).length },
  };
}

/** Accepts every valid write and answers what the API would, so the page can show the result. */
function previewExtrasMutation(m: ExtrasMutation): ExtrasMutationResult {
  const now = new Date();
  switch (m.type) {
    case "env.reveal": {
      const p = previewProject(m.slug, now);
      if (!p) return { ok: false, source: "preview", error: "Unknown project" };
      const value = m.appId
        ? previewOverrides(p).find((o) => o.appId === m.appId)?.values[m.key]
        : previewEnv(p).environments.find((e) => e.name === m.environment)?.vars.find((v) => v.key === m.key)?.value;
      return value === undefined ? { ok: false, source: "preview", error: "Not set on the server" } : { ok: true, source: "preview", data: { value } };
    }
    case "env.apply":
      return { ok: true, source: "preview", data: { version: m.baseVersion + 1, deploymentIds: [] } };
    case "env.rollback":
      return { ok: true, source: "preview", data: { version: m.baseVersion + 1 } };
    case "previews.password":
      return { ok: true, source: "preview", data: { password: "preview-sample-only-notreal", setAt: now.toISOString() } };
    case "previews.settings":
      return { ok: true, source: "preview", data: { ...m.settings, ...(m.settings.enabled && m.settings.access === "password" ? { password: "preview-sample-only-notreal" } : {}) } };
    default:
      return { ok: true, source: "preview" };
  }
}

// App tabs (Metrics, Domains, Data, Backups, Settings). Each loads on the client when its tab opens,
// through GET /api/project-detail/apps/:id/:tab (getAppTab), so the page itself stays one fetch.

export type AppTabKey = "metrics" | "domains" | "tables" | "rows" | "keys" | "backups" | "config" | "vercel" | "vercelEnv";
export const APP_TAB_KEYS: readonly AppTabKey[] = ["metrics", "domains", "tables", "rows", "keys", "backups", "config", "vercel", "vercelEnv"];

export interface TabResult<T> {
  source: OverviewSource;
  data: T | null;
  error?: string;
  /** step_up_required (lib/step-up.ts) when the read needs a fresh step-up (table rows). */
  code?: string;
  fetchedAt: string;
}

export interface AppMetricPoint {
  at: string;
  cpuPct: number;
  memoryBytes: number;
  netInBps: number;
  netOutBps: number;
  restarts: number;
}

export interface AppLimits {
  /** Cores. Null uses the default. */
  cpuCores: number | null;
  /** MiB. Null uses the default. */
  memoryMb: number | null;
  /** Process cap. Null uses the default. */
  pids: number | null;
}

export interface AppMetrics {
  range: MetricRange;
  points: AppMetricPoint[];
  /** The limits in force, defaults resolved. */
  limits: { cpuCores: number; memoryBytes: number; pids: number };
  /** Null while the container is not running. */
  current: { cpuPct: number; memoryBytes: number; pids: number } | null;
  lastRestartAt: string | null;
}

export interface PgTable {
  schema: string;
  name: string;
  /** Planner estimate. */
  rows: number;
  sizeBytes: number;
}

export interface PgTables {
  database: string;
  tables: PgTable[];
}

export interface PgColumn {
  name: string;
  type: string;
  nullable?: boolean;
  primary?: boolean;
}

export type Cell = string | number | boolean | null;

export interface PgRows {
  table: string;
  columns: PgColumn[];
  rows: Cell[][];
  /** Planner estimate of the whole table. */
  total: number;
}

export type RedisType = "string" | "hash" | "list" | "set" | "zset" | "stream";

export interface RedisKey {
  key: string;
  type: RedisType;
  /** Seconds left; null never expires. */
  ttlSeconds: number | null;
  sizeBytes: number;
}

export interface RedisKeys {
  keys: RedisKey[];
  /** Keys in the database (DBSIZE). */
  total: number;
  /** The scan stopped at `count`; refine the pattern to see the rest. */
  truncated: boolean;
}

export interface QueryResult {
  columns: PgColumn[];
  rows: Cell[][];
  rowCount: number;
  durationMs: number;
  /** More rows matched than the cap returns. */
  truncated: boolean;
}

export interface AppBackups {
  schedule: BackupSchedule | null;
  /** Newest first. */
  runs: BackupRun[];
  config: BackupConfig | null;
}

export interface HealthCheck {
  /** Empty waits for the container to run. */
  path: string;
  expectedStatus: number;
  timeoutSeconds: number;
  gracePeriodSeconds: number;
  intervalSeconds: number;
}

/** Why a deploy has to stop the old container before the new one starts. */
export type ZeroDowntimeBlocker = "volume" | "fixed-port";

/** follow: Dockify only reads the Vercel project. deploy: it sends the app's variables and secrets there and asks Vercel to deploy. */
export interface VercelTargetRef {
  kind: "server" | "vercel";
  vercelProjectId: string | null;
  mode?: "follow" | "deploy";
}

export type VercelSyncState = "synced" | "pending" | "failed";

export interface VercelLink {
  connected: boolean;
  projects: Array<{ id: string; name: string; framework: string | null }>;
  /** Why that list could not be read (a refused token, a rate limit); absent from older APIs. */
  projectsError?: string | null;
  /** Set while the app deploys to a linked Vercel project. */
  sync: {
    state: VercelSyncState;
    at: string | null;
    envVars: number;
    lastDeploy: { url: string; state: "ready" | "building" | "error"; at: string } | null;
    error?: string | null;
  } | null;
}

// Read only: Dockify never writes to Vercel for a followed app, and never asks Vercel to decrypt a variable.
export interface VercelDeploymentView {
  id: string;
  url: string | null;
  inspectorUrl: string | null;
  status: "queued" | "building" | "ready" | "failed" | "cancelled";
  target: "production" | "preview";
  branch: string | null;
  commit: string | null;
  message: string | null;
  commitUrl: string | null;
  author: string | null;
  createdAt: string;
  readyAt: string | null;
  durationMs: number | null;
  /** Custom domains first, then Vercel's own names. */
  aliases: string[];
  /** Dockify's mirrored row of it, for a link to its page. */
  deploymentId: string | null;
}

export interface VercelProjectDomain {
  name: string;
  verified: boolean;
  redirect: string | null;
  redirectStatusCode: number | null;
  gitBranch: string | null;
  createdAt: string | null;
}

export interface VercelProjectView {
  id: string;
  name: string;
  framework: string | null;
  nodeVersion: string | null;
  rootDirectory: string | null;
  buildCommand: string | null;
  installCommand: string | null;
  outputDirectory: string | null;
  repo: { provider: "github" | "gitlab" | "bitbucket"; slug: string; url: string | null; productionBranch: string | null } | null;
  links: { project: string; deployments: string; domains: string; env: string; settings: string };
  production: VercelDeploymentView | null;
  domains: VercelProjectDomain[];
  domainsError: string | null;
  fetchedAt: string;
}

export type VercelTargetName = "production" | "preview" | "development";

export interface VercelEnvVar {
  id: string;
  key: string;
  targets: VercelTargetName[];
  /** plain, encrypted, sensitive or system. */
  type: string;
  gitBranch: string | null;
  comment: string | null;
  updatedAt: string | null;
  /** A plain variable's value, for an admin only; never a decrypted one. */
  value: string | null;
}

export interface VercelEnvList {
  variables: VercelEnvVar[];
  hiddenProductionCount: number;
  /** Whether plain values came with this read (admins only). */
  values: boolean;
  manageUrl: string;
  fetchedAt: string;
}

export interface AppConfig {
  health: HealthCheck;
  limits: AppLimits;
  defaults: { cpuCores: number; memoryMb: number; pids: number };
  release: { command: string };
  zeroDowntime: { possible: boolean; blockers: ZeroDowntimeBlocker[] };
  /** Frontends only: where the app is served from. */
  target: VercelTargetRef | null;
  vercel: VercelLink | null;
}

export interface AppConfigPatch {
  health?: HealthCheck;
  limits?: AppLimits;
  release?: { command: string };
  target?: VercelTargetRef;
  /** Required, as true, by a change that starts sending variables and secrets to Vercel. */
  confirmSendSecrets?: true;
}

export type AppTabMutation =
  | { type: "app.config"; id: string; patch: AppConfigPatch }
  | { type: "app.query"; id: string; sql: string }
  | { type: "app.terminalTicket"; id: string };

const isWhole = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const isNumIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const TABLE = /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_$]{0,62}$/i;

/** A path the health probe may request: starts with /, printable, no spaces, no scheme or host. */
const isProbePath = (v: unknown): v is string => typeof v === "string" && (v === "" || /^\/[\x21-\x7e]{0,255}$/.test(v));

const fields = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function validPatch(p: unknown): p is AppConfigPatch {
  const all = fields(p);
  if (!all) return false;
  const { health, limits, release, target, confirmSendSecrets, ...rest } = all;
  if (Object.keys(rest).length) return false;
  if (confirmSendSecrets !== undefined && confirmSendSecrets !== true) return false;
  if (health !== undefined) {
    const h = fields(health);
    if (!h || !isProbePath(h.path) || !isWhole(h.expectedStatus, 100, 599) || !isWhole(h.timeoutSeconds, 1, 120)) return false;
    if (!isWhole(h.gracePeriodSeconds, 0, 600) || !isWhole(h.intervalSeconds, 2, 300)) return false;
  }
  if (limits !== undefined) {
    const l = fields(limits);
    if (!l || !(l.cpuCores === null || isNumIn(l.cpuCores, 0.1, 64))) return false;
    if (!(l.memoryMb === null || isWhole(l.memoryMb, 64, 262_144)) || !(l.pids === null || isWhole(l.pids, 16, 65_536))) return false;
  }
  if (release !== undefined) {
    const r = fields(release);
    // One line: the API runs it through the image's shell as one argv, never interpolated.
    if (!r || typeof r.command !== "string" || r.command.length > 500 || /[\r\n\0]/.test(r.command)) return false;
  }
  if (target !== undefined) {
    const t = fields(target);
    if (!t || (t.kind !== "server" && t.kind !== "vercel")) return false;
    if (t.kind === "vercel" ? !(typeof t.vercelProjectId === "string" && ID.test(t.vercelProjectId)) : t.vercelProjectId !== null) return false;
    if (t.mode !== undefined && (t.kind !== "vercel" || (t.mode !== "follow" && t.mode !== "deploy"))) return false;
  }
  return true;
}

function appTabUpstream(m: AppTabMutation): Upstream | null {
  const ok = (v: unknown): v is string => typeof v === "string" && ID.test(v);
  switch (m.type) {
    case "app.config":
      return ok(m.id) && validPatch(m.patch) ? { method: "PATCH", path: `/api/v1/apps/${m.id}/config`, body: m.patch } : null;
    case "app.query":
      return ok(m.id) && typeof m.sql === "string" && m.sql.trim().length > 0 && m.sql.length <= 10_000
        ? { method: "POST", path: `/api/v1/apps/${m.id}/data/query`, body: { sql: m.sql } }
        : null;
    case "app.terminalTicket":
      return ok(m.id) ? { method: "POST", path: `/api/v1/apps/${m.id}/terminal/ticket`, body: {} } : null;
    default:
      return null;
  }
}

/** `params` is the browser's query string, checked here so nothing it carries can steer the upstream path. */
export async function getAppTab(id: string, tab: AppTabKey, params: URLSearchParams): Promise<TabResult<unknown> & { status: number }> {
  const fetchedAt = new Date().toISOString();
  const bad = (error: string) => ({ source: "none" as const, data: null, error, fetchedAt, status: 400 });
  if (!ID.test(id)) return bad("Unknown app");

  const rangeParam = params.get("range") ?? "24h";
  const table = params.get("table") ?? "";
  const match = params.get("match") || "*";
  if (tab === "metrics" && !isRange(rangeParam)) return bad("Unknown range");
  if (tab === "rows" && !TABLE.test(table)) return bad("Unknown table");
  if (tab === "keys" && (match.length > 128 || /[\x00-\x1f\x7f]/.test(match))) return bad("That pattern is not valid");
  const range = isRange(rangeParam) ? rangeParam : "24h";

  const path =
    tab === "metrics" ? `/api/v1/apps/${id}/metrics?range=${range}`
    : tab === "rows" ? `/api/v1/apps/${id}/data/rows?table=${enc(table)}&limit=50`
    : tab === "keys" ? `/api/v1/apps/${id}/data/keys?match=${enc(match)}&count=200`
    : tab === "tables" ? `/api/v1/apps/${id}/data/tables`
    : tab === "vercel" ? `/api/v1/apps/${id}/vercel/project`
    : tab === "vercelEnv" ? `/api/v1/apps/${id}/vercel/env`
    : `/api/v1/apps/${id}/${tab}`;

  if (process.env.DOCKIFY_API_URL) {
    if (tab === "backups") {
      const b = await appBackups(id);
      return b.data ? { source: "api", data: b.data, fetchedAt, status: 200 } : { source: "api", data: null, error: b.error, fetchedAt, status: 502 };
    }
    const r = await apiGet<unknown>(path);
    // 401 and 403 pass through, so the browser ends a lapsed session or asks for the step-up rows need.
    return r.ok
      ? { source: "api", data: r.data, fetchedAt, status: 200 }
      : { source: "api", data: null, error: r.error, code: r.code, fetchedAt, status: r.status === 401 || r.status === 403 || r.status === 404 ? r.status : 502 };
  }

  if (isPreviewMode()) {
    const now = new Date();
    const app = previewApp(id, now);
    if (!app) return { source: "preview", data: null, error: "Unknown app", fetchedAt, status: 404 };
    // Table rows are tenant data: outside the preview's step-up window they are refused, as on the API.
    if (tab === "rows" && !previewElevated()) return { source: "preview", data: null, error: STEP_UP_MESSAGE, code: STEP_UP_REQUIRED, fetchedAt, status: 403 };
    const data = await previewTab(app, tab, { range, table, match }, now);
    return data === undefined
      ? { source: "preview", data: null, error: "Not available for this app", fetchedAt, status: 404 }
      : { source: "preview", data, fetchedAt, status: 200 };
  }

  return { source: "none", data: null, fetchedAt, status: 200 };
}

// Preview fixture for the tabs, derived from previewApp and the domains and backups fixtures so every tab agrees.

const PIDS_NOW: Record<AppKind, number> = { frontend: 38, backend: 54, bot: 21, postgres: 41, redis: 6, s3: 18 };
const NET_KBPS: Record<AppKind, number> = { frontend: 220, backend: 140, bot: 12, postgres: 90, redis: 60, s3: 310 };
const DEFAULT_PIDS = 512;
const RANGE_SPEC: Record<MetricRange, { n: number; step: number }> = {
  "1h": { n: 60, step: 60_000 },
  "24h": { n: 24, step: 3_600_000 },
  "7d": { n: 84, step: 7_200_000 },
};

function previewMetrics(app: AppDetail, range: MetricRange, now: Date): AppMetrics {
  const usage = app.usage ?? { cpuPct: 0, memoryBytes: 0, memoryLimitBytes: GB };
  const limits = { cpuCores: app.settings.cpuLimit ?? 1, memoryBytes: usage.memoryLimitBytes, pids: DEFAULT_PIDS };
  if (app.status === "stopped") return { range, points: [], limits, current: null, lastRestartAt: null };
  const { n, step } = RANGE_SPEC[range];
  const end = Math.floor(now.getTime() / step) * step;
  const rnd = seeded(97 + indexOf(app.id) * 5 + n);
  const net = NET_KBPS[app.kind] * 1024;
  // The degraded database has been restarting for the last few hours; one bot restarted days ago.
  const restartsAt = (t: number) => {
    const ageH = (now.getTime() - t) / 3_600_000;
    if (app.status === "degraded") return ageH < 6 ? (range === "1h" ? (rnd() > 0.85 ? 1 : 0) : 2) : 0;
    if (app.kind === "bot" && app.projectSlug === "inkwell") return ageH > 70 && ageH <= 72 ? 1 : 0;
    return 0;
  };
  const points = Array.from({ length: n }, (_, i): AppMetricPoint => {
    const t = end - (n - 1 - i) * step;
    const last = i === n - 1;
    const wave = Math.sin(((new Date(t).getUTCHours() - 8) / 24) * Math.PI * 2);
    const k = 0.7 + wave * 0.25 + rnd() * 0.3;
    return {
      at: new Date(t).toISOString(),
      cpuPct: last ? usage.cpuPct : Math.max(1, Math.round(usage.cpuPct * k * 10) / 10),
      memoryBytes: last ? usage.memoryBytes : Math.round(usage.memoryBytes * (0.9 + wave * 0.05 + rnd() * 0.1)),
      netInBps: Math.round(net * k * 0.6),
      netOutBps: Math.round(net * k),
      restarts: restartsAt(t),
    };
  });
  const lastRestart = [...points].reverse().find((p) => p.restarts > 0);
  return {
    range,
    points,
    limits,
    current: { cpuPct: usage.cpuPct, memoryBytes: usage.memoryBytes, pids: PIDS_NOW[app.kind] + (app.status === "degraded" ? 60 : 0) },
    lastRestartAt: lastRestart?.at ?? null,
  };
}

/* Postgres: a believable schema per tenant. Column types are Postgres names, as the API sends them. */
type ColDef = [name: string, type: string, gen: (i: number, r: () => number) => Cell];

const uuid = (_: number, r: () => number) => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-a${hex(r, 3)}-${hex(r, 12)}`;
const ts = (i: number) => new Date(Date.UTC(2026, 9, 29, 12) - i * 3_917_000).toISOString();
const pick = <T,>(xs: readonly T[], r: () => number) => xs[Math.floor(r() * xs.length)]!;
const player = (i: number) => `player_${(4100 + i * 37).toString().padStart(4, "0")}`;

const COMMON: Record<"users" | "sessions" | "audit_log" | "_migrations", ColDef[]> = {
  users: [
    ["id", "uuid", uuid],
    ["username", "text", player],
    ["discord_id", "text", (i, r) => (r() > 0.2 ? `9${String(100_000_000_000_000 + i * 7_919_113)}` : null)],
    ["points", "integer", (_, r) => Math.round(r() * 48_000)],
    ["banned", "boolean", (_, r) => r() > 0.94],
    ["created_at", "timestamptz", ts],
  ],
  sessions: [
    ["id", "text", (i, r) => `ses_${Math.floor(r() * 36 ** 6).toString(36)}${i}`],
    ["user_id", "uuid", uuid],
    ["ip", "inet", (i) => `198.51.100.${(i * 13) % 250}`],
    ["expires_at", "timestamptz", (i) => new Date(Date.UTC(2026, 10, 12) - i * 5_000_000).toISOString()],
  ],
  audit_log: [
    ["id", "bigint", (i) => 90_412 - i],
    ["actor", "text", (_, r) => pick(["admin", "system", "worker"], r)],
    ["action", "text", (_, r) => pick(["points.adjust", "user.ban", "partner.update", "payout.approve"], r)],
    ["payload", "jsonb", (i) => `{"ref":${i}}`],
    ["at", "timestamptz", ts],
  ],
  _migrations: [
    ["id", "integer", (i) => 42 - i],
    ["name", "text", (i) => `${20261028 - i * 3}_${["add_index", "partner_columns", "payout_state", "timestamptz"][i % 4]}`],
    ["applied_at", "timestamptz", (i) => ts(i * 40)],
  ],
};

const TENANT_TABLES: Record<string, Record<string, ColDef[]>> = {
  horseai: {
    partners: [
      ["id", "integer", (i) => i + 1],
      ["name", "text", (i) => ["Northwind", "Tailspin", "Adatum", "Fabrikam", "Litware"][i % 5]!],
      ["affiliate_code", "text", (i) => `HORSEAI${i + 1}`],
      ["active", "boolean", (i) => i % 5 !== 4],
    ],
    payouts: [
      ["id", "bigint", (i) => 7_310 - i],
      ["user_id", "uuid", uuid],
      ["amount_cents", "integer", (_, r) => Math.round(r() * 25_000)],
      ["state", "text", (_, r) => pick(["paid", "paid", "pending", "rejected"], r)],
      ["created_at", "timestamptz", ts],
    ],
    leaderboard_entries: [
      ["id", "bigint", (i) => 51_200 - i],
      ["partner_id", "integer", (i) => (i % 5) + 1],
      ["username", "text", player],
      ["spent_cents", "bigint", (_, r) => Math.round(r() * 9_000_000)],
      ["month", "date", () => "2026-10-01"],
    ],
  },
  inkwell: {
    raffles: [
      ["id", "bigint", (i) => 182_004 - i],
      ["user_id", "uuid", uuid],
      ["stake", "integer", (_, r) => Math.round(r() * 2_000)],
      ["outcome", "text", (_, r) => pick(["won", "lost"], r)],
      ["settled_at", "timestamptz", ts],
    ],
    points_ledger: [
      ["id", "bigint", (i) => 640_118 - i],
      ["user_id", "uuid", uuid],
      ["delta", "integer", (_, r) => Math.round((r() - 0.4) * 800)],
      ["reason", "text", (_, r) => pick(["raffle", "daily", "referral", "admin"], r)],
      ["at", "timestamptz", ts],
    ],
  },
  brightlane: {
    boards: [
      ["id", "integer", (i) => i + 1],
      ["partner", "text", (i) => ["Northwind", "Tailspin", "Adatum"][i % 3]!],
      ["opens_at", "timestamptz", (i) => new Date(Date.UTC(2026, 9 - i, 1)).toISOString()],
      ["frozen", "boolean", (i) => i > 0],
    ],
    board_snapshots: [
      ["id", "bigint", (i) => 30_118 - i],
      ["board_id", "integer", (i) => (i % 3) + 1],
      ["rows", "integer", (_, r) => 40 + Math.round(r() * 60)],
      ["taken_at", "timestamptz", ts],
    ],
  },
  fieldnote: {
    challenges: [
      ["id", "integer", (i) => i + 1],
      ["title", "text", (i) => `Spend ${((i + 1) * 500).toLocaleString("en-US")} on Fabrikam`],
      ["reward_cents", "integer", (i) => (i + 1) * 1_000],
      ["ends_at", "timestamptz", (i) => new Date(Date.UTC(2026, 10, 1) + i * 86_400_000).toISOString()],
    ],
    partners: [
      ["id", "integer", (i) => i + 1],
      ["name", "text", (i) => ["Fabrikam", "Contoso", "Tailspin"][i % 3]!],
      ["affiliate_id", "text", (i) => ["c1f0a77e", "a41c09de", "5bb3e710"][i % 3]!],
      ["active", "boolean", () => true],
    ],
  },
};

/* Reference tables (partners, boards, challenges) stay small; event tables run large. */
const SMALL = new Set(["partners", "boards", "challenges"]);

function tablesOf(slug: string) {
  const all: Record<string, ColDef[]> = { users: COMMON.users, sessions: COMMON.sessions, ...(TENANT_TABLES[slug] ?? {}), audit_log: COMMON.audit_log, _migrations: COMMON._migrations };
  return Object.entries(all).map(([name, cols]) => {
    const h = [...`${slug}.${name}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const rows = name === "_migrations" ? 42 : SMALL.has(name) ? 3 + (h % 6) : 1_200 + (h % 180_000);
    return { name, cols, rows };
  });
}

function previewTables(app: AppDetail): PgTables {
  return {
    database: app.projectSlug,
    tables: tablesOf(app.projectSlug).map((t) => ({ schema: "public", name: t.name, rows: t.rows, sizeBytes: Math.max(16_384, t.rows * (60 + t.cols.length * 24)) })),
  };
}

function previewRows(app: AppDetail, table: string, limit = 50): PgRows | undefined {
  const name = table.split(".")[1];
  const t = tablesOf(app.projectSlug).find((x) => x.name === name);
  if (!t) return undefined;
  const r = seeded(indexOf(app.id) * 17 + t.name.length * 131);
  return {
    table,
    columns: t.cols.map(([n, type], i) => ({ name: n, type, nullable: n === "discord_id", primary: i === 0 })),
    rows: Array.from({ length: Math.min(limit, t.rows) }, (_, i) => t.cols.map(([, , gen]) => gen(i, r))),
    total: t.rows,
  };
}

/** Preview of the read-only query box: reads answer from the fixture tables, writes are refused. */
function previewQuery(app: AppDetail, sql: string): QueryResult | { error: string } {
  const text = sql.trim().replace(/;\s*$/, "");
  const verb = (text.split(/\s+/)[0] ?? "").toLowerCase();
  if (!["select", "with", "explain", "show", "table", "values"].includes(verb)) {
    return { error: `This box runs read-only queries, so ${verb.toUpperCase()} is refused` };
  }
  const from = /\bfrom\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/i.exec(text)?.[1]?.toLowerCase();
  const t = from ? tablesOf(app.projectSlug).find((x) => x.name === from) : undefined;
  if (from && !t) return { error: `relation "${from}" does not exist` };
  if (t && /\bcount\s*\(\s*\*\s*\)/i.test(text)) return { columns: [{ name: "count", type: "bigint" }], rows: [[t.rows]], rowCount: 1, durationMs: 3, truncated: false };
  if (t) {
    const lim = Number(/\blimit\s+(\d+)/i.exec(text)?.[1] ?? 100);
    const got = previewRows(app, `public.${t.name}`, Math.min(lim, 100))!;
    return {
      columns: got.columns.map(({ name, type }) => ({ name, type })),
      rows: got.rows,
      rowCount: got.rows.length,
      durationMs: 4 + got.rows.length,
      truncated: lim > 100 && t.rows > 100,
    };
  }
  return { columns: [{ name: "?column?", type: "integer" }], rows: [[1]], rowCount: 1, durationMs: 1, truncated: false };
}

/* Redis: the key shapes these tenants actually use. */
function previewKeys(app: AppDetail, match: string): RedisKeys {
  const r = seeded(211 + indexOf(app.id));
  const p = app.projectSlug;
  const partners = ["northwind", "tailspin", "adatum", "fabrikam", "contoso", "litware"];
  const keys: RedisKey[] = [
    { key: `${p}:leaderboard:2026-10`, type: "zset", ttlSeconds: null, sizeBytes: 48_210 },
    { key: `${p}:leaderboard:2026-09`, type: "zset", ttlSeconds: 1_209_600, sizeBytes: 47_002 },
    { key: `${p}:queue:payouts`, type: "list", ttlSeconds: null, sizeBytes: 2_140 },
    { key: `${p}:events`, type: "stream", ttlSeconds: null, sizeBytes: 91_330 },
    { key: `${p}:partners:active`, type: "set", ttlSeconds: null, sizeBytes: 312 },
    ...partners.map((name): RedisKey => ({ key: `${p}:cache:partner:${name}`, type: "hash", ttlSeconds: 5 + Math.round(r() * 25), sizeBytes: 1_200 + Math.round(r() * 4_000) })),
    ...Array.from({ length: 18 }, (_, i): RedisKey => ({ key: `sess:${Math.floor(r() * 36 ** 8).toString(36)}${i}`, type: "string", ttlSeconds: 600 + Math.round(r() * 86_000), sizeBytes: 180 + Math.round(r() * 120) })),
    ...Array.from({ length: 9 }, (_, i): RedisKey => ({ key: `rate:ip:198.51.100.${(i * 29) % 250}`, type: "string", ttlSeconds: 1 + Math.round(r() * 59), sizeBytes: 8 })),
    { key: "bull:deploy-hooks:meta", type: "hash", ttlSeconds: null, sizeBytes: 640 },
  ];
  // Redis glob: * and ? are wildcards, everything else is literal.
  const re = new RegExp(`^${match.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return { keys: keys.filter((k) => re.test(k.key)), total: 4_812, truncated: false };
}

/** This database's backups, from the same source as the Backups page so both always agree. */
async function appBackups(appId: string): Promise<{ data: AppBackups | null; error?: string }> {
  const all = await getBackups();
  if (!all.data) return { data: null, error: all.error };
  return {
    data: {
      schedule: all.data.schedules.find((x) => x.resourceId === appId) ?? null,
      runs: all.data.runs.filter((r) => r.resourceId === appId),
      config: all.data.config,
    },
  };
}

const DEFAULT_MEMORY_MB: Record<AppKind, number> = { frontend: 1024, backend: 2048, bot: 512, postgres: 4096, redis: 1024, s3: 2048 };

function previewConfig(app: AppDetail): AppConfig {
  const s = app.settings;
  const stateful = app.kind === "postgres" || app.kind === "redis" || app.kind === "s3";
  const fixedPort = app.replicas.desired === 1 && app.ports.some((p) => p.host !== null);
  const blockers: ZeroDowntimeBlocker[] = [];
  if (stateful) blockers.push("volume");
  if (fixedPort) blockers.push("fixed-port");
  return {
    health: {
      path: s.healthCheckPath,
      expectedStatus: 200,
      timeoutSeconds: 5,
      gracePeriodSeconds: app.kind === "backend" ? 30 : 15,
      intervalSeconds: 10,
    },
    limits: { cpuCores: s.cpuLimit, memoryMb: s.memoryLimitMb, pids: null },
    defaults: { cpuCores: app.kind === "postgres" ? 2 : 1, memoryMb: DEFAULT_MEMORY_MB[app.kind], pids: DEFAULT_PIDS },
    release: { command: app.kind === "backend" ? "pnpm db:migrate" : "" },
    zeroDowntime: { possible: blockers.length === 0, blockers },
    target: app.kind === "frontend" ? (app.target ?? { kind: "server", vercelProjectId: null }) : null,
    vercel: app.kind === "frontend"
      ? {
          connected: true,
          projects: [{ id: PREVIEW_VERCEL_PROJECT, name: "inkwell-web", framework: "Next.js" }],
          sync: app.target?.mode === "deploy" ? { state: "synced", at: new Date(Date.now() - 3_600_000).toISOString(), envVars: 6, lastDeploy: null, error: null } : null,
        }
      : null,
  };
}

async function previewTab(app: AppDetail, tab: AppTabKey, p: { range: MetricRange; table: string; match: string }, now: Date): Promise<unknown> {
  const pg = app.kind === "postgres";
  switch (tab) {
    case "metrics":
      return previewMetrics(app, p.range, now);
    case "domains": {
      const all = (await getDomains()).data;
      return all ? { items: all.items.filter((d: DomainRow) => d.appId === app.id), server: all.server } : undefined;
    }
    case "tables":
      return pg ? previewTables(app) : undefined;
    case "rows":
      return pg ? previewRows(app, p.table) : undefined;
    case "keys":
      return app.kind === "redis" ? previewKeys(app, p.match) : undefined;
    case "backups":
      return pg ? (await appBackups(app.id)).data ?? undefined : undefined;
    case "config":
      return previewConfig(app);
    case "vercel":
      return app.target?.kind === "vercel" ? previewVercelProject(app.deployments) : undefined;
    case "vercelEnv":
      // The preview is an admin's view: plain values show, as the API sends them to an admin.
      return app.target?.kind === "vercel" ? previewVercelEnv() : undefined;
  }
}

function previewAnswer(m: Mutation): unknown {
  switch (m.type) {
    case "app.query": {
      const app = previewApp(m.id, new Date());
      return app ? previewQuery(app, m.sql) : undefined;
    }
    case "app.terminalTicket":
      // No shell in the design preview: the socket finds no server and the tab says so.
      return { ticket: "preview-preview-preview-preview-preview-pre", expiresAt: new Date(Date.now() + 30_000).toISOString() };
    default:
      return undefined;
  }
}

export interface ServiceVersionView {
  kind: "postgres" | "redis";
  version: string | null;
  image: string;
  pin: string | null;
  options: Array<{ version: string; path: "in_place" | "new_service" }>;
  linkedApps: Array<{ id: string; name: string; displayName?: string | null }>;
  upgrade: {
    phase: "backing_up" | "upgrading" | "copying" | "ready" | "switching" | "switched" | "done" | "failed";
    toVersion: string;
    fromVersion: string;
    at: string;
    target: { id: string; name: string; displayName?: string | null } | null;
    sourceCounts: { tables: number; rows: number } | null;
    targetCounts: { tables: number; rows: number } | null;
    copiedAt: string | null;
    error: string | null;
  } | null;
  redirect: { id: string; name: string; displayName?: string | null } | null;
  busy: boolean;
}

/** The preview answers from memory, one service at a time, so each state of the card can be seen. */
const previewServiceStates = new Map<string, "idle" | "ready" | "switched">();

export function previewServiceVersion(id: string, action?: "change" | "switch" | "back"): ServiceVersionView {
  if (!isPreviewMode()) throw new Error("preview only");
  if (action) previewServiceStates.set(id, action === "switch" ? "switched" : "ready");
  const state = previewServiceStates.get(id) ?? "idle";
  const target = { id: "preview-db-pg17", name: "db-pg17" };
  const counts = { tables: 18, rows: 40_216 };
  return {
    kind: "postgres",
    version: "16",
    image: "postgres:16-alpine",
    pin: "sha256:4f1a9c0d7e2b",
    options: [{ version: "16", path: "in_place" }, { version: "17", path: "new_service" }],
    linkedApps: [{ id: "preview-api", name: "api" }, { id: "preview-worker", name: "worker" }],
    upgrade: state === "idle" ? null : { phase: state, fromVersion: "16", toVersion: "17", at: new Date().toISOString(), target, sourceCounts: counts, targetCounts: counts, copiedAt: new Date().toISOString(), error: null },
    redirect: state === "switched" ? target : null,
    busy: false,
  };
}
