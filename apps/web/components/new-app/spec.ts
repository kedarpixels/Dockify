import type { AppKind, OverviewSource } from "@/lib/types";
import { BRANCH_MESSAGE, BRANCH_NAME, ENV_NAME, PROJECT_SLUG, hasReservedPrefix, isRecord, RESERVED_NAME_MESSAGE } from "@/lib/validation";
import { SERVICE_VERSIONS } from "./service-versions";

/*
 * The "Host any application" request: what the browser sends, and the strict checks both the
 * dialog and the proxy route run on it. Pure, so the client and the server share one copy. The
 * API contract lives in lib/pages/new-app.ts; the project slug rule is lib/validation's.
 */

// -------------- Types --------------

export type SourceType = "git" | "image" | "service" | "compose" | "template";
/** The managed services New app offers. Storage is not one: MinIO no longer publishes an image. */
export type ServiceKind = "postgres" | "redis";
export type Builder = "auto" | "dockerfile" | "railpack";
/** Where a frontend runs: this server (default), or a linked Vercel project. */
export type DeployTarget = "server" | "vercel";
/** The kinds an app built from a repository or an image can be. Services have their own. */
export type RunKind = Extract<AppKind, "frontend" | "backend" | "bot">;

export interface BuildSettings {
  builder: Builder;
  /** What the API detected, such as "Next.js". Informational. */
  framework: string | null;
  /** The folder inside the repository the app builds from, "" for the root. */
  rootDir: string;
  /** Empty lets Railpack decide. */
  installCommand?: string;
  buildCommand: string;
  startCommand: string;
  /** Relative to rootDir. Used when builder is "dockerfile". */
  dockerfilePath: string;
  port: number | null;
}

export type AppSource =
  | { type: "git"; repoUrl: string; branch: string; git?: { installationId: string; repoId: string } }
  | { type: "image"; image: string; registryId: string | null }
  | { type: "service"; service: ServiceKind; version: string };

export interface EnvPair {
  key: string;
  value: string;
}

export interface VolumeMount {
  name: string;
  path: string;
}

export interface AppSpec {
  name: string;
  kind: AppKind;
  source: AppSource;
  /** Repository apps only. */
  build?: BuildSettings;
  /** Image apps only: an optional command override and the port the container listens on. */
  run?: { startCommand: string; port: number | null };
  env?: EnvPair[];
  volumes?: VolumeMount[];
  target: DeployTarget;
}

/**
 * The apps a new Postgres or Redis is linked to as it is created: each gets DATABASE_URL or
 * REDIS_URL as a reference the API resolves at deploy time. `replace` names the apps whose variable
 * of that name the operator agreed to replace.
 */
export interface ServiceLink {
  apps: string[];
  replace?: string[];
}

/** One create: a single app, or every service a Compose file mapped to, all or nothing. */
export interface CreateAppsInput {
  project: string;
  environment: string;
  apps: AppSpec[];
  /** Only with one Postgres or Redis. */
  link?: ServiceLink;
}

export interface CreateAppsResult {
  ids: string[];
}

/**
 * The API's LINK_CONFLICT answer: picked apps that already have the variable, as their own
 * (`shared: false`) or from their environment's shared variables. Nothing was created.
 */
export interface LinkConflict {
  key: string;
  apps: Array<{ id: string; name: string; shared: boolean }>;
}

export interface DetectInput {
  repoUrl: string;
  branch: string;
  rootDir: string;
  git?: { installationId: string; repoId: string };
}

export interface DetectResult extends BuildSettings {
  /** Still reading: ask again with the same input. */
  pending: boolean;
  /** False when nothing was recognised and the fields are blank defaults. */
  detected: boolean;
  hasDockerfile: boolean;
  /** Railpack serves it as static files. */
  staticSite: boolean;
  /** Why nothing was recognised, in a sentence. */
  reason: string | null;
  installCommand: string;
}

export interface RegistryOption {
  id: string;
  host: string;
  username: string;
  error: string | null;
}

export interface NewAppContext {
  registries: RegistryOption[];
  /** The connected Vercel account, or null when Vercel is not connected. */
  vercel: { account: string; team: string | null } | null;
}

/** What every route under app/api/new-app answers. */
export interface NewAppAnswer<T> {
  source: OverviewSource;
  data: T | null;
  error?: string;
  /** With the LINK_CONFLICT code: the apps that already have the variable. */
  conflict?: LinkConflict;
}

