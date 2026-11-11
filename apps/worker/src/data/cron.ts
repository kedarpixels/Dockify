/**
 * Five-field cron in an IANA time zone. Pure, so the api and the worker agree. Day of week is 0 to 7 (both
 * Sunday). As in Vixie cron, when both day fields are restricted either one matching fires.
 */
import { isTimeZone } from "@dockify/contracts";

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

const BOUNDS: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(raw: string, lo: number, hi: number, label: string): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) throw new CronError(`cron ${label} field "${raw}" is not valid`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new CronError(`cron ${label} step must be at least 1`);
    let from = lo;
    let to = hi;
    if (m[1] !== "*") {
      const [a, b] = (m[1] ?? "").split("-");
      from = Number(a);
      to = b === undefined ? (m[2] === undefined ? from : hi) : Number(b);
    }
    if (from < lo || to > hi || from > to) throw new CronError(`cron ${label} field "${raw}" is out of range`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new CronError("cron needs exactly five fields");
  const labels = ["minute", "hour", "day", "month", "weekday"];
  const sets = fields.map((f, i) => parseField(f, BOUNDS[i]![0], BOUNDS[i]![1], labels[i]!));
  const weekdays = sets[4]!;
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return {
    minutes: sets[0]!,
    hours: sets[1]!,
    days: sets[2]!,
    months: sets[3]!,
    weekdays,
    dayRestricted: fields[2] !== "*",
    weekdayRestricted: fields[4] !== "*",
  };
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(at: Date, tz: string): WallClock {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(at)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: WEEKDAY[p.weekday ?? "Sun"] ?? 0,
  };
}

function dayMatches(s: CronSchedule, w: WallClock): boolean {
  const d = s.days.has(w.day);
  const wd = s.weekdays.has(w.weekday);
  if (s.dayRestricted && s.weekdayRestricted) return d || wd;
  if (s.dayRestricted) return d;
  if (s.weekdayRestricted) return wd;
  return true;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Far enough to cover "29 February on a Monday"-style expressions without looping forever. */
const HORIZON = 8 * 366 * 24 * HOUR;

/**
 * The first instant strictly after `from` whose wall clock in `tz` matches. A wall time skipped by a DST
 * jump does not fire that day; a repeated one fires once (the first).
 */
export function nextRun(expr: string | CronSchedule, tz: string, from: Date = new Date()): Date {
  const s = typeof expr === "string" ? parseCron(expr) : expr;
  if (!isTimeZone(tz)) throw new CronError(`time zone ${tz} is not known`);
  let t = Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE;
  const end = from.getTime() + HORIZON;
  while (t <= end) {
    const w = wallClock(new Date(t), tz);
    if (!s.months.has(w.month) || !dayMatches(s, w)) {
      // Toward the end of the local day, stopping an hour short so a DST jump cannot skip midnight.
      t += (Math.max(0, 22 - w.hour) * 60 + (60 - w.minute)) * MINUTE;
      continue;
    }
    if (!s.hours.has(w.hour)) {
      t += (60 - w.minute) * MINUTE;
      continue;
    }
    if (s.minutes.has(w.minute)) {
      // The second pass through a wall time repeated by a DST fall back does not fire again.
      const before = wallClock(new Date(t - HOUR), tz);
      const repeated = before.day === w.day && before.hour === w.hour && before.minute === w.minute;
      if (!repeated) return new Date(t);
    }
    t += MINUTE;
  }
  throw new CronError("cron expression never fires");
}
