/**
 * Pure pieces of the observe api: metric bucketing, alert rule validation and spelling, status page
 * day states and incident whitelisting, log cursors. No I/O, so each is unit tested directly.
 */
import { badField } from "../../errors.ts";

// ------------------------------------------------------------------ metrics

export type Range = "1h" | "24h" | "7d";
export type Resolution = "raw" | "five_min" | "hour";

export const RANGES: Record<Range, { ms: number; bucketMs: number; resolution: Resolution; tail: Resolution | null }> = {
  "1h": { ms: 3_600_000, bucketMs: 60_000, resolution: "raw", tail: null },
  "24h": { ms: 86_400_000, bucketMs: 300_000, resolution: "five_min", tail: "raw" },
  "7d": { ms: 7 * 86_400_000, bucketMs: 3_600_000, resolution: "hour", tail: "five_min" },
};

export interface Sample {
  at: Date;
  cpuPct: number;
  memoryBytes: bigint | number;
  pids: number | null;
  restarts: number | null;
  netRxBytes: bigint | number | null;
  netTxBytes: bigint | number | null;
}

export interface Bucket {
  at: number;
  cpuPct: number;
  memoryBytes: number;
  pids: number | null;
  restarts: number | null;
  /** Cumulative counters: the highest reading inside the bucket. */
  netRx: number | null;
  netTx: number | null;
}

const n = (v: bigint | number | null): number | null => (v === null ? null : Number(v));
const maxOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/** Groups samples into fixed buckets: averages for gauges, maxima for cumulative counters. */
export function bucketize(samples: Sample[], bucketMs: number): Bucket[] {
  const groups = new Map<number, { sum: Bucket; count: number }>();
  for (const s of samples) {
    const at = Math.floor(s.at.getTime() / bucketMs) * bucketMs;
    const g = groups.get(at);
    if (!g) {
      groups.set(at, {
        sum: { at, cpuPct: s.cpuPct, memoryBytes: Number(s.memoryBytes), pids: s.pids, restarts: s.restarts, netRx: n(s.netRxBytes), netTx: n(s.netTxBytes) },
        count: 1,
      });
      continue;
    }
    g.count++;
    g.sum.cpuPct += s.cpuPct;
    g.sum.memoryBytes += Number(s.memoryBytes);
    g.sum.pids = maxOf(g.sum.pids, s.pids);
    g.sum.restarts = maxOf(g.sum.restarts, s.restarts);
    g.sum.netRx = maxOf(g.sum.netRx, n(s.netRxBytes));
    g.sum.netTx = maxOf(g.sum.netTx, n(s.netTxBytes));
  }
  return [...groups.values()]
    .sort((a, b) => a.sum.at - b.sum.at)
    .map(({ sum, count }) => ({ ...sum, cpuPct: sum.cpuPct / count, memoryBytes: Math.round(sum.memoryBytes / count) }));
}