// -------------- Constants --------------

/** Newest first, exactly the versions the API accepts; kept in step by an API test (service-versions.ts). */
export { SERVICE_VERSIONS };

export const SERVICE_KIND: Record<ServiceKind, AppKind> = { postgres: "postgres", redis: "redis" };

export const SERVICE_LABEL: Record<ServiceKind, string> = { postgres: "Postgres", redis: "Redis" };

/** The variable a link gives each app, named as the API names it (packages/contracts REF_FIELDS, the url field). */
export const LINK_KEY: Record<ServiceKind, string> = { postgres: "DATABASE_URL", redis: "REDIS_URL" };

/** The kinds a new service can be linked to: the apps that run code. */
export const LINKABLE_KINDS: ReadonlySet<AppKind> = new Set<AppKind>(["frontend", "backend", "bot"]);

/** The API's code for a link that would replace a variable the operator has not agreed to replace. */
export const LINK_CONFLICT = "LINK_CONFLICT";

const MAX_LINKS = 50;

/** "a", "a and b", "a, b and c". */
export const listNames = (names: string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** The API's own line for a conflict, for the preview, which answers as the API would. */
export const conflictMessage = (c: LinkConflict) => `${listNames(c.apps.map((a) => a.name))} already ${c.apps.length === 1 ? "has" : "have"} ${c.key}. Confirm to replace it.`;

/** Frameworks that serve a site, so their app starts as a frontend. */
export const FRONTEND_FRAMEWORKS = new Set(["Next.js", "Vite", "Astro", "Remix", "Nuxt", "SvelteKit", "Static"]);

export const MAX_APPS = 20;

// -------------- Validation --------------

/** An app name: lowercase letters, digits and inner hyphens, 1 to 32 characters. */
export const APP_NAME = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const VOLUME_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const ID = /^[\w-]{1,64}$/;
/** A branch name as git and the contracts take it: no leading, trailing or doubled slash, no "..", 200 characters at most. */
/** registry[:port]/path[:tag][@sha256:digest], lowercase, as Docker reads it. */
export const IMAGE_REF =
  /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::\d{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
/** The API's RepoUrl rule, https only: a test in packages/contracts holds the two to the same text. */
export const REPO_URL = /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\/[\w.-]+\/[\w.-]+?(?:\.git)?$/i;

/** A path inside the repository: relative, no "..", no leading slash, no backslashes. */
export const isRepoPath = (v: string, { allowEmpty }: { allowEmpty: boolean }) =>
  v === "" ? allowEmpty : v.length <= 200 && /^[\w.\-/]+$/.test(v) && !v.startsWith("/") && !v.split("/").includes("..");

/** One line, no control characters, 1000 characters at most. Empty means the default. */
export const isCommand = (v: string) => v.length <= 1000 && !/[\u0000-\u001f\u007f]/.test(v);

const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;

/** A port typed into a field: blank is null, anything else must be a valid port. */
export function readPort(raw: string): { ok: true; port: number | null } | { ok: false } {
  const v = raw.trim();
  if (!v) return { ok: true, port: null };
  const n = Number(v);
  return /^\d+$/.test(v) && isPort(n) ? { ok: true, port: n } : { ok: false };
}

const isStr = (v: unknown, max = 200): v is string => typeof v === "string" && v.length <= max;

function readGitRef(v: unknown): { installationId: string; repoId: string } | undefined | null {
  if (v === undefined) return undefined;
  if (!isRecord(v) || !isStr(v.installationId) || !isStr(v.repoId) || !ID.test(v.installationId) || !ID.test(v.repoId)) return null;
  return { installationId: v.installationId, repoId: v.repoId };
}

function readSource(v: unknown): AppSource | string {
  if (!isRecord(v)) return "The source is missing";
  if (v.type === "git") {
    const git = readGitRef(v.git);
    if (git === null) return "The GitHub repository reference is not valid";
    if (!isStr(v.repoUrl, 300) || !REPO_URL.test(v.repoUrl)) return "The repository URL is not valid";
    if (!isStr(v.branch) || !BRANCH_NAME.test(v.branch)) return BRANCH_MESSAGE;
    return { type: "git", repoUrl: v.repoUrl, branch: v.branch, ...(git ? { git } : {}) };
  }
  if (v.type === "image") {
    if (!isStr(v.image, 400) || !IMAGE_REF.test(v.image)) return "The image reference is not valid";
    if (v.registryId !== null && !(isStr(v.registryId) && ID.test(v.registryId))) return "The registry is not valid";
    return { type: "image", image: v.image, registryId: v.registryId };
  }
  if (v.type === "service") {
    const service = v.service;
    if (service !== "postgres" && service !== "redis") return "Unknown service";
    if (!isStr(v.version) || !SERVICE_VERSIONS[service].includes(v.version)) return "That version is not offered";
    return { type: "service", service, version: v.version };
  }
  return "Unknown source";
}

function readBuild(v: unknown): BuildSettings | string {
  if (!isRecord(v)) return "Build settings are missing";
  if (v.builder !== "auto" && v.builder !== "dockerfile" && v.builder !== "railpack") return "Unknown builder";
  if (v.framework !== null && !isStr(v.framework, 40)) return "The framework is not valid";
  if (!isStr(v.rootDir) || !isRepoPath(v.rootDir, { allowEmpty: true })) return "The root directory is not valid";
  if (v.installCommand !== undefined && (!isStr(v.installCommand, 1000) || !isCommand(v.installCommand))) return "The install command is not valid";
  if (!isStr(v.buildCommand, 1000) || !isCommand(v.buildCommand)) return "The build command is not valid";
  if (!isStr(v.startCommand, 1000) || !isCommand(v.startCommand)) return "The start command is not valid";
  if (!isStr(v.dockerfilePath) || !isRepoPath(v.dockerfilePath, { allowEmpty: v.builder !== "dockerfile" })) return "The Dockerfile path is not valid";
  if (v.port !== null && !isPort(v.port)) return "The port is not valid";
  return {
    builder: v.builder,
    framework: v.framework,
    rootDir: v.rootDir,
    ...(typeof v.installCommand === "string" ? { installCommand: v.installCommand } : {}),
    buildCommand: v.buildCommand,
    startCommand: v.startCommand,
    dockerfilePath: v.dockerfilePath,
    port: v.port,
  };
}

function readSpec(v: unknown): AppSpec | string {
  if (!isRecord(v)) return "An app is missing";
  if (!isStr(v.name, 32) || !APP_NAME.test(v.name)) return "An app name is not valid";
  if (hasReservedPrefix(v.name)) return RESERVED_NAME_MESSAGE;
  const source = readSource(v.source);
  if (typeof source === "string") return source;
  const kind = v.kind;
  if (source.type === "service") {
    if (kind !== SERVICE_KIND[source.service]) return "The kind does not match the service";
  } else if (kind !== "frontend" && kind !== "backend" && kind !== "bot") return "Unknown kind";

  const out: AppSpec = { name: v.name, kind: kind as AppKind, source, target: "server" };

  if (v.target === "vercel") {
    if (source.type !== "git" || kind !== "frontend") return "Only a frontend built from a repository can deploy to Vercel";
    out.target = "vercel";
  } else if (v.target !== "server") return "Unknown deploy target";

  if (source.type === "git") {
    const build = readBuild(v.build);
    if (typeof build === "string") return build;
    out.build = build;
  } else if (v.build !== undefined) return "Only a repository app has build settings";

  if (v.run !== undefined) {
    if (source.type !== "image" || !isRecord(v.run)) return "Only an image app has run settings";
    const { startCommand, port } = v.run;
    if (!isStr(startCommand, 1000) || !isCommand(startCommand)) return "The start command is not valid";
    if (port !== null && !isPort(port)) return "The port is not valid";
    out.run = { startCommand, port };
  }

  if (v.env !== undefined) {
    if (!Array.isArray(v.env) || v.env.length > 200) return "Too many variables";
    const keys = new Set<string>();
    for (const e of v.env) {
      if (!isRecord(e) || !isStr(e.key, 128) || !ENV_KEY.test(e.key) || !isStr(e.value, 32_768) || keys.has(e.key)) return "A variable is not valid";
      keys.add(e.key);
    }
    out.env = v.env.map((e: { key: string; value: string }) => ({ key: e.key, value: e.value }));
  }

  if (v.volumes !== undefined) {
    if (!Array.isArray(v.volumes) || v.volumes.length > 10) return "Too many volumes";
    for (const m of v.volumes) {
      // Named volumes only: an absolute path inside the container, never a host path.
      if (!isRecord(m) || !isStr(m.name, 64) || !VOLUME_NAME.test(m.name) || !isStr(m.path) || !/^\/[\w.\-/]*$/.test(m.path) || m.path.split("/").includes("..")) {
        return "A volume is not valid";
      }
    }
    out.volumes = v.volumes.map((m: VolumeMount) => ({ name: m.name, path: m.path }));
  }

  return out;
}

/** App ids, deduplicated, or null when the list is not one. */
function readIds(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_LINKS || !v.every((id) => isStr(id, 64) && ID.test(id))) return null;
  return [...new Set(v as string[])];
}

/** The apps to link, only with one new Postgres or Redis. Undefined when none are picked. */
function readLink(v: unknown, apps: AppSpec[]): ServiceLink | undefined | string {
  if (v === undefined) return undefined;
  const ids = isRecord(v) ? readIds(v.apps) : null;
  const replace = isRecord(v) ? (v.replace === undefined ? [] : readIds(v.replace)) : null;
  if (!ids || !replace) return "The apps to link are not valid";
  if (!ids.length) return undefined;
  if (apps.length !== 1 || apps[0]!.source.type !== "service") return "Only a new database or cache can be linked to apps";
  return { apps: ids, ...(replace.length ? { replace } : {}) };
}

/** The create body, checked field by field. A string is the reason it was refused. */
export function readCreate(body: unknown): CreateAppsInput | string {
  if (!isRecord(body)) return "That request is not valid";
  if (!isStr(body.project, 40) || !PROJECT_SLUG.test(body.project)) return "Unknown project";
  if (!isStr(body.environment, 32) || !ENV_NAME.test(body.environment)) return "Unknown environment";
  if (!Array.isArray(body.apps) || !body.apps.length) return "Nothing to create";
  if (body.apps.length > MAX_APPS) return `At most ${MAX_APPS} apps at once`;
  const apps: AppSpec[] = [];
  const names = new Set<string>();
  for (const a of body.apps) {
    const spec = readSpec(a);
    if (typeof spec === "string") return spec;
    if (names.has(spec.name)) return `${spec.name} is listed twice`;
    names.add(spec.name);
    apps.push(spec);
  }
  const link = readLink(body.link, apps);
  if (typeof link === "string") return link;
  return { project: body.project, environment: body.environment, apps, ...(link ? { link } : {}) };
}

/** A LINK_CONFLICT answer's apps, rebuilt from checked fields only, or null when anything is off. */
export function readConflict(v: unknown): LinkConflict | null {
  if (!isRecord(v) || !isStr(v.key, 128) || !ENV_KEY.test(v.key) || !Array.isArray(v.apps) || v.apps.length > MAX_LINKS) return null;
  const apps: LinkConflict["apps"] = [];
  for (const a of v.apps) {
    if (!isRecord(a) || !isStr(a.id, 64) || !ID.test(a.id) || !isStr(a.name, 64) || typeof a.shared !== "boolean") return null;
    apps.push({ id: a.id, name: a.name, shared: a.shared });
  }
  return apps.length ? { key: v.key, apps } : null;
}

export function readDetect(body: unknown): DetectInput | string {
  if (!isRecord(body)) return "That request is not valid";
  if (!isStr(body.repoUrl, 300) || !REPO_URL.test(body.repoUrl)) return "The repository URL is not valid";
  if (!isStr(body.branch) || !BRANCH_NAME.test(body.branch)) return BRANCH_MESSAGE;
  if (!isStr(body.rootDir) || !isRepoPath(body.rootDir, { allowEmpty: true })) return "The root directory is not valid";
  const git = readGitRef(body.git);
  if (git === null) return "The GitHub repository reference is not valid";
  return { repoUrl: body.repoUrl, branch: body.branch, rootDir: body.rootDir, ...(git ? { git } : {}) };
}

/** An app name from any label: lowercase words joined by hyphens, 32 at most. */
export const appSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");

/** The repository name inside an image reference, for a default app name: ghcr.io/a/web:1 is web. */
export const imageName = (ref: string) => appSlug(ref.split("@")[0]!.split("/").pop()!.split(":")[0]!);
