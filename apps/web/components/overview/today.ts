/* "Today" for the deploy trend. The API counts the trend's days in one zone (the viewer's saved
   zone, else UTC) and names it in `trendZone`; the Deployments list groups by that same saved
   zone. Reading today as the UTC day instead put "Deployments today" and the heatmap's today cell
   on the wrong row for part of every day. */

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

/** The calendar day `now` falls on in `zone` (an IANA name) as YYYY-MM-DD; the UTC day when the zone is missing or unknown. */
export function dayIn(now: number, zone?: string | null): string {
  const f = zone && zone !== "UTC" ? formatOf(zone) : null;
  if (!f) return new Date(now).toISOString().slice(0, 10);
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
