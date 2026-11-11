export interface ParsedRepo {
  host: string;
  owner: string;
  repo: string;
  /** The clean form that gets sent, so the API never sees a copied /tree/main or query. */
  url: string;
}

/** Dockify clones over https only, so an ssh address gets its own message rather than a vague one. */
export const isSshRepoUrl = (raw: string) => /^(?:ssh:\/\/)?git@/i.test(raw.trim());

/** A browser URL copied from deeper in the repository (/tree/main, a query, a hash) still counts. An ssh address does not. */
export function parseRepo(raw: string): ParsedRepo | null {
  const v = raw.trim();
  const web = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:-\/)?(?:tree|blob|commits?|src)(?:\/.*)?)?\/?(?:[?#].*)?$/i.exec(v);
  if (!web) return null;
  const host = web[1]!.toLowerCase();
  const url = `https://${host}/${web[2]}/${web[3]}`;
  return url.length <= 300 ? { host, owner: web[2]!, repo: web[3]!, url } : null;
}
