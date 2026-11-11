import type { Notice } from "./derive";

/** A notice with no time is a live state (an app that is stopped right now), so it reads as current. */
const stamp = (n: Notice) => (n.at ? Date.parse(n.at) || 0 : Number.POSITIVE_INFINITY);

/**
 * The bell's order: problems, then results, each newest first by its own time. Where a notice came
 * from (an app, a deploy, Dockify's own updater) never decides its place, so a release published
 * days ago sits under this morning's deploys instead of above them. Equal times keep the order given.
 */
export function orderNotices(notices: Notice[]): Notice[] {
  const newestFirst = (kind: Notice["kind"]) =>
    notices
      .filter((n) => n.kind === kind)
      .sort((a, b) => {
        const x = stamp(a);
        const y = stamp(b);
        return x === y ? 0 : y > x ? 1 : -1;
      });
  return [...newestFirst("problem"), ...newestFirst("result")];
}

/**
 * The read ids to keep for the list a page now shows. `before` is the list it showed last, null on
 * the first one after a load.
 *
 * A page that already showed a list forgets only the ids it watched leave it, so a problem that
 * cleared and comes back is new. An id it never listed is kept: it was read in another tab that
 * holds a newer list (a hidden tab does not poll), and dropping it here would turn that tab's
 * notice unread again. The first list after a load is fresh from the server, so it also clears out
 * whatever is no longer listed, which is how ids read in a tab that has since closed go away.
 */
export function keepSeen(seen: Iterable<string>, before: ReadonlySet<string> | null, live: ReadonlySet<string>): string[] {
  return [...seen].filter((id) => live.has(id) || (before !== null && !before.has(id)));
}
