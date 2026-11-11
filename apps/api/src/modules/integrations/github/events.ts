/** Pure rules for GitHub deliveries. The route owns transport (raw body, signature, replay) and passes parsed shapes. */
import { githubAvatarUrl } from "@dockify/contracts";

/** `host/owner/repo`, lowercased, without `.git` or trailing slashes. Both sides of a match must use it. */
export function repoIdentity(url: string): string | null {
  let host: string;
  let path: string;
  if (url.startsWith("https://")) {
    const rest = url.slice(8);
    const slash = rest.indexOf("/");
    if (slash <= 0) return null;
    host = rest.slice(0, slash).split(":")[0] ?? "";
    path = rest.slice(slash + 1);
  } else if (url.startsWith("git@")) {
    const rest = url.slice(4);
    const colon = rest.indexOf(":");
    if (colon <= 0) return null;
    host = rest.slice(0, colon);
    path = rest.slice(colon + 1);
  } else {
    return null;
  }
  const ownerRepo = (path.split(/[?#]/)[0] ?? "").replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = ownerRepo.split("/");
  if (!host || parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return `${host}/${ownerRepo}`.toLowerCase();
}

interface RepoPayload {
  id?: unknown;
  clone_url?: unknown;
  full_name?: unknown;
}

function identityOf(repo: RepoPayload | null | undefined): string | null {
  if (!repo) return null;
  if (typeof repo.clone_url === "string") {
    const id = repoIdentity(repo.clone_url);
    if (id) return id;
  }
  return typeof repo.full_name === "string" ? repoIdentity(`https://github.com/${repo.full_name}`) : null;
}

const fullNameOf = (repo: RepoPayload | null | undefined): string | null =>
  typeof repo?.full_name === "string" && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo.full_name) ? repo.full_name : null;

const repoIdOf = (repo: RepoPayload | null | undefined): string | null =>
  typeof repo?.id === "number" || typeof repo?.id === "string" ? String(repo.id) : null;


export interface PushEvent {
  identity: string;
  repoId: string | null;
  branch: string;
  deleted: boolean;
  commitSha: string | null;
  message: string | null;
  /** Lowercased GitHub login of the head commit's author, else of whoever pushed. */
  author: string | null;
  /** Kept only when the pusher is that author. The worker asks GitHub for the rest. */
  authorAvatarUrl: string | null;
  /** The head commit's git name, set when that commit has no GitHub account behind it. */
  authorName: string | null;
  installationId: string | null;
}

const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const loginOf = (v: unknown): string | null => (typeof v === "string" && GITHUB_LOGIN.test(v) ? v.toLowerCase() : null);

export const avatarOf = githubAvatarUrl;

/** One line of printable text, or null. Untrusted: anyone can commit under any name. */
export const gitNameOf = (v: unknown): string | null => (typeof v === "string" ? v.replace(/[\p{C}]+/gu, " ").trim().slice(0, 100) || null : null);

export function parsePushEvent(payload: unknown): PushEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as {
    ref?: unknown;
    deleted?: unknown;
    after?: unknown;
    head_commit?: { id?: unknown; message?: unknown; author?: { username?: unknown; name?: unknown } | null } | null;
    sender?: { login?: unknown; avatar_url?: unknown } | null;
    repository?: RepoPayload | null;
    installation?: { id?: unknown } | null;
  };
  if (typeof p.ref !== "string" || !p.ref.startsWith("refs/heads/")) return null;
  const branch = p.ref.slice("refs/heads/".length);
  const identity = identityOf(p.repository);
  if (!branch || !identity) return null;
  const sha = typeof p.head_commit?.id === "string" ? p.head_commit.id : typeof p.after === "string" ? p.after : null;
  const message = typeof p.head_commit?.message === "string" ? (p.head_commit.message.split("\n")[0] ?? "").slice(0, 300) : null;
  const author = loginOf(p.head_commit?.author?.username) ?? loginOf(p.sender?.login);
  return {
    identity,
    repoId: repoIdOf(p.repository),
    branch,
    deleted: p.deleted === true,
    commitSha: sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null,
    message,
    author,
    authorAvatarUrl: author && author === loginOf(p.sender?.login) ? avatarOf(p.sender?.avatar_url) : null,
    authorName: loginOf(p.head_commit?.author?.username) ? null : gitNameOf(p.head_commit?.author?.name),
    installationId: typeof p.installation?.id === "number" ? String(p.installation.id) : null,
  };
}

export interface PushCandidate {
  id: string;
  gitRepository: string | null;
  gitBranch: string | null;
  /** Set when the repository was picked through the App. */
  repoId?: string | null;
  /** Fallback when the app sets no branch. */
  envBranch?: string | null;
}

/** Same repository (by id when both sides know it, else by identity) and same branch. */
export function matchPushTargets<T extends PushCandidate>(push: PushEvent, candidates: T[]): T[] {
  return candidates.filter((app) => {
    if (!app.gitRepository) return false;
    const sameRepo = app.repoId && push.repoId ? app.repoId === push.repoId : repoIdentity(app.gitRepository) === push.identity;
    const branch = app.gitBranch?.trim() || app.envBranch?.trim() || "main";
    return sameRepo && branch === push.branch;
  });
}


export type PrStep = "open" | "update" | "close";

export interface PullRequestEvent {
  step: PrStep;
  number: number;
  title: string;
  author: string | null;
  branch: string;
  commitSha: string | null;
  merged: boolean;
  identity: string;
  repoId: string | null;
  /** The head lives in another repository. Fork code builds only when the project opts in, never with a secret. */
  fromFork: boolean;
  /** owner/name of the base repository as GitHub spells it, for the comment and status calls. */
  fullName: string | null;
}

const STEP: Record<string, PrStep> = { opened: "open", reopened: "open", ready_for_review: "open", synchronize: "update", closed: "close" };

export function parsePullRequestEvent(payload: unknown): PullRequestEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as {
    action?: unknown;
    number?: unknown;
    pull_request?: {
      title?: unknown;
      merged?: unknown;
      user?: { login?: unknown } | null;
      head?: { ref?: unknown; sha?: unknown; repo?: RepoPayload | null } | null;
      base?: { repo?: RepoPayload | null } | null;
    } | null;
    repository?: RepoPayload | null;
  };
  const step = typeof p.action === "string" ? STEP[p.action] : undefined;
  const pr = p.pull_request;
  if (!step || !pr || typeof p.number !== "number" || !Number.isInteger(p.number) || p.number < 1) return null;
  const identity = identityOf(p.repository ?? pr.base?.repo);
  const branch = typeof pr.head?.ref === "string" ? pr.head.ref : "";
  if (!identity || !branch) return null;
  const headId = identityOf(pr.head?.repo);
  const sha = typeof pr.head?.sha === "string" && /^[0-9a-f]{40}$/.test(pr.head.sha) ? pr.head.sha : null;
  return {
    step,
    number: p.number,
    title: typeof pr.title === "string" ? pr.title.slice(0, 200) : `PR #${p.number}`,
    author: typeof pr.user?.login === "string" ? pr.user.login : null,
    branch,
    commitSha: sha,
    merged: pr.merged === true,
    identity,
    repoId: repoIdOf(p.repository ?? pr.base?.repo),
    fromFork: headId !== identity,
    fullName: fullNameOf(p.repository ?? pr.base?.repo),
  };
}


export interface InstallationEvent {
  action: "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted" | "repositories";
  id: string;
  login: string;
  accountType: "User" | "Organization";
  avatarUrl: string | null;
  repositorySelection: "all" | "selected";
}

export function parseInstallationEvent(event: string, payload: unknown): InstallationEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as {
    action?: unknown;
    installation?: {
      id?: unknown;
      account?: { login?: unknown; type?: unknown; avatar_url?: unknown } | null;
      repository_selection?: unknown;
    } | null;
  };
  const i = p.installation;
  if (!i || typeof i.id !== "number" || typeof i.account?.login !== "string") return null;
  let action: InstallationEvent["action"];
  if (event === "installation_repositories") action = "repositories";
  else if (event === "installation" && typeof p.action === "string" && ["created", "deleted", "suspend", "unsuspend", "new_permissions_accepted"].includes(p.action)) {
    action = p.action as InstallationEvent["action"];
  } else return null;
  return {
    action,
    id: String(i.id),
    login: i.account.login,
    accountType: i.account.type === "Organization" ? "Organization" : "User",
    avatarUrl: typeof i.account.avatar_url === "string" ? i.account.avatar_url : null,
    repositorySelection: i.repository_selection === "selected" ? "selected" : "all",
  };
}

export function manageUrl(accountType: string, login: string, installationId: string): string {
  return accountType === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(login)}/settings/installations/${installationId}`
    : `https://github.com/settings/installations/${installationId}`;
}
