/* What the shell decides from two overview snapshots, kept free of React so it can be tested. */

const stamp = (iso: string) => Date.parse(iso) || 0;

/** True when the polled snapshot is at least as new as the one the layout rendered with. */
export const isNewer = (polledAt: string, servedAt: string) => stamp(polledAt) >= stamp(servedAt);

export interface ShellFacts {
  projects: ReadonlyArray<{ slug: string }>;
  apps: ReadonlyArray<{ id: string }>;
  inFlight: number;
}

const members = (s: ShellFacts) => [...s.projects.map((p) => `p:${p.slug}`), ...s.apps.map((a) => `a:${a.id}`)].sort().join(" ");

// A project or app that came or went needs the icon map read `now`. A build that ended needs it
// `again` on the next snapshot too: the worker fetches the favicon just after the deploy.
export function iconsStale(prev: ShellFacts, next: ShellFacts): { now: boolean; again: boolean } {
  const ended = next.inFlight < prev.inFlight;
  return { now: ended || members(prev) !== members(next), again: ended };
}
