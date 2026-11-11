/** Who wrote a deployment's commit, as GitHub knows them. Best effort: never fails a deploy, and nothing here logs. */
import { githubAvatarUrl } from "@dockify/contracts";
import type { Db, SecretVault } from "@dockify/db";
import { installationCredential } from "./github.ts";

const LOOKUP_TIMEOUT_MS = 5_000;

const GITHUB_REPO = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;
const SHA = /^[0-9a-f]{40}$/;
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/** A login means an account: `avatarUrl` is its picture. Without one, `name` is the commit's git name. */
export type CommitAuthor = { login: string; avatarUrl: string | null; name: null } | { login: null; avatarUrl: null; name: string };

export function parseCommitAuthor(body: unknown, sha: string): CommitAuthor | null {
  const c = (Array.isArray(body) ? body[0] : null) as { sha?: unknown; author?: { login?: unknown; avatar_url?: unknown } | null; commit?: { author?: { name?: unknown } | null } | null } | null;
  // The list starts at the commit asked for; anything else is not an answer about it.
  if (!c || c.sha !== sha) return null;
  const login = c.author?.login;
  if (typeof login === "string" && GITHUB_LOGIN.test(login)) return { login: login.toLowerCase(), avatarUrl: githubAvatarUrl(c.author?.avatar_url), name: null };
  const raw = c.commit?.author?.name;
  // Anyone can commit under any name: one line of printable text at most.
  const name = typeof raw === "string" ? raw.replace(/[\p{C}]+/gu, " ").trim().slice(0, 100) : "";
  return name ? { login: null, avatarUrl: null, name } : null;
}

export interface CommitAuthorDeps {
  db: Db;
  vault: SecretVault;
  apiBase: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The list form, since the single commit's answer carries every changed file. Anonymous for a public repository. */
async function lookup(deps: CommitAuthorDeps, repoUrl: string, sha: string, installationId: bigint | null, timeoutMs: number): Promise<CommitAuthor | null> {
  const m = GITHUB_REPO.exec(repoUrl);
  if (!m || !SHA.test(sha)) return null;
  const credential = await installationCredential({ db: deps.db, vault: deps.vault, apiBase: deps.apiBase, ...(deps.fetch ? { fetch: deps.fetch } : {}) }, installationId, "github.com").catch(() => null);
  const res = await (deps.fetch ?? fetch)(`${deps.apiBase}/repos/${encodeURIComponent(m[1]!)}/${encodeURIComponent(m[2]!)}/commits?sha=${sha}&per_page=1`, {
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Dockify",
      ...(credential ? { Authorization: `Bearer ${credential.secret}` } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.ok ? parseCommitAuthor(await res.json(), sha) : null;
}

/** Never throws. On a git name the login stays: on a push it is the pusher, who still hears about a failure. */
export async function recordCommitAuthor(
  deps: CommitAuthorDeps,
  dep: { id: string; gitAuthor: string | null; gitAuthorAvatarUrl: string | null; gitAuthorName: string | null },
  repoUrl: string,
  sha: string,
  installationId: bigint | null,
): Promise<void> {
  if (dep.gitAuthorName || (dep.gitAuthor && dep.gitAuthorAvatarUrl)) return;
  const timeoutMs = deps.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  const work = (async () => {
    const author = await lookup(deps, repoUrl, sha, installationId, timeoutMs);
    if (!author) return;
    await deps.db.deployment.update({
      where: { id: dep.id },
      data: author.login ? { gitAuthor: author.login, gitAuthorAvatarUrl: author.avatarUrl, gitAuthorName: null } : { gitAuthorName: author.name },
    });
  })().catch(() => undefined);
  await Promise.race([work, expiry]);
  clearTimeout(timer);
}
