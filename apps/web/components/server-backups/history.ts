/** Pure pieces of the Backups page, kept free of React so tests/backups-page.test.mjs can import them. */

const DAY = 86_400_000;
export const HISTORY_DAYS = 30;

/** Whether a run is in the history's window. The API also sends older rows: files still kept and each database's newest run. */
export const inHistory = (r: { createdAt: string }, now: number) => now - Date.parse(r.createdAt) < HISTORY_DAYS * DAY;

/** Consecutive rows under one heading each. `heading` names a row's day; the history passes the UTC day. */
export function byDay<T extends { createdAt: string }>(rows: T[], heading: (iso: string) => string): Array<{ label: string; rows: T[] }> {
  const groups: Array<{ label: string; rows: T[] }> = [];
  for (const r of rows) {
    const label = heading(r.createdAt);
    if (groups.at(-1)?.label === label) groups.at(-1)!.rows.push(r);
    else groups.push({ label, rows: [r] });
  }
  return groups;
}

/** The databases a bulk run was meant to back up that it started nothing for. */
export function notStarted<S extends { resourceId: string }>(asked: S[], runs: Array<{ resourceId: string }>): S[] {
  const started = new Set(runs.map((r) => r.resourceId));
  return asked.filter((s) => !started.has(s.resourceId));
}
