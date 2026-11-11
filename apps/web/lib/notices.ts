import type { Notice } from "./derive";

/** A notice with no time is a live state (an app that is stopped right now), so it reads as current. */
const stamp = (n: Notice) => (n.at ? Date.parse(n.at) || 0 : Number.POSITIVE_INFINITY);

/** Problems, then results, each newest first. Where a notice came from never decides its place. */
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

/** `before` is the list shown last, null on the first after a load. Only ids seen leaving the list are
 * forgotten: one never listed was read in another tab. The first list also drops ids no longer listed. */
export function keepSeen(seen: Iterable<string>, before: ReadonlySet<string> | null, live: ReadonlySet<string>): string[] {
  return [...seen].filter((id) => live.has(id) || (before !== null && !before.has(id)));
}
