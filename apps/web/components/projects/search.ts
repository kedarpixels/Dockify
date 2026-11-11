/** What the Projects search reads of a project: everything its card shows by name. */
interface Searchable {
  slug: string;
  name?: string;
  apps: ReadonlyArray<{ name: string; displayName?: string | null }>;
}

/** True when `q` (already trimmed and lower case) is in the project's name, its slug or one of its apps' names. */
export function matchesProject(p: Searchable, q: string): boolean {
  if (!q) return true;
  const has = (s: string | null | undefined) => Boolean(s && s.toLowerCase().includes(q));
  return has(p.name) || has(p.slug) || p.apps.some((a) => has(a.name) || has(a.displayName));
}
