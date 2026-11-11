import "server-only";
import { apiRequest, UNREADABLE } from "@/lib/api";
import { upstreamStatus } from "@/lib/http";
import { previewElevated } from "@/lib/preview-step-up";
import { STEP_UP_MESSAGE, STEP_UP_REQUIRED } from "@/lib/step-up";
import type { OverviewSource } from "@/lib/types";
import { isPreviewMode } from "@/lib/preview-mode";

// Git connection loader. Dockify reaches GitHub through its own GitHub App: the API holds the private
// key and mints short installation tokens, so this dashboard never sees a token.

export type GitAccountType = "User" | "Organization";

export interface GitAccount {
  login: string;
  type: GitAccountType;
  avatarUrl: string | null;
}

export interface GitInstallation {
  id: string;
  account: GitAccount;
  repositorySelection: "all" | "selected";
  /** How many repositories the App may read when the selection is "selected". */
  selectedCount?: number;
  manageUrl: string;
}

export interface GitRepo {
  id: string;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string;
  language: string | null;
  framework?: string | null;
}

export interface GitRepoPage {
  items: GitRepo[];
  nextCursor: string | null;
}

export interface GitBranch {
  name: string;
  default: boolean;
}

export interface GitAnswer<T> {
  source: OverviewSource;
  data: T | null;
  error?: string;
  /** step_up_required (lib/step-up.ts) when the write needs a fresh step-up. */
  code?: string;
}

export interface GitRoute<T> {
  status: number;
  body: GitAnswer<T>;
}

/** GitHub ids are numbers; the API may prefix them, so allow short URL-safe words. */
export const isGitId = (v: string | null | undefined): v is string => typeof v === "string" && /^[\w-]{1,64}$/.test(v);
export const isCursor = (v: string | null | undefined): v is string => typeof v === "string" && /^[\w.=:-]{1,256}$/.test(v);
/** Search text, trimmed and capped. Anything longer is not a repository name. */
export const cleanQuery = (v: string | null | undefined) => (v ?? "").trim().slice(0, 100);


type ApiAnswer<T> = { ok: true; body: T } | { ok: false; status: number; error: string; code?: string };

/** One call to the Dockify API (lib/api.ts) with the viewer's cookie, never cached, always bounded. */
async function api<T>(path: string, init?: { method?: "DELETE"; search?: Record<string, string | undefined> }): Promise<ApiAnswer<T>> {
  const r = await apiRequest<T>(path, { method: init?.method, query: init?.search });
  if (!r.ok) return { ok: false, status: r.status, error: r.error, code: r.code };
  return r.data === null ? { ok: false, status: 502, error: UNREADABLE } : { ok: true, body: r.data };
}

/** Maps an upstream failure onto the status this dashboard answers with: 401 and 403 pass through. */
function failed<T>(res: { status: number; error: string; code?: string }, missing: string): GitRoute<T> {
  if (res.status === 404) return { status: 404, body: { source: "api", data: null, error: missing } };
  return { status: upstreamStatus(res.status), body: { source: "api", data: null, error: res.error, code: res.code } };
}

const NONE = { status: 503, body: { source: "none", data: null, error: "No data source, set DOCKIFY_API_URL for this dashboard" } } as const;

/** `elevated` refuses the preview write outside its step-up window, as the API refuses it (lib/preview-step-up.ts). */
async function route<T>(call: () => Promise<ApiAnswer<T>>, demo: () => GitRoute<T>, missing: string, elevated = false): Promise<GitRoute<T>> {
  if (process.env.DOCKIFY_API_URL !== undefined) {
    const res = await call();
    return res.ok ? { status: 200, body: { source: "api", data: res.body } } : failed(res, missing);
  }
  if (isPreviewMode()) {
    if (elevated && !previewElevated()) return { status: 403, body: { source: "preview", data: null, error: STEP_UP_MESSAGE, code: STEP_UP_REQUIRED } };
    return demo();
  }
  return NONE;
}

const ok = <T>(data: T): GitRoute<T> => ({ status: 200, body: { source: "preview", data } });

export function getInstallations() {
  return route<GitInstallation[]>(
    () => api("/api/v1/git/installations"),
    () => ok(PREVIEW_INSTALLATIONS),
    "No installations",
  );
}

export function getInstallUrl() {
  return route<{ url: string }>(
    () => api("/api/v1/git/install-url"),
    // The preview has no App, so the round trip lands straight on its return page.
    () => ok({ url: "/settings?section=integrations&github=installed" }),
    "The GitHub App is not configured",
  );
}

export function getRepos(installation: string, q: string, cursor: string | null) {
  return route<GitRepoPage>(
    () => api("/api/v1/git/repos", { search: { installation, q: q || undefined, cursor: cursor ?? undefined } }),
    () => {
      const page = previewRepos(installation, q, cursor);
      return page ? ok(page) : { status: 404, body: { source: "preview", data: null, error: "Unknown installation" } };
    },
    "Unknown installation",
  );
}

