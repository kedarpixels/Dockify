/**
 * What an app linked to a Vercel project shows of that project, read live from Vercel: its settings,
 * what production serves, its domains (apps.vercel.project), and its environment variables
 * (apps.vercel.env). Only GET calls: nothing here ever writes to Vercel, and no variable is ever
 * decrypted. A plain variable's value comes back as Vercel sends it in the list, and only an admin's
 * browser session sees it; everyone else gets the keys.
 *
 * Each read is cached for a minute per token and project, and concurrent tabs share one call, so
 * switching tabs is instant and Vercel is not asked twice. A 429 is remembered for as long as Vercel
 * asked, so a reload during it answers at once with when to try again.
 */
import type { Keyring } from "@dockify/crypto";
import type { Db } from "@dockify/db";
import type { HttpClient } from "@dockify/net-guard";
import { assertProjectScope, readsCommands, type Actor } from "../../actor.ts";
import type { Handlers } from "../../app.ts";
import { HttpError } from "../../errors.ts";
import { requireActor, type IntegrationDeps } from "./deps.ts";
import { configOf, findIntegration, openSecret } from "./store.ts";
import { normaliseTargets, TOKEN_DEAD, VercelApi } from "./vercel.ts";

/** How long one read of a project serves every tab. */
export const VERCEL_READ_TTL_MS = 60_000;
const CACHE_MAX = 500;

/* ------------------------------------------------------------------ Vercel's shapes */

/** One deployment as GET /v9/projects/:id carries it under targets and latestDeployments. */
export interface RawDeployment {
  id?: string;
  uid?: string;
  url?: string | null;
  alias?: unknown;
  readyState?: string;
  state?: string;
  target?: string | null;
  createdAt?: number;
  created?: number;
  buildingAt?: number | null;
  readyAt?: number | null;
  ready?: number | null;
  inspectorUrl?: string | null;
  creator?: { username?: string | null; githubLogin?: string | null } | null;
  meta?: Record<string, unknown> | null;
}

export interface RawProject {
  id: string;
  name: string;
  framework?: string | null;
  nodeVersion?: string | null;
  rootDirectory?: string | null;
  buildCommand?: string | null;
  installCommand?: string | null;
  outputDirectory?: string | null;
  link?: Record<string, unknown> | null;
  targets?: { production?: RawDeployment | null } | null;
}

export interface RawDomain {
  name?: string;
  verified?: boolean;
  redirect?: string | null;
  redirectStatusCode?: number | null;
  gitBranch?: string | null;
  createdAt?: number | null;
}

export interface RawEnv {
  id?: string;
  key?: string;
  target?: string[] | string;
  type?: string;
  gitBranch?: string | null;
  comment?: string | null;
  updatedAt?: number | null;
  createdAt?: number | null;
  value?: unknown;
  decrypted?: boolean;
}

/* ------------------------------------------------------------------ cleaning */

/** Text from a third party, for one line of the page: no control characters, bounded. */
const plain = (v: unknown, max = 200): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
  return t ? t.slice(0, max) : null;
};

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const host = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const h = v.trim().toLowerCase();
  return h.length <= 253 && HOST.test(h) ? h : null;
};

