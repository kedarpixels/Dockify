import "server-only";
import {
  conflictMessage,
  LINK_CONFLICT,
  LINK_KEY,
  readConflict,
  type AppSpec,
  type CreateAppsInput,
  type CreateAppsResult,
  type DetectInput,
  type DetectResult,
  type LinkConflict,
  type NewAppAnswer,
  type NewAppContext,
  type ServiceLink,
} from "@/components/new-app/spec";
import type { DeployTemplateInput, DeployTemplateResult, TemplateRow } from "@/components/new-app/template-spec";
import { apiRequest, UNREADABLE } from "@/lib/api";
import { upstreamStatus } from "@/lib/http";
import { previewElevated } from "@/lib/preview-step-up";
import { STEP_UP_MESSAGE, STEP_UP_REQUIRED } from "@/lib/step-up";
import { previewIntegrations, type IntegrationsConnected, type IntegrationsSummary } from "./integrations";
import { toContext } from "./new-app-context";
import { getProjectExtras, getProjectPage } from "./project-detail";
import { isPreviewMode } from "@/lib/preview-mode";

/*
 * "Host any application": the new app flow on the project page. API contract for the backend
 * rebuild (every call forwards the session cookie, every answer is JSON, nothing is cached, every
 * failure answers `{ error }` with a 4xx or 5xx).
 *
 * The browser never calls the API directly: it goes through app/api/new-app/**, which checks
 * every field with readCreate and readDetect (components/new-app/spec.ts) first. Creating and
 * importing are elevated: without a fresh step-up they answer the shared refusal (lib/step-up.ts)
 * and the dialog confirms it is you and sends again.
 */

export type { CreateAppsInput, CreateAppsResult, DetectInput, DetectResult, NewAppContext };

// -------------- API --------------


type Upstream<T> = { ok: true; body: T } | { ok: false; status: number; error: string; code?: string; body?: Record<string, unknown> };

/** One call to the Dockify API (lib/api.ts) with the viewer's cookie, never cached, always bounded. */
async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<Upstream<T>> {
  const r = await apiRequest<T>(path, { method, body });
  if (!r.ok) return { ok: false, status: r.status, error: r.error, code: r.code, body: r.body };
  return r.data === null ? { ok: false, status: 502, error: UNREADABLE } : { ok: true, body: r.data };
}

export interface NewAppRoute<T> {
  status: number;
  body: NewAppAnswer<T> & { code?: string };
}

const NONE = { status: 503, body: { source: "none", data: null, error: "No data source, set DOCKIFY_API_URL for this dashboard" } } as const;

/**
 * Through the API, else the preview fixture, else no data source. The API's own 4xx pass through
 * (401 ends the session, a step-up refusal keeps its code, a link conflict keeps its apps); anything
 * else reads as a bad gateway. `elevated` refuses the preview write outside its step-up window, as
 * the API would.
 */
async function route<T>(call: () => Promise<Upstream<T>>, demo: () => T, elevated = false): Promise<NewAppRoute<T>> {
  if (process.env.DOCKIFY_API_URL !== undefined) {
    const res = await call();
    if (res.ok) return { status: 200, body: { source: "api", data: res.body } };
    const conflict = res.code === LINK_CONFLICT ? readConflict(res.body) : null;
    return { status: upstreamStatus(res.status), body: { source: "api", data: null, error: res.error, code: res.code, ...(conflict ? { conflict } : {}) } };
  }
  if (isPreviewMode()) {
    if (elevated && !previewElevated()) return { status: 403, body: { source: "preview", data: null, error: STEP_UP_MESSAGE, code: STEP_UP_REQUIRED } };
    return { status: 200, body: { source: "preview", data: demo() } };
  }
  return NONE;
}

export async function getNewAppContext(): Promise<NewAppRoute<NewAppContext>> {
  const r = await route<IntegrationsSummary | IntegrationsConnected | null>(
    () => api("GET", "/api/v1/integrations"),
    () => previewIntegrations(new Date()),
  );
  return { status: r.status, body: { ...r.body, data: r.status === 200 ? toContext(r.body.data) : null } };
}

export function detectBuild(input: DetectInput): Promise<NewAppRoute<DetectResult>> {
  return route<DetectResult>(
    () => api("POST", "/api/v1/apps/detect", input),
    () => previewDetect(input),
  );
}

