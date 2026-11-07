import type { TimePrefs } from "./types";

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Whole seconds, never negative; NaN and Infinity read as 0 so nothing renders "NaN". */
const secs = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);

export function timeAgo(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

/** A running timer: "4:07", then "1:02:07" past the hour. */
export function clock(seconds: number): string {
  const s = Math.floor(secs(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A finished length, at most two units: "42s", "1m 38s", "2h 5m", "3d 4h". */
export function duration(seconds: number): string {
  const s = Math.round(secs(seconds));
  if (s < 60) return `${s}s`;
  const join = (a: number, ua: string, b: number, ub: string) => (b ? `${a}${ua} ${b}${ub}` : `${a}${ua}`);
  if (s < 3600) return join(Math.floor(s / 60), "m", s % 60, "s");
  if (s < 86_400) return join(Math.floor(s / 3600), "h", Math.floor((s % 3600) / 60), "m");
  return join(Math.floor(s / 86_400), "d", Math.floor((s % 86_400) / 3600), "h");
}

/** "3d 4h", "5h", or "12m" in the first hour. */
export function uptime(seconds: number): string {
  const s = Math.floor(secs(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  if (d) return `${d}d ${h}h`;
  return h ? `${h}h` : `${Math.floor(s / 60)}m`;
}

/** A YYYY-MM-DD string as a UTC Date, or null when it is not a real date. */
function utcDay(date: string): Date | null {
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * "Fri 16 Oct". Takes a calendar day ("2026-10-16") or a full ISO moment, which is read as its UTC
 * day so the server and the browser print the same label.
 */
export function dayLabel(date: string): string {
  const d = date.length > 10 ? new Date(date) : utcDay(date);
  if (!d || Number.isNaN(d.getTime())) return date;
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Group heading for a list split by day: "Today", "Yesterday", "Thursday 12 Oct", plus the year
 * when it is not the current one, with no comma. Pass the reader's time prefs once hydrated, so
 * "Yesterday" means yesterday where they are, the same day the row's own time shows; without them
 * (the server render) it is the UTC day, so server and first client render agree.
 */
export function dayHeading(iso: string, now: number, prefs?: TimePrefs): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const ymd = (ms: number): [number, number, number] => {
    const p = prefs ? timeParts(ms, { prefs }) : null;
    if (p) return [p.year, p.month, p.day];
    const d = new Date(ms);
    return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
  };
  const [y, m, d] = ymd(t);
  const [ny, nm, nd] = ymd(now);
  const diff = Math.round((Date.UTC(ny, nm, nd) - Date.UTC(y, m, d)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  const weekday = new Date(Date.UTC(y, m, d)).getUTCDay();
  return `${DAYS_LONG[weekday]} ${d} ${MONTHS[m]}${y === ny ? "" : ` ${y}`}`;
}

/**
 * A reason or an error as the start of a sentence: trimmed, with its own closing full stop
 * dropped, so `${clause(error)}. Try again in a moment.` ends on one stop whatever the text was.
 */
export function clause(s: string): string {
  return s.trim().replace(/[.\s]+$/, "");
}

/** A usage percentage: one decimal below 10% (so a light load is not "0%"), whole numbers above. */
export function usagePct(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "0%";
  return v < 10 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`;
}

/* ============== Absolute times ============== */

export const DEFAULT_TIME: TimePrefs = { timeZone: null, hour12: false };

/* The signed-in user's choice for code outside React (toasts). Components read it through
   useTimePrefs, so the server render and hydration agree; this copy is only ever set in the browser. */
let browserPrefs: TimePrefs = DEFAULT_TIME;

export function setBrowserTimePrefs(prefs: TimePrefs): void {
  if (typeof window !== "undefined") browserPrefs = prefs;
}

interface TimeOptions {
  /** Server-scheduled moments read UTC whatever the user picked. */
  utc?: boolean;
  /** The user's zone and clock; defaults to the browser copy. */
  prefs?: TimePrefs;
}

export interface TimeParts {
  year: number;
  /** 0 to 11. */
  month: number;
  day: number;
  /** 0 is Sunday. */
  weekday: number;
  hour: number;
  minute: number;
  second: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const zoneFormats = new Map<string, Intl.DateTimeFormat | null>();

function inZone(d: Date, zone: string): TimeParts | null {
  if (!zoneFormats.has(zone)) {
    try {
      zoneFormats.set(zone, new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", weekday: "short", hour: "numeric", minute: "numeric", second: "numeric" }));
    } catch {
      zoneFormats.set(zone, null);
    }
  }
  const f = zoneFormats.get(zone);
  if (!f) return null;
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month) - 1, day: Number(p.day), weekday: WEEKDAYS[p.weekday ?? ""] ?? 0, hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
}

/**
 * The calendar and clock fields of a moment. Which zone where:
 * - UTC (`utc`): anything the server schedules or groups by UTC day. Cron schedules, backup runs
 *   and their next run, the deploy heatmap and its day panel.
 * - Local: moments an operator lived through. Deployments, logs, activity, sessions, tokens,
 *   certificates, notifications. Local is the zone picked in Settings, Profile, else the browser's.
 *
 * Browser-local output differs between the server and the browser, so render it through `When`
 * (or only after mount, see `useHydrated`), never straight into server HTML.
 */
export function timeParts(at: string | number | Date, { utc = false, prefs = browserPrefs }: TimeOptions = {}): TimeParts | null {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  if (utc) return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), weekday: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
  const zoned = prefs.timeZone ? inZone(d, prefs.timeZone) : null;
  return zoned ?? { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), weekday: d.getDay(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "14:05" or "2:05 PM", with seconds when asked. */
function clockOf(p: TimeParts, hour12: boolean, seconds: boolean): string {
  const tail = seconds ? `:${pad2(p.second)}` : "";
  if (!hour12) return `${pad2(p.hour)}:${pad2(p.minute)}${tail}`;
  return `${p.hour % 12 || 12}:${pad2(p.minute)}${tail} ${p.hour < 12 ? "AM" : "PM"}`;
}

/** The time of day alone, in the user's clock: "14:05", "2:05 PM", "14:05:09". No zone suffix. */
export function clockTime(at: string | number | Date, { seconds = false, ...o }: TimeOptions & { seconds?: boolean } = {}): string {
  const p = timeParts(at, o);
  return p ? clockOf(p, (o.prefs ?? browserPrefs).hour12, seconds) : String(at);
}

/** A chart point in the user's clock: "14:05", or "Thu 14:05" when the chart spans days. */
export function chartTime(at: string | number | Date, { withDay = false, ...o }: TimeOptions & { withDay?: boolean } = {}): string {
  const p = timeParts(at, o);
  if (!p) return "";
  const c = clockOf(p, (o.prefs ?? browserPrefs).hour12, false);
  return withDay ? `${DAYS[p.weekday]} ${c}` : c;
}

/** The one absolute time format: "30 Oct 2026, 14:05", or "30 Oct 2026, 2:05 PM" on a 12-hour clock, plus " UTC" when `utc` is set. */
export function absTime(iso: string, o: TimeOptions = {}): string {
  const p = timeParts(iso, o);
  if (!p) return iso;
  return `${p.day} ${MONTHS[p.month]} ${p.year}, ${clockOf(p, (o.prefs ?? browserPrefs).hour12, false)}${o.utc ? " UTC" : ""}`;
}

export function monthShort(date: string): string {
  const d = utcDay(date);
  return d ? MONTHS[d.getUTCMonth()]! : "";
}

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** A size as its figure and unit, rounded the one way every size in the app is: see `bytes()`. */
function sizeParts(n: number): [figure: string, unit: string] {
  const v = Number.isFinite(n) ? Math.max(0, n) : 0;
  let i = 0;
  let x = v;
  // 1023.7 KB would round to "1,024 KB", so step up a unit once the rounded value gets there.
  while (Math.round(x) >= 1024 && i < SIZE_UNITS.length - 1) {
    x /= 1024;
    i++;
  }
  if (i === 0) return [String(Math.round(x)), "B"];
  return [x < 9.95 ? x.toFixed(1).replace(/\.0$/, "") : Math.round(x).toLocaleString("en-US"), SIZE_UNITS[i]!];
}

/**
 * The one size format: binary units, one decimal under 10 and whole numbers above: "512 B",
 * "4.2 KB", "340 MB", "1.2 GB", "18 GB", "1.5 TB". Negative, NaN and Infinity read as "0 B".
 */
export function bytes(n: number): string {
  const [figure, unit] = sizeParts(n);
  return `${figure} ${unit}`;
}

/**
 * Used of total, rounded as `bytes()` rounds, with the unit printed once when both share it:
 * "11 of 32 GB", "439 MB of 1 GB", "0 B of 20 GB".
 */
export function sizePair(used: number, total: number): string {
  const [a, ua] = sizeParts(used);
  const [b, ub] = sizeParts(total);
  return ua === ub ? `${a} of ${b} ${ub}` : `${a} ${ua} of ${b} ${ub}`;
}

/** "horseai / postgres, inkwell / chat-bot and 2 more", so a toast never grows with the list. */
export function firstNames(list: string[]) {
  if (list.length <= 2) return list.join(", ");
  return `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`;
}

/**
 * A count and its noun: "1 app", "3 apps", "2 replicas"; pass the plural when it is not the noun
 * plus "s": plural(n, "entry", "entries"). The one plural helper; never hand-roll `n === 1`.
 */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/* ============== datetime-local inputs ============== */

/** A moment as a datetime-local value ("2026-10-30T14:05") in the user's zone. */
export function zonedInputValue(ms: number, prefs: TimePrefs = browserPrefs): string {
  const p = timeParts(ms, { prefs });
  return p ? `${p.year}-${pad2(p.month + 1)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}` : "";
}

/** A datetime-local value read in the user's zone, as epoch ms; NaN when it does not parse. */
export function parseZonedInput(value: string, prefs: TimePrefs = browserPrefs): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return NaN;
  if (!prefs.timeZone) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // The zone's offset at that moment, found by reading the guess back; twice covers a DST edge.
  let at = wall;
  for (let i = 0; i < 2; i++) {
    const p = timeParts(at, { prefs });
    if (!p) return NaN;
    at = wall - (Date.UTC(p.year, p.month, p.day, p.hour, p.minute) - at);
  }
  return at;
}
