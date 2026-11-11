// A project with a single environment shows none of it: no tags, filters, selectors or columns.
// A second environment brings all of it back.

export const showsEnvironments = (envs: readonly unknown[]) => envs.length > 1;

/** For a page that lists apps from several projects: which projects show their environments. */
export function projectsShowingEnvironments(apps: ReadonlyArray<{ projectSlug: string; environment: string }>) {
  const seen = new Map<string, Set<string>>();
  for (const a of apps) seen.set(a.projectSlug, (seen.get(a.projectSlug) ?? new Set()).add(a.environment));
  return (slug: string) => showsEnvironments([...(seen.get(slug) ?? [])]);
}