export async function createApps(input: CreateAppsInput): Promise<NewAppRoute<CreateAppsResult>> {
  const slug = encodeURIComponent(input.project);
  const [first] = input.apps;
  if (input.apps.length === 1 && first) {
    // The preview answers a link conflict the way the API would, once the write is allowed at all.
    const conflict = isPreviewMode() && previewElevated() ? await previewConflict(input) : null;
    if (conflict) return { status: 409, body: { source: "preview", data: null, error: conflictMessage(conflict), code: LINK_CONFLICT, conflict } };
    const body = { ...first, environment: input.environment, ...(input.link ? { link: input.link } : {}) } satisfies AppSpec & { environment: string; link?: ServiceLink };
    const r = await route<{ id: string }>(() => api("POST", `/api/v1/projects/${slug}/apps`, body), () => ({ id: "" }), true);
    return { status: r.status, body: { ...r.body, data: r.body.data ? { ids: r.body.data.id ? [r.body.data.id] : [] } : null } };
  }
  return route<CreateAppsResult>(
    () => api("POST", `/api/v1/projects/${slug}/apps/import`, { environment: input.environment, apps: input.apps }),
    // The preview accepts every valid create and changes nothing, so there is no app to open.
    () => ({ ids: [] }),
    true,
  );
}

/** The release's templates, as the API lists them. The preview shows a small sample of the same shape. */
export function listTemplates(): Promise<NewAppRoute<TemplateRow[]>> {
  return route<TemplateRow[]>(() => api("GET", "/api/v1/templates"), () => PREVIEW_TEMPLATES, false);
}

export function deployTemplate(input: DeployTemplateInput): Promise<NewAppRoute<DeployTemplateResult>> {
  const { project, ...body } = input;
  return route<DeployTemplateResult>(
    () => api("POST", `/api/v1/projects/${encodeURIComponent(project)}/apps/template`, body),
    () => ({ ids: [], primaryId: "", url: null, warning: null }),
    true,
  );
}

const PREVIEW_TEMPLATES: TemplateRow[] = [
  {
    id: "directus", name: "Directus", summary: "Headless CMS and data platform.", category: "Content", icon: "directus", license: "MSCL-1.0-GPL, free for internal use only", homepage: "https://directus.io", docs: "https://directus.io/docs/self-hosting/deploying",
    firstRun: "Sign in with the email you typed and ADMIN_PASSWORD, which you can reveal on its Variables tab.", needsDomain: true,
    inputs: [{ key: "ADMIN_EMAIL", label: "Admin email", hint: "The first account signs in with this.", type: "email" }],
    apps: [
      { service: "directus", kind: "backend", image: "directus/directus:12.6", managed: null, command: null, port: 8055, primary: true, volumes: [{ name: "uploads", path: "/directus/uploads" }, { name: "extensions", path: "/directus/extensions" }], memoryMb: 512, env: [{ key: "SECRET", shows: "generated secret", secret: true }, { key: "DB_CLIENT", shows: "pg", secret: false }, { key: "DB_PASSWORD", shows: "link to db: password", secret: true }, { key: "ADMIN_EMAIL", shows: "Admin email", secret: false }, { key: "PUBLIC_URL", shows: "https://your-domain", secret: false }] },
      { service: "db", kind: "postgres", image: "", managed: "Postgres 17", command: null, port: null, primary: false, volumes: [], memoryMb: 512, env: [] },
    ],
  },
  {
    id: "n8n", name: "n8n", summary: "Workflow automation with a visual editor.", category: "Automation", icon: "n8n", license: "Sustainable Use License, not open source", homepage: "https://n8n.io", docs: "https://docs.n8n.io/hosting/installation/docker/",
    firstRun: "It asks you to create the owner account. Do that before you share the address. Its license limits commercial use.", needsDomain: true, inputs: [],
    apps: [
      { service: "n8n", kind: "backend", image: "n8nio/n8n:2.46.6", managed: null, command: null, port: 5678, primary: true, volumes: [{ name: "data", path: "/home/node/.n8n" }], memoryMb: 512, env: [{ key: "N8N_ENCRYPTION_KEY", shows: "generated secret", secret: true }, { key: "WEBHOOK_URL", shows: "https://your-domain", secret: false }] },
      { service: "db", kind: "postgres", image: "", managed: "Postgres 17", command: null, port: null, primary: false, volumes: [], memoryMb: 512, env: [] },
    ],
  },
  {
    id: "uptime-kuma", name: "Uptime Kuma", summary: "Uptime monitoring with status pages.", category: "Monitoring", icon: "uptimekuma", license: "MIT", homepage: "https://uptime.kuma.pet", docs: "https://github.com/louislam/uptime-kuma/wiki/Environment-Variables",
    firstRun: "It asks you to create the admin account. Do that before you share the address, then turn on Trust Proxy under Settings, Reverse Proxy.", needsDomain: false, inputs: [],
    apps: [{ service: "kuma", kind: "backend", image: "louislam/uptime-kuma:2.5.9-rootless", managed: null, command: null, port: 3001, primary: true, volumes: [{ name: "data", path: "/app/data" }], memoryMb: 256, env: [{ key: "UPTIME_KUMA_DB_TYPE", shows: "sqlite", secret: false }] }],
  },
  {
    id: "memos", name: "Memos", summary: "Quick notes, in a timeline of your own.", category: "Collaboration", icon: "", license: "MIT", homepage: "https://usememos.com", docs: "https://usememos.com/docs/installation/docker",
    firstRun: "It asks you to create the first account. Do that before you share the address. Dockify does not back up its volume.", needsDomain: false, inputs: [],
    apps: [{ service: "memos", kind: "backend", image: "neosmemo/memos:26.11.0", managed: null, command: null, port: 5230, primary: true, volumes: [{ name: "data", path: "/var/opt/memos" }], memoryMb: 128, env: [] }],
  },
];

