/* Kept free of React so it can be tested. */

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

// Under a status filter a row leaves when its status moves on, so the fresh page replaces the
// stretch it covers; only older rows from "Load more" are kept. With no filter it is merged in.
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

/** More rows of the last loaded day may sit on the next page, so that group shows no count until it is whole. */
export const groupCount = (rows: number, last: boolean, more: boolean): number | undefined => (last && more ? undefined : rows);
