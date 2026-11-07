/*
 * The one rule for when a project talks about environments. The engine always has them (variables,
 * domains, an isolated network, the preview base), but a project with a single one shows none of it:
 * no tags, filters, selectors or columns. Each app shows its own branch instead. A second environment
 * brings all of it back; removing down to one hides it again.
 */

/** Whether a project with these environments shows them anywhere in the UI. */
export const showsEnvironments = (envs: readonly unknown[]) => envs.length > 1;

/** For a page that lists apps from several projects: which projects show their environments. */
export function projectsShowingEnvironments(apps: ReadonlyArray<{ projectSlug: string; environment: string }>) {
  const seen = new Map<string, Set<string>>();
  for (const a of apps) seen.set(a.projectSlug, (seen.get(a.projectSlug) ?? new Set()).add(a.environment));
  return (slug: string) => showsEnvironments([...(seen.get(slug) ?? [])]);
}
