/*
 * The runtime log explorer's shared model: types, filters, level inference and search patterns.
 * Pure code only, so the client view, the loader and the route handlers all import it.
 */

export type LogStream = "stdout" | "stderr";
export type LogLevel = "error" | "warn" | "info" | "debug";
export type LogRange = "15m" | "1h" | "24h" | "7d" | "custom";

/** One line a container printed. */
export interface RuntimeLogLine {
  /** Opaque, unique and URL safe. It is the permalink and the stream's resume point. */
  id: string;
  ts: string;
  appId: string;
  stream: LogStream;
  /** The level the API parsed, when it could. The UI infers one when it is missing. */
  level?: LogLevel | null;
  text: string;
}

/** What the operator picked. `from` and `to` only matter for a custom range. */
export interface LogFilters {
  /** Empty means every app. */
  apps: string[];
  range: LogRange;
  from?: string;
  to?: string;
  q: string;
  regex: boolean;
  stream: LogStream | "all";
  level: LogLevel | "all";
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Logs are kept for 7 days; nothing older can be asked for. */
export const RETENTION_MS = 7 * DAY;
/** Longest search the API accepts. */
const MAX_Q = 200;
/** Most apps one query may name. */
export const MAX_APPS = 64;

const RANGE_MS: Record<Exclude<LogRange, "custom">, number> = {
  "15m": 15 * MINUTE,
  "1h": 60 * MINUTE,
  "24h": DAY,
  "7d": 7 * DAY,
};

export const RANGE_LABEL: Record<LogRange, string> = {
  "15m": "Last 15 minutes",
  "1h": "Last hour",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  custom: "Custom range",
};

const LEVELS: LogLevel[] = ["error", "warn", "info", "debug"];
const RANGES: LogRange[] = ["15m", "1h", "24h", "7d", "custom"];

export const isLevel = (v: unknown): v is LogLevel => typeof v === "string" && (LEVELS as string[]).includes(v);
export const isStream = (v: unknown): v is LogStream => v === "stdout" || v === "stderr";
const isRange = (v: unknown): v is LogRange => typeof v === "string" && (RANGES as string[]).includes(v);
/** App ids, line ids and cursors are short and URL safe; anything else is refused before the API. */
export const isToken = (v: string) => /^[\w.:~-]{1,128}$/.test(v);
export const isIso = (v: string) => v.length <= 40 && !Number.isNaN(Date.parse(v));

export const DEFAULT_FILTERS: LogFilters = { apps: [], range: "1h", q: "", regex: false, stream: "all", level: "all" };

/** The filters the page URL carries, with anything malformed dropped rather than refused. */
export function filtersFrom(get: (key: string) => string | undefined): LogFilters {
  const apps = (get("apps") ?? "").split(",").filter((a) => a && isToken(a)).slice(0, MAX_APPS);
  const from = get("from");
  const to = get("to");
  const custom = !!from && !!to && isIso(from) && isIso(to) && Date.parse(from) < Date.parse(to);
  const range = get("range");
  const stream = get("stream");
  const level = get("level");
  return {
    apps: [...new Set(apps)],
    range: custom ? "custom" : isRange(range) && range !== "custom" ? range : DEFAULT_FILTERS.range,
    from: custom ? new Date(from).toISOString() : undefined,
    to: custom ? new Date(to).toISOString() : undefined,
    q: (get("q") ?? "").slice(0, MAX_Q),
    regex: get("regex") === "1",
    stream: isStream(stream) ? stream : "all",
    level: isLevel(level) ? level : "all",
  };
}

/** The filters as page URL parameters, defaults left out. */
export function filtersSearch(f: LogFilters) {
  const p = new URLSearchParams();
  if (f.apps.length) p.set("apps", f.apps.join(","));
  if (f.range === "custom" && f.from && f.to) {
    p.set("from", f.from);
    p.set("to", f.to);
  } else if (f.range !== DEFAULT_FILTERS.range) p.set("range", f.range);
  if (f.q) p.set("q", f.q);
  if (f.regex && f.q) p.set("regex", "1");
  if (f.stream !== "all") p.set("stream", f.stream);
  if (f.level !== "all") p.set("level", f.level);
  return p;
}

/** The time window the filters cover at `now`. A relative range has no end: it runs to now. */
function windowOf(f: LogFilters, now: number): { from: string; to?: string } {
  if (f.range === "custom" && f.from && f.to) return { from: f.from, to: f.to };
  const span = RANGE_MS[f.range === "custom" ? "1h" : f.range];
  return { from: new Date(now - span).toISOString() };
}

/** What one history or stream request asks the API for. */
export interface LogQuery {
  apps: string[];
  from: string;
  to?: string;
  q?: string;
  regex?: boolean;
  stream?: LogStream;
  level?: LogLevel;
  cursor?: string | null;
}

/** The request the filters make at `now`, or null when the search cannot run. */
export function queryOf(f: LogFilters, now: number): LogQuery | null {
  if (checkPattern(f.q, f.regex)) return null;
  return {
    apps: f.apps,
    ...windowOf(f, now),
    q: f.q || undefined,
    regex: f.regex && !!f.q,
    stream: f.stream === "all" ? undefined : f.stream,
    level: f.level === "all" ? undefined : f.level,
  };
}

/** A query as URL parameters, for the same-origin routes and the API alike. */
export function querySearch(q: LogQuery, extra: Record<string, string | null | undefined> = {}) {
  const p = new URLSearchParams();
  const put = (k: string, v: string | null | undefined) => (v ? p.set(k, v) : undefined);
  put("apps", q.apps.join(","));
  put("q", q.q);
  put("regex", q.regex ? "1" : undefined);
  put("stream", q.stream);
  put("level", q.level);
  for (const [k, v] of Object.entries(extra)) put(k, v);
  return p;
}

/** A relative range keeps growing, so it can be tailed; a custom one is a fixed window. */
export const isLiveRange = (f: LogFilters) => f.range !== "custom";

/** Everything that changes which lines the server sends, as one comparable string. */
export const filterKey = (f: LogFilters) =>
  [f.apps.join(","), f.range, f.from ?? "", f.to ?? "", f.q, f.regex && f.q ? "re" : "", f.stream, f.level].join("|");

// -------------- Level --------------

const STRUCTURED = /"(?:level|severity|lvl)"\s*:\s*"(\w+)"|\blevel=(\w+)/i;
const LEADING = /^\W{0,3}(fatal|panic|crit(?:ical)?|error|err|warn(?:ing)?|notice|info|log|debug|trace)\b/i;
const ERRORISH = /\b(error|exception|fatal|panic|unhandled|failed|ECONNREFUSED|ETIMEDOUT|ECONNRESET)\b/i;
const WARNISH = /\b(warn|warning|deprecated|slow|retrying|timed out)\b/i;

function named(word: string): LogLevel | null {
  const w = word.toLowerCase();
  if (w === "fatal" || w === "panic" || w === "error" || w === "err" || w === "crit" || w === "critical") return "error";
  if (w.startsWith("warn")) return "warn";
  if (w === "info" || w === "notice" || w === "log") return "info";
  if (w === "debug" || w === "trace" || w === "verbose") return "debug";
  return null;
}

/** The level a line names with its own first word ("INFO server started"), or null when it names none. */
export function leadingLevel(text: string): LogLevel | null {
  const lead = LEADING.exec(text);
  return lead ? named(lead[1]!) : null;
}

/**
 * The level a line most likely has: a structured level field first, then a leading level word,
 * then error or warning vocabulary. A stderr line with none of these reads as an error, the way
 * most hosts show it. Build tools such as BuildKit print their normal progress on stderr, so the
 * build log turns that last rule off with `stderrIsError: false`.
 */
export function inferLevel(line: Pick<RuntimeLogLine, "stream" | "text">, { stderrIsError = true }: { stderrIsError?: boolean } = {}): LogLevel {
  const s = STRUCTURED.exec(line.text);
  const fromField = s ? named(s[1] ?? s[2] ?? "") : null;
  if (fromField) return fromField;
  const fromLead = leadingLevel(line.text);
  if (fromLead) return fromLead;
  if (ERRORISH.test(line.text)) return "error";
  if (WARNISH.test(line.text)) return "warn";
  return stderrIsError && line.stream === "stderr" ? "error" : "info";
}

export const levelOf = (l: RuntimeLogLine): LogLevel => l.level ?? inferLevel(l);

// -------------- Search --------------

const SPECIAL = /[.*+?^${}()|[\]\\]/g;
/** A repeat applied to a group that itself repeats, such as (a+)+: the classic catastrophic case. */
const NESTED = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;
const BACKREF = /\\[1-9]|\\k</;

/**
 * Why a search cannot run, or null when it can. Plain text always can. A regex is refused when it
 * does not compile, or when it has nested repeats or back references, which can make a matcher
 * run for minutes. The API applies the same rule and matches with a linear time engine.
 */
export function checkPattern(q: string, regex: boolean): string | null {
  if (q.length > MAX_Q) return `Search is longer than ${MAX_Q} characters`;
  if (!q || !regex) return null;
  if (NESTED.test(q) || BACKREF.test(q)) return "This pattern could run slowly. Remove nested repeats and back references";
  try {
    new RegExp(q, "i");
  } catch {
    return "Not a valid regular expression";
  }
  return null;
}

/** A case-insensitive global matcher for the search, or null when there is none or it cannot run. */
export function compile(q: string, regex: boolean): RegExp | null {
  if (!q || checkPattern(q, regex)) return null;
  return new RegExp(regex ? q : q.replace(SPECIAL, "\\$&"), "gi");
}

/** True when `re` matches `text`. Resets the global matcher first, so calls never share state. */
function hits(re: RegExp, text: string) {
  re.lastIndex = 0;
  return re.test(text);
}

/** The line passes the stream, level and search filters (the apps and time are the caller's). */
export function passes(line: RuntimeLogLine, f: Pick<LogFilters, "stream" | "level">, re: RegExp | null) {
  if (f.stream !== "all" && line.stream !== f.stream) return false;
  if (f.level !== "all" && levelOf(line) !== f.level) return false;
  return !re || hits(re, line.text);
}

/** Splits text into plain and matched parts for highlighting. Empty matches are skipped. */
export function splitHits(text: string, re: RegExp | null): Array<{ text: string; hit: boolean }> {
  if (!re) return [{ text, hit: false }];
  const out: Array<{ text: string; hit: boolean }> = [];
  re.lastIndex = 0;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    if (m.index > at) out.push({ text: text.slice(at, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out.length ? out : [{ text, hit: false }];
}

// -------------- Apps --------------

/** Identity colours (logs.css --lx-c0 to --lx-c7): blues and greys only, so red and amber keep meaning a status. */
const APP_COLORS = 8;

/** An app's colour slot from its place in the full app list, so it never changes with the filter. */
export function colorSlot(appId: string, order: string[]) {
  const i = order.indexOf(appId);
  return (i < 0 ? hashOf(appId) : i) % APP_COLORS;
}

function hashOf(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Terminal colour and cursor codes. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** The text without terminal colour codes, which containers often print and a page cannot show. */
export const cleanText = (text: string) => (text.includes("\u001b") ? text.replace(ANSI, "") : text);

/** One line as plain text, for Copy all and Download. */
export const plainLine = (l: RuntimeLogLine, app: string) => `${l.ts} ${app} ${l.stream === "stderr" ? "ERR" : "OUT"} ${cleanText(l.text)}`;
