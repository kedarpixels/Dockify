interface Searchable {
  slug: string;
  name?: string;
  apps: ReadonlyArray<{ name: string; displayName?: string | null }>;
}

/** `q` must already be trimmed and lower case. */
export function matchesProject(p: Searchable, q: string): boolean {
  if (!q) return true;
  const has = (s: string | null | undefined) => Boolean(s && s.toLowerCase().includes(q));
  return has(p.name) || has(p.slug) || p.apps.some((a) => has(a.name) || has(a.displayName));
}