// -------------- Preview fixture --------------
// Design preview only (DOCKIFY_PREVIEW=1 without an API). Registries and Vercel come from the
// integrations fixture; detection knows the repositories lib/pages/git.ts lists, so picking
// acme-labs/horseai reads Next.js and leaderboard-scraper reads its Dockerfile.


const previewBuild = (framework: string, install: string, build: string, start: string, port: number | null): Omit<DetectResult, "rootDir"> => ({
  pending: false, detected: true, framework, builder: "railpack", hasDockerfile: false, staticSite: false, reason: null, installCommand: install, buildCommand: build, startCommand: start, dockerfilePath: "", port,
});
const PREVIEW_NEXT = previewBuild("Next.js", "pnpm install --frozen-lockfile", "pnpm build", "pnpm start", 3000);
const PREVIEW_BUILDS: Record<string, Omit<DetectResult, "rootDir">> = {
  dockify: PREVIEW_NEXT,
  portfolio: PREVIEW_NEXT,
  horseai: PREVIEW_NEXT,
  inkwell: PREVIEW_NEXT,
  brightlane: PREVIEW_NEXT,
  "fieldnote": { ...PREVIEW_NEXT, staticSite: true, startCommand: "caddy run --config Caddyfile --adapter caddyfile" },
  "discord-bot": previewBuild("Bun", "bun install", "", "bun run src/index.ts", 3000),
  "leaderboard-scraper": { ...previewBuild("Go", "", "go build -o out", "./out", 8080), builder: "dockerfile", hasDockerfile: true, dockerfilePath: "Dockerfile" },
};

function previewDetect(input: DetectInput): DetectResult {
  const repo = input.repoUrl.replace(/\.git$/, "").split(/[/:]/).pop()?.toLowerCase() ?? "";
  const hit = PREVIEW_BUILDS[repo];
  if (!hit) return { pending: false, detected: false, framework: null, builder: "railpack", hasDockerfile: false, staticSite: false, reason: "Railpack found nothing it knows how to build here. Add a Dockerfile, or set the commands.", rootDir: input.rootDir, installCommand: "", buildCommand: "", startCommand: "", dockerfilePath: "", port: null };
  return { ...hit, rootDir: input.rootDir };
}

/**
 * The API's link rule against the preview's own variables: a picked app that already has the
 * variable, its own or one shared in its environment, is a conflict until its id is in `replace`.
 */
async function previewConflict(input: CreateAppsInput): Promise<LinkConflict | null> {
  const source = input.apps[0]?.source;
  const link = input.link;
  if (!link || source?.type !== "service") return null;
  const key = LINK_KEY[source.service];
  const [page, extras] = await Promise.all([getProjectPage(input.project), getProjectExtras(input.project)]);
  const env = extras.data?.env;
  const shared = env?.environments.find((e) => e.name === input.environment)?.vars.some((v) => v.key === key) ?? false;
  const replace = new Set(link.replace ?? []);
  const apps = (page.data?.project.apps ?? []).filter((a) => link.apps.includes(a.id) && !replace.has(a.id));
  const held = apps.flatMap((a) => {
    const own = env?.overrides.some((o) => o.appId === a.id && o.vars.some((v) => v.key === key)) ?? false;
    return own || shared ? [{ id: a.id, name: a.name, shared: !own }] : [];
  });
  return held.length ? { key, apps: held } : null;
}