export function getBranches(repo: string) {
  return route<GitBranch[]>(
    () => api(`/api/v1/git/repos/${encodeURIComponent(repo)}/branches`),
    () => {
      const r = PREVIEW_REPOS.find((x) => x.repo.id === repo);
      return r ? ok(previewBranches(r.repo)) : { status: 404, body: { source: "preview", data: null, error: "Unknown repository" } };
    },
    "Unknown repository",
  );
}

/** Disconnect. The preview sends nothing and answers as if it had. */
export function deleteInstallation(id: string) {
  return route<{ ok: true }>(
    () => api(`/api/v1/git/installations/${encodeURIComponent(id)}`, { method: "DELETE" }),
    () => (PREVIEW_INSTALLATIONS.some((i) => i.id === id) ? ok({ ok: true }) : { status: 404, body: { source: "preview", data: null, error: "Unknown installation" } }),
    "Unknown installation",
    true,
  );
}

// Preview fixture. The repositories match the projects in lib/preview-fixture.ts.

const PREVIEW_INSTALLATIONS: GitInstallation[] = [
  {
    id: "10000001",
    account: { login: "sam", type: "User", avatarUrl: null },
    repositorySelection: "all",
    manageUrl: "https://github.com/settings/installations/10000001",
  },
  {
    id: "10000002",
    account: { login: "acme-labs", type: "Organization", avatarUrl: null },
    repositorySelection: "selected",
    selectedCount: 6,
    manageUrl: "https://github.com/organizations/acme-labs/settings/installations/10000002",
  },
];

const PAGE = 20;
const H = 3_600_000;

/* Repositories with their push age in hours, so times stay fresh against the preview clock. */
const PREVIEW_REPOS: Array<{ installation: string; ageH: number; branches: string[]; repo: Omit<GitRepo, "pushedAt" | "fullName"> }> = [
  { installation: "10000001", ageH: 0.4, branches: ["dev", "rebuild"], repo: { id: "90000001", name: "dockify", owner: "sam", private: true, defaultBranch: "main", language: "TypeScript", framework: "Next.js" } },
  { installation: "10000001", ageH: 52, branches: [], repo: { id: "90000002", name: "portfolio", owner: "sam", private: false, defaultBranch: "main", language: "TypeScript", framework: "Next.js" } },
  { installation: "10000001", ageH: 260, branches: ["dev"], repo: { id: "90000003", name: "discord-bot", owner: "sam", private: true, defaultBranch: "main", language: "TypeScript", framework: null } },
  { installation: "10000001", ageH: 900, branches: [], repo: { id: "90000004", name: "dotfiles", owner: "sam", private: false, defaultBranch: "master", language: "Shell", framework: null } },
  { installation: "10000002", ageH: 1.5, branches: ["dev", "feat/new-partner"], repo: { id: "90000005", name: "horseai", owner: "acme-labs", private: true, defaultBranch: "main", language: "TypeScript", framework: "Next.js" } },
  { installation: "10000002", ageH: 6, branches: ["dev", "revamp"], repo: { id: "90000006", name: "inkwell", owner: "acme-labs", private: true, defaultBranch: "main", language: "TypeScript", framework: "Next.js" } },
  { installation: "10000002", ageH: 20, branches: ["dev"], repo: { id: "90000007", name: "brightlane", owner: "acme-labs", private: true, defaultBranch: "main", language: "TypeScript", framework: "Next.js" } },
  { installation: "10000002", ageH: 30, branches: ["dev", "challenges"], repo: { id: "90000008", name: "fieldnote", owner: "acme-labs", private: true, defaultBranch: "main", language: "TypeScript", framework: "Next.js" } },
  { installation: "10000002", ageH: 140, branches: [], repo: { id: "90000009", name: "leaderboard-scraper", owner: "acme-labs", private: true, defaultBranch: "main", language: "Python", framework: "Dockerfile" } },
  { installation: "10000002", ageH: 400, branches: [], repo: { id: "90000010", name: "brand-assets", owner: "acme-labs", private: false, defaultBranch: "main", language: null, framework: null } },
];

function previewBranches(repo: Pick<GitRepo, "id" | "defaultBranch">): GitBranch[] {
  const extra = PREVIEW_REPOS.find((r) => r.repo.id === repo.id)?.branches ?? [];
  return [{ name: repo.defaultBranch, default: true }, ...extra.map((name) => ({ name, default: false }))];
}

function previewRepos(installation: string, q: string, cursor: string | null): GitRepoPage | null {
  if (!PREVIEW_INSTALLATIONS.some((i) => i.id === installation)) return null;
  const now = Date.now();
  const needle = q.toLowerCase();
  const all = PREVIEW_REPOS.filter((r) => r.installation === installation && r.repo.name.toLowerCase().includes(needle))
    .sort((a, b) => a.ageH - b.ageH)
    .map((r): GitRepo => ({ ...r.repo, fullName: `${r.repo.owner}/${r.repo.name}`, pushedAt: new Date(now - r.ageH * H).toISOString() }));
  const start = cursor ? Number(cursor) || 0 : 0;
  const items = all.slice(start, start + PAGE);
  return { items, nextCursor: start + PAGE < all.length ? String(start + PAGE) : null };
}
