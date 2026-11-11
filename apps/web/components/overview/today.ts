// The API counts the trend's days in one zone and names it in `trendZone`. Reading today as the
// UTC day would put "Deployments today" on the wrong row for part of every day.

const formats = new Map<string, Intl.DateTimeFormat | null>();

function formatOf(zone: string) {
  if (!formats.has(zone)) {
    try {
      formats.set(zone, new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }));
    } catch {
      formats.set(zone, null);
    }
  }
  return formats.get(zone) ?? null;
}

/** YYYY-MM-DD; the UTC day when the zone is missing or unknown. */
export function dayIn(now: number, zone?: string | null): string {
  const f = zone && zone !== "UTC" ? formatOf(zone) : null;
  if (!f) return new Date(now).toISOString().slice(0, 10);
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
