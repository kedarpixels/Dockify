/* How the Deployments list takes a polled first page and counts its day groups, kept free of React
   so it can be tested. */

interface Row {
  id: string;
  createdAt: string;
}

const at = (d: Row) => Date.parse(d.createdAt) || 0;

/** Merges a fresh first page over what is shown: changed rows update, new rows go on top. */
export function merge<T extends Row>(shown: T[], fresh: T[]): T[] {
  const byId = new Map(fresh.map((d) => [d.id, d]));
  const known = new Set(shown.map((d) => d.id));
  return [...fresh.filter((d) => !known.has(d.id)), ...shown.map((d) => byId.get(d.id) ?? d)];
}

/**
 * What the list shows after a poll of its first page. With no status filter a row never leaves the
 * list, so the page is merged in. Under a status filter a row leaves when its status moves on (a
 * build that finished is no longer "Building"), so the fresh page replaces the stretch it covers:
 * only rows older than its last one, loaded by "Load more", are kept.
 */
export function refreshed<T extends Row>(
  shown: { items: T[]; next: string | null },
  fresh: { items: T[]; nextCursor: string | null },
  byStatus: boolean,
): { items: T[]; next: string | null } {
  if (!byStatus) {
    return { items: merge(shown.items, fresh.items), next: shown.items.length > fresh.items.length ? shown.next : fresh.nextCursor };
  }
  const edge = fresh.items.length ? at(fresh.items[fresh.items.length - 1]!) : Infinity;
  const got = new Set(fresh.items.map((d) => d.id));
  // No further page means the fresh one is the whole answer.
  const older = fresh.nextCursor === null ? [] : shown.items.filter((d) => !got.has(d.id) && at(d) < edge);
  return { items: [...fresh.items, ...older], next: older.length ? shown.next : fresh.nextCursor };
}

/**
 * The count a day group's head shows. More rows of the last loaded day may still sit on the next
 * page, so while there is one that group shows no count instead of one "Load more" would change.
 */
export const groupCount = (rows: number, last: boolean, more: boolean): number | undefined => (last && more ? undefined : rows);