const iso = (ms: unknown): string | null => (typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

/** A path segment of a vercel.com address: Vercel's slugs and project names are of this form. */
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

/** Vercel's inspector page, https on vercel.com only. */
function inspector(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.hostname === "vercel.com" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The project's pages on vercel.com: the team's slug, else the account's username, then the project name. */
export function projectLinks(scope: string | null, name: string) {
  const base = scope && SEGMENT.test(scope) && SEGMENT.test(name) ? `https://vercel.com/${scope}/${name}` : "https://vercel.com/dashboard";
  const page = (p: string) => (base.endsWith("/dashboard") ? base : `${base}${p}`);
  return { project: base, deployments: page("/deployments"), domains: page("/settings/domains"), env: page("/settings/environment-variables"), settings: page("/settings") };
}

export function deploymentState(s: string | undefined): "queued" | "building" | "ready" | "failed" | "cancelled" {
  switch (s) {
    case "READY": return "ready";
    case "ERROR": return "failed";
    case "CANCELED":
    case "DELETED": return "cancelled";
    case "BUILDING":
    case "INITIALIZING": return "building";
    default: return "queued";
  }
}

const META = ["github", "gitlab", "bitbucket"] as const;
const meta = (m: Record<string, unknown> | null | undefined, suffix: string, max = 200) => {
  for (const p of META) {
    const v = plain(m?.[`${p}${suffix}`], max);
    if (v) return v;
  }
  return null;
};

type Repo = { provider: "github" | "gitlab" | "bitbucket"; slug: string; url: string | null; productionBranch: string | null };

/** The Git repository Vercel builds from, as its project link names it. */
export function repoOf(link: Record<string, unknown> | null | undefined): Repo | null {
  if (!link) return null;
  const part = (k: string) => {
    const v = plain(link[k], 100);
    return v && /^[\w.-]+$/.test(v) ? v : null;
  };
  const productionBranch = plain(link.productionBranch, 255);
  if (link.type === "github") {
    const org = part("org");
    const repo = part("repo");
    return org && repo ? { provider: "github", slug: `${org}/${repo}`, url: `https://github.com/${org}/${repo}`, productionBranch } : null;
  }
  if (link.type === "bitbucket") {
    const owner = part("owner");
    const slug = part("slug");
    return owner && slug ? { provider: "bitbucket", slug: `${owner}/${slug}`, url: `https://bitbucket.org/${owner}/${slug}`, productionBranch } : null;
  }
  if (link.type === "gitlab") {
    const ns = plain(link.projectNamespace, 200);
    const name = part("projectName");
    if (!ns || !name || !/^[\w./-]+$/.test(ns) || ns.includes("..")) return null;
    return { provider: "gitlab", slug: `${ns}/${name}`, url: `https://gitlab.com/${ns}/${name}`, productionBranch };
  }
  return null;
}

function commitUrl(repo: Repo | null, sha: string | null): string | null {
  if (!repo?.url || !sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  return repo.provider === "gitlab" ? `${repo.url}/-/commit/${sha}` : repo.provider === "bitbucket" ? `${repo.url}/commits/${sha}` : `${repo.url}/commit/${sha}`;
}

/** One deployment for the page. The inspector address is built from the project's when Vercel leaves it out. */
export function deploymentView(d: RawDeployment, repo: Repo | null, projectUrl: string, deploymentId: string | null) {
  const id = plain(d.uid ?? d.id, 64) ?? "";
  const created = d.createdAt ?? d.created;
  const readyAt = d.readyAt ?? d.ready ?? null;
  const sha = meta(d.meta, "CommitSha", 40);
  const message = (() => {
    for (const p of META) {
      const v = d.meta?.[`${p}CommitMessage`];
      if (typeof v === "string" && v.trim()) return plain(v.trim().split(/[\r\n]/)[0], 300);
    }
    return null;
  })();
  const aliases = (Array.isArray(d.alias) ? d.alias : []).map(host).filter((h): h is string => !!h);
  // Custom domains first: they are what people visit. Then Vercel's own names.
  aliases.sort((a, b) => Number(a.endsWith(".vercel.app")) - Number(b.endsWith(".vercel.app")));
  const shortId = id.replace(/^dpl_/, "");
  return {
    id,
    url: host(d.url) ? `https://${host(d.url)}` : null,
    inspectorUrl: inspector(d.inspectorUrl) ?? (projectUrl.endsWith("/dashboard") || !SEGMENT.test(shortId) ? null : `${projectUrl}/${shortId}`),
    status: deploymentState(d.readyState ?? d.state),
    target: d.target === "production" ? ("production" as const) : ("preview" as const),
    branch: meta(d.meta, "CommitRef", 255),
    commit: sha,
    message,
    commitUrl: commitUrl(repo, sha),
    author: plain(d.creator?.githubLogin, 64) ?? meta(d.meta, "CommitAuthorLogin", 64) ?? plain(d.creator?.username, 64),
    createdAt: iso(created) ?? new Date(0).toISOString(),
    readyAt: iso(readyAt),
    durationMs: typeof d.buildingAt === "number" && typeof readyAt === "number" && readyAt >= d.buildingAt ? readyAt - d.buildingAt : null,
    aliases: [...new Set(aliases)].slice(0, 20),
    deploymentId,
  };
}

export function domainView(d: RawDomain) {
  const name = host(d.name);
  if (!name) return null;
  return {
    name,
    verified: d.verified === true,
    redirect: host(d.redirect),
    redirectStatusCode: typeof d.redirectStatusCode === "number" ? d.redirectStatusCode : null,
    gitBranch: plain(d.gitBranch, 255),
    createdAt: iso(d.createdAt),
  };
}

/** One variable for a caller. Values only for a plain variable, never decrypted, and only when `values`. */
export function envView(e: RawEnv, values: boolean) {
  const type = plain(e.type, 32) ?? "encrypted";
  return {
    id: plain(e.id, 64) ?? "",
    key: plain(e.key, 256) ?? "",
    targets: normaliseTargets(e.target),
    type,
    gitBranch: plain(e.gitBranch, 255),
    comment: values ? plain(e.comment, 500) : null,
    updatedAt: iso(e.updatedAt ?? e.createdAt),
    value: values && type === "plain" && e.decrypted !== true && typeof e.value === "string" ? e.value.slice(0, 4096) : null,
  };
}

/* ------------------------------------------------------------------ cache */

interface Entry {
  until: number;
  promise: Promise<unknown>;
}
const cache = new Map<string, Entry>();

/** For tests. */
export function clearVercelReadCache(): void {
  cache.clear();
}

/**
 * One read shared by every caller for its time to live. A failure is forgotten at once, except
 * Vercel's 429, which holds for as long as Vercel asked, so a reload cannot add to it.
 */
export async function cachedRead<T>(key: string, load: () => Promise<T>, now = Date.now): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.until > now()) return hit.promise as Promise<T>;
  if (cache.size >= CACHE_MAX) {
    for (const [k, v] of cache) if (v.until <= now()) cache.delete(k);
    while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  const promise = load();
  // In flight it already serves the next caller; it settles to a minute, or Vercel's wait, or nothing.
  const entry: Entry = { until: Number.POSITIVE_INFINITY, promise };
  cache.set(key, entry);
  promise.then(
    () => {
      entry.until = now() + VERCEL_READ_TTL_MS;
    },
    (e: unknown) => {
      const wait = e instanceof HttpError && e.code === "VERCEL_RATE_LIMITED" ? Number(e.extra.retryAfter) : 0;
      if (wait > 0) entry.until = now() + wait * 1000;
      else if (cache.get(key) === entry) cache.delete(key);
    },
  );
  return promise;
}

/* ------------------------------------------------------------------ reads */

interface Linked {
  app: { id: string; vercelProjectId: string };
  api: VercelApi;
  key: string;
  scope: string | null;
}

/** The app, its project scope checked, and a reader for the Vercel project it links to. */
async function linked(db: Db, ring: Keyring, http: HttpClient, actor: Actor, appId: string): Promise<Linked> {
  const app = await db.app.findUnique({ where: { id: appId }, select: { id: true, deployTarget: true, vercelProjectId: true, environment: { select: { projectId: true } } } });
  if (!app) throw new HttpError(404, "App not found", "NOT_FOUND");
  assertProjectScope(actor, app.environment.projectId);
  if (app.deployTarget !== "vercel" || !app.vercelProjectId) throw new HttpError(409, "This app is not linked to a Vercel project", "NOT_VERCEL_TARGET");
  const row = await findIntegration(db, "vercel");
  if (!row || row.status === "disconnected" || !row.secretId) throw new HttpError(409, "Vercel is not connected. Connect it in Settings, Integrations.", "NOT_CONNECTED");
  const token = await openSecret(db, ring, row);
  if (!token) throw new HttpError(409, "Vercel is not connected. Connect it in Settings, Integrations.", "NOT_CONNECTED");
  const c = configOf<{ username?: string; team?: { id?: string; slug?: string } | null }>(row);
  const teamId = c.team?.id ?? null;
  return {
    app: { id: app.id, vercelProjectId: app.vercelProjectId },
    api: new VercelApi(http, token, teamId),
    // The secret's id changes with the token, so a reconnect never serves the old token's answers.
    key: `${row.secretId}:${teamId ?? "-"}:${app.vercelProjectId}`,
    scope: c.team?.slug ?? c.username ?? null,
  };
}

/** Vercel's refusals, said for this page. */
function said(e: unknown): never {
  if (e instanceof HttpError && e.code === "VERCEL_TOKEN") throw new HttpError(409, TOKEN_DEAD, "VERCEL_TOKEN");
  if (e instanceof HttpError && e.code === "NOT_FOUND") {
    throw new HttpError(404, "Vercel has no such project for this token. It may have been deleted, or it is in another team. Pick the project again in Settings, Deploy target.", "VERCEL_PROJECT_GONE");
  }
  throw e;
}

const enc = encodeURIComponent;

export async function readVercelProject(db: Db, ring: Keyring, http: HttpClient, actor: Actor, appId: string) {
  const l = await linked(db, ring, http, actor, appId);
  const pid = l.app.vercelProjectId;
  const [project, domains] = await Promise.all([
    cachedRead(`${l.key}:project`, () => l.api.call<RawProject>("GET", `/v9/projects/${enc(pid)}`)).catch(said),
    // The project alone still makes the page; its domains failing says so in their place.
    cachedRead(`${l.key}:domains`, () => l.api.call<{ domains?: RawDomain[] }>("GET", `/v9/projects/${enc(pid)}/domains?limit=100`))
      .then((d) => ({ list: d.domains ?? [], error: null as string | null }))
      .catch((e: unknown) => ({ list: [] as RawDomain[], error: e instanceof HttpError && e.code !== "INTERNAL" ? (e.code === "VERCEL_TOKEN" ? TOKEN_DEAD : e.message) : "Vercel did not answer" })),
  ]);
  const name = plain(project.name, 100) ?? pid;
  const links = projectLinks(l.scope, name);
  const repo = repoOf(project.link);
  const prod = project.targets?.production ?? null;
  const prodId = prod ? (prod.uid ?? prod.id ?? null) : null;
  const mirrored = prodId ? await db.deployment.findFirst({ where: { appId: l.app.id, provider: "vercel", externalId: prodId }, select: { id: true } }) : null;
  return {
    id: pid,
    name,
    framework: plain(project.framework, 64),
    nodeVersion: plain(project.nodeVersion, 16),
    rootDirectory: plain(project.rootDirectory, 255),
    // A command can hold a token someone pasted inline: blank for a Viewer, as a Dockify app's are.
    buildCommand: readsCommands(actor) ? plain(project.buildCommand, 500) : null,
    installCommand: readsCommands(actor) ? plain(project.installCommand, 500) : null,
    outputDirectory: plain(project.outputDirectory, 255),
    repo,
    links,
    production: prod ? deploymentView(prod, repo, links.project, mirrored?.id ?? null) : null,
    domains: domains.list.map(domainView).filter((d): d is NonNullable<ReturnType<typeof domainView>> => !!d),
    domainsError: domains.error,
    fetchedAt: new Date().toISOString(),
  };
}

export async function readVercelEnv(db: Db, ring: Keyring, http: HttpClient, actor: Actor, appId: string) {
  const l = await linked(db, ring, http, actor, appId);
  const pid = l.app.vercelProjectId;
  const [env, project] = await Promise.all([
    // No decrypt parameter, ever: encrypted and sensitive values stay sealed on Vercel's side.
    cachedRead(`${l.key}:env`, () => l.api.call<{ envs?: RawEnv[]; hiddenProductionEnvCount?: number }>("GET", `/v10/projects/${enc(pid)}/env`)).catch(said),
    // For the project's name in the link only; a cached read, and the link falls back without it.
    cachedRead(`${l.key}:project`, () => l.api.call<RawProject>("GET", `/v9/projects/${enc(pid)}`)).catch(() => null),
  ]);
  const values = actor.kind === "session" && actor.role === "admin";
  const variables = (env.envs ?? []).map((e) => envView(e, values)).filter((e) => e.key);
  variables.sort((a, b) => a.key.localeCompare(b.key) || a.targets.join().localeCompare(b.targets.join()));
  return {
    variables,
    hiddenProductionCount: typeof env.hiddenProductionEnvCount === "number" ? env.hiddenProductionEnvCount : 0,
    values,
    manageUrl: projectLinks(l.scope, plain(project?.name, 100) ?? "").env,
    fetchedAt: new Date().toISOString(),
  };
}

export function vercelProjectHandlers(deps: IntegrationDeps): Handlers {
  return {
    "apps.vercel.project": async ({ params, actor, ctx }) => readVercelProject(ctx.db, ctx.ring, deps.http, requireActor(actor), params.id),
    "apps.vercel.env": async ({ params, actor, ctx }) => readVercelEnv(ctx.db, ctx.ring, deps.http, requireActor(actor), params.id),
  };
}