/** Rate of a cumulative counter between two points; a reset or a gap reads as zero, never negative. */
export function rate(prev: number | null | undefined, now: number | null, seconds: number): number {
  if (prev === null || prev === undefined || now === null || seconds <= 0) return 0;
  const d = now - prev;
  return d > 0 ? d / seconds : 0;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;

export interface AppPoint {
  at: string;
  cpuPct: number;
  memoryBytes: number;
  netInBps: number;
  netOutBps: number;
  restarts: number;
}

/** App chart points: rates from counter deltas, restarts as the increase since the last point. */
export function appPoints(buckets: Bucket[]): { points: AppPoint[]; lastRestartAt: string | null } {
  let lastRestartAt: string | null = null;
  const points = buckets.map((b, i) => {
    const prev = buckets[i - 1];
    const secs = prev ? (b.at - prev.at) / 1000 : 0;
    const restarts = prev && prev.restarts !== null && b.restarts !== null && b.restarts > prev.restarts ? b.restarts - prev.restarts : 0;
    const at = new Date(b.at).toISOString();
    if (restarts > 0) lastRestartAt = at;
    return {
      at,
      cpuPct: r1(b.cpuPct),
      memoryBytes: b.memoryBytes,
      netInBps: Math.round(rate(prev?.netRx, b.netRx, secs)),
      netOutBps: Math.round(rate(prev?.netTx, b.netTx, secs)),
      restarts,
    };
  });
  return { points, lastRestartAt };
}

// ------------------------------------------------------------------ alert rules

export type DbMetric = "disk" | "service" | "down" | "crash_loop" | "memory";
export type ApiMetric = "disk" | "service" | "down" | "crashLoop" | "memory";

export const TO_DB_METRIC: Record<ApiMetric, DbMetric> = {
  disk: "disk", service: "service", down: "down", crashLoop: "crash_loop", memory: "memory",
};
export const TO_API_METRIC: Record<DbMetric, ApiMetric> = {
  disk: "disk", service: "service", down: "down", crash_loop: "crashLoop", memory: "memory",
};

export type RuleChannel = "email" | "bell";

export interface RuleInput {
  metric: ApiMetric;
  appId: string | null;
  service: "any" | "api" | "worker" | "proxy" | "database" | null;
  threshold: number | null;
  durationMin: number;
  channels: RuleChannel[];
  /** Webhook ids. Left out: none on a create, unchanged on a patch. */
  webhooks?: string[];
  enabled: boolean;
}

export interface ValidRule extends Omit<RuleInput, "channels" | "webhooks"> {
  channels: RuleChannel[];
  webhooks: string[] | undefined;
}

/**
 * Cross-field rules zod cannot express. Returns the rule normalized: channels and webhooks
 * deduped. Whether a rule with nowhere to send gets the bell is decided once its webhooks are known (withBell).
 */
export function validateRule(r: RuleInput): ValidRule {
  if (r.metric === "service") {
    if (!r.service) throw badField("Pick the service this rule watches", "service");
    if (r.appId) throw badField("A service rule does not take an app", "appId");
  } else if (r.service) {
    throw badField("Only service rules take a service", "service");
  }
  if (r.metric === "disk" && r.appId) throw badField("Disk rules watch the server, not an app", "appId");
  if (r.threshold !== null) {
    if ((r.metric === "disk" || r.metric === "memory") && (r.threshold <= 0 || r.threshold > 100)) {
      throw badField("Use a percentage between 1 and 100", "threshold");
    }
    if (r.metric === "crashLoop" && (!Number.isInteger(r.threshold) || r.threshold < 1 || r.threshold > 1000)) {
      throw badField("Use a whole number of restarts between 1 and 1000", "threshold");
    }
    if (r.metric === "down" || r.metric === "service") throw badField("This rule has no threshold", "threshold");
  }
  return {
    metric: r.metric, appId: r.appId, service: r.service, threshold: r.threshold, durationMin: r.durationMin, enabled: r.enabled,
    channels: [...new Set(r.channels)],
    webhooks: r.webhooks ? [...new Set(r.webhooks)] : undefined,
  };
}

/** A rule that sends nowhere outside still shows in the bell, which a new rule gets by default. */
export const withBell = (channels: RuleChannel[], webhooks: readonly string[]): RuleChannel[] => (channels.length || webhooks.length ? channels : ["bell"]);

// ------------------------------------------------------------------ status page

export type DayState = "ok" | "minor" | "major" | "none";
export type CompState = "operational" | "degraded" | "outage";

export function dayState(d: { downMinutes: number; degradedMinutes: number; sampledMinutes: number } | undefined): DayState {
  if (!d || d.sampledMinutes === 0) return "none";
  if (d.downMinutes >= 30) return "major";
  if (d.downMinutes > 0 || d.degradedMinutes >= 15) return "minor";
  return "ok";
}

const RANK: Record<CompState, number> = { operational: 0, degraded: 1, outage: 2 };
export const worst = (states: CompState[]): CompState =>
  states.reduce<CompState>((a, b) => (RANK[b] > RANK[a] ? b : a), "operational");

/** The last `days` UTC dates, oldest first, as YYYY-MM-DD. */
export function lastDays(days: number, now: number): string[] {
  const today = Math.floor(now / 86_400_000) * 86_400_000;
  return Array.from({ length: days }, (_, i) => new Date(today - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

// ------------------------------------------------------------------ calendar days in a time zone

const DAY_MS = 86_400_000;
const wallClocks = new Map<string, Intl.DateTimeFormat>();

/** A cached reader of the wall clock in `zone`. Throws a RangeError for a zone this runtime does not know. */
function wallClock(zone: string): Intl.DateTimeFormat {
  let f = wallClocks.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    wallClocks.set(zone, f);
  }
  return f;
}

/** True for an IANA zone name this runtime can read. Anything else, a typo or a forged query, is refused. */
export function isZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone || zone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(zone)) return false;
  try {
    wallClock(zone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone the deploy trend counts its days in: the viewer's saved zone, else the one their browser
 * sent, else UTC. It is the zone the dashboard's own day headings use, so "Deploys today", the
 * heatmap's today and the "Today" group of the deployment list all mean the same calendar day.
 */
export function trendZone(saved: string | null | undefined, requested: string | null | undefined): string {
  if (isZone(saved)) return saved;
  if (isZone(requested)) return requested;
  return "UTC";
}

/** `t` as the wall clock in `zone` shows it, read back as if that clock were UTC. The difference is the zone's offset at `t`. */
function wallTime(t: number, zone: string): number {
  if (zone === "UTC") return t;
  const p = Object.fromEntries(wallClock(zone).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const ms = t - Math.floor(t / 1000) * 1000;
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)) + ms;
}

/** The calendar day `t` falls on in `zone`, as YYYY-MM-DD. */
export function dayIn(t: number, zone = "UTC"): string {
  return new Date(wallTime(t, zone)).toISOString().slice(0, 10);
}

/**
 * The first instant of `day` (YYYY-MM-DD) in `zone`. The offset read at the day's wall-clock
 * midnight is wrong only near a clock change, so a second read at the first answer settles it.
 * A change that skips midnight itself leaves that answer on the evening before; the day then
 * starts at the jump, which is the rest of that evening later.
 */
export function dayStartIn(day: string, zone = "UTC"): number {
  const wall = Date.parse(`${day}T00:00:00Z`);
  const first = wall - (wallTime(wall, zone) - wall);
  const t = wall - (wallTime(first, zone) - first);
  const on = dayIn(t, zone);
  if (on === day) return t;
  return t + DAY_MS - (wallTime(t, zone) - Date.parse(`${on}T00:00:00Z`));
}

/** The dashboard compares the last 30 days with the 30 before, so the trend reaches back this far. */
const TREND_MIN_DAYS = 60;

/**
 * The first day of the deploy trend in `zone`, as YYYY-MM-DD: Jan 1 of the year today falls in, or
 * 59 days before today when that is earlier (January and February). Without that reach back both
 * 30 day windows would start at Jan 1 early in the year and report made-up changes.
 */
function trendFirstDay(now: number, zone: string): string {
  const today = Date.parse(`${dayIn(now, zone)}T00:00:00Z`);
  const jan1 = Date.UTC(new Date(today).getUTCFullYear(), 0, 1);
  return new Date(Math.min(jan1, today - (TREND_MIN_DAYS - 1) * DAY_MS)).toISOString().slice(0, 10);
}

/** The first instant of the deploy trend in `zone`, as a timestamp, which is where its query starts. */
export function trendStart(now: number, zone = "UTC"): number {
  return dayStartIn(trendFirstDay(now, zone), zone);
}

/**
 * The deploy trend's days in `zone`, oldest first, as YYYY-MM-DD: every day from its first day
 * through Dec 31 of the year today falls in there. The heatmap shows that calendar year; early in
 * the year the days before it are there for the 30 day comparisons.
 */
export function trendDays(now: number, zone = "UTC"): string[] {
  const end = Date.UTC(Number(dayIn(now, zone).slice(0, 4)) + 1, 0, 1);
  const out: string[] = [];
  for (let t = Date.parse(`${trendFirstDay(now, zone)}T00:00:00Z`); t < end; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

const INCIDENT_STATUS = new Set(["investigating", "identified", "monitoring", "resolved"]);
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";

/** Only well-formed { at, status, body } updates leave the api; anything else in the JSON is dropped. */
export function incidentUpdates(raw: unknown): Array<{ at: string; status: IncidentStatus; body: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ at: string; status: IncidentStatus; body: string }> = [];
  for (const u of raw.slice(0, 100)) {
    if (!u || typeof u !== "object") continue;
    const { at, status, body } = u as Record<string, unknown>;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at)) || typeof status !== "string" || !INCIDENT_STATUS.has(status) || typeof body !== "string") continue;
    out.push({ at: new Date(at).toISOString(), status: status as IncidentStatus, body: body.slice(0, 5000) });
  }
  return out;
}

export function safeLogoUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ logs

export const LEVELS = ["error", "warn", "info", "debug"] as const;
export type Level = (typeof LEVELS)[number];
/** A level filter means "this level and more severe". */
export const levelsAtLeast = (l: Level): Level[] => LEVELS.slice(0, LEVELS.indexOf(l) + 1);

export function parseLogCursor(c: string | undefined): bigint | null {
  if (!c) return null;
  if (!/^\d{1,19}$/.test(c)) throw badField("Not a valid cursor", "cursor");
  return BigInt(c);
}

/** ILIKE pattern for a plain substring: the wildcards a user typed match literally. */
export const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
