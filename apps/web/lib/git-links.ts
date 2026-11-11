/* Only a github.com repository with a valid owner and name links; anything else yields null, so
   callers render plain text instead of a broken link. */

export interface GitHubRepo {
  owner: string;
  name: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{7,40}$/i;
const SOURCE = /^(?:(?:https?:\/\/|git\+https:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?$/i;
const BRANCH_SEGMENT = /^[^\s~^:?*[\\\x00-\x1f\x7f]+$/;

/** The GitHub repository a source URL points at, such as https://github.com/owner/repo. */
export function githubRepo(source: string | null | undefined): GitHubRepo | null {
  const m = source ? SOURCE.exec(source.trim()) : null;
  if (!m) return null;
  const [, owner = "", name = ""] = m;
  return OWNER.test(owner) && NAME.test(name) ? { owner, name } : null;
}

export const repoLabel = (r: GitHubRepo) => `${r.owner}/${r.name}`;

export const repoHref = (r: GitHubRepo | null) => (r ? `https://github.com/${r.owner}/${r.name}` : null);

export function commitHref(r: GitHubRepo | null, sha: string | null | undefined) {
  return r && sha && SHA.test(sha) ? `${repoHref(r)}/commit/${sha.toLowerCase()}` : null;
}

/** Each path segment is encoded, so feat/login stays a readable path on GitHub. */
export function branchHref(r: GitHubRepo | null, branch: string | null | undefined) {
  if (!r || !branch || branch.length > 255) return null;
  const parts = branch.split("/");
  if (!parts.every((p) => BRANCH_SEGMENT.test(p) && p !== "." && p !== "..")) return null;
  return `${repoHref(r)}/tree/${parts.map(encodeURIComponent).join("/")}`;
}

export function pullHref(r: GitHubRepo | null, pr: number) {
  return r && Number.isSafeInteger(pr) && pr > 0 ? `${repoHref(r)}/pull/${pr}` : null;
}

/** Rows from an API that does not send `repo` borrow the project's repository. */
export function withRepo<T extends { repo?: string | null }>(rows: T[], url: string | null | undefined): T[] {
  return url ? rows.map((d) => (d.repo === undefined ? { ...d, repo: url } : d)) : rows;
}
