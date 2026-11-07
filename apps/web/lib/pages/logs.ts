import "server-only";
import { connection } from "next/server";
import {
  checkPattern,
  compile,
  isIso,
  isLevel,
  isStream,
  isToken,
  MAX_APPS,
  passes,
  querySearch,
  RETENTION_MS,
  type LogQuery,
  type LogStream,
  type RuntimeLogLine,
} from "@/components/logs/model";
import { buildPreviewOverview } from "@/lib/preview-fixture";
import { apiRequest, apiStream, plainError, UNREADABLE } from "@/lib/api";
import { json } from "@/lib/http";
import type { AppKind, OverviewSource, Resource } from "@/lib/types";
import { isPreviewMode } from "@/lib/preview-mode";
import { hex } from "@/lib/preview-random";

export type { LogQuery, RuntimeLogLine } from "@/components/logs/model";

/*
 * Runtime logs loader: every app's container output on this server. API contract for the backend
 * rebuild (every call forwards the session cookie, nothing is cached).
 *
 * Shared query parameters
 *   apps    comma separated app ids, at most 64. Absent means every app the viewer can see.
 *   q       free text, at most 200 characters, matched case-insensitively against the line text.
 *   regex   "1" makes q a regular expression. The API matches it with a linear time engine (RE2
 *           or similar) and answers 400 for a pattern it cannot run. It also refuses nested
 *           repeats and back references, the same rule as components/logs/model.ts checkPattern.
 *   stream  stdout or stderr; absent means both.
 *   level   error, warn, info or debug: the parsed level, else the rule in model.ts inferLevel.
 *
 *   from, to: ISO times; to absent means now. Retention is 7 days, so an older from is clamped.
 *   -> { lines: RuntimeLogLine[], nextCursor: string | null }
 *   The newest 500 matching lines at or before `to` (or before the cursor), oldest first.
 *   nextCursor asks for the 500 before those; null when nothing older matches inside the window.
 *
 *   text/event-stream of lines printed from now on (after `since`, a line id, when given; the
 *   Last-Event-ID header does the same on a reconnect and wins over since).
 *     event: lines   data: { "lines": RuntimeLogLine[] }   id: the last line's id
 *                    Batched, at most four a second, oldest first.
 *     event: gap     data: { "dropped": number }   lines skipped because the client fell behind
 *     event: ping    data: {}   every 15s, so proxies keep the connection open
 *   The server closes a stream after 30 minutes; the browser reconnects on its own.
 *   400 for a bad filter, 401 without a session.
 *
 * RuntimeLogLine: { id, ts, appId, stream: "stdout" | "stderr", level?: LogLevel | null, text }
 *   id is opaque, unique, URL safe and at most 128 characters. It is the line permalink: the UI
 *   links to /logs?apps=<appId>&from&to#L-<id>, a window around the line's ts.
 */

// -------------- Types --------------

export interface LogPage {
  lines: RuntimeLogLine[];
  nextCursor: string | null;
}

export interface LogsResult {
  source: OverviewSource;
  data: LogPage | null;
  error?: string;
  fetchedAt: string;
}

/** Lines in one history page. */
const PAGE = 500;

type Parsed = { ok: true; query: LogQuery; since?: string } | { ok: false; error: string };

/**
 * Strict validation of a proxy request: anything malformed is refused before the API sees it.
 * `from` is required for history and ignored by the stream.
 */
export function parseLogQuery(p: URLSearchParams, { stream = false }: { stream?: boolean } = {}): Parsed {
  const apps = (p.get("apps") ?? "").split(",").filter(Boolean);
  if (apps.length > MAX_APPS || apps.some((a) => !isToken(a))) return { ok: false, error: "Invalid apps" };

  const now = Date.now();
  const rawFrom = p.get("from");
  const rawTo = p.get("to");
  if (!stream && !rawFrom) return { ok: false, error: "from is required" };
  if ((rawFrom && !isIso(rawFrom)) || (rawTo && !isIso(rawTo))) return { ok: false, error: "from and to must be ISO times" };
  const from = rawFrom ? new Date(Math.max(Date.parse(rawFrom), now - RETENTION_MS)).toISOString() : new Date(now).toISOString();
  const to = rawTo ? new Date(rawTo).toISOString() : undefined;
  if (to && Date.parse(to) <= Date.parse(from)) return { ok: false, error: "to must be after from" };

  const q = p.get("q") ?? "";
  const regex = p.get("regex") === "1";
  const bad = checkPattern(q, regex);
  if (bad) return { ok: false, error: bad };

  const s = p.get("stream");
  const l = p.get("level");
  if ((s !== null && !isStream(s)) || (l !== null && !isLevel(l))) return { ok: false, error: "Invalid stream or level" };

  const cursor = p.get("cursor");
  const since = p.get("since") ?? undefined;
  if ((cursor && !isToken(cursor)) || (since && !isToken(since))) return { ok: false, error: "Invalid cursor" };

  return {
    ok: true,
    query: { apps: [...new Set(apps)], from, to, q: q || undefined, regex: regex && !!q, stream: s ?? undefined, level: l ?? undefined, cursor },
    since,
  };
}

// -------------- API --------------

/** One GET to the Dockify API (lib/api.ts) with the viewer's cookie, never cached, always bounded. */
async function api<T>(path: string, search: URLSearchParams): Promise<{ ok: true; body: T } | { ok: false; status: number; error: string }> {
  const r = await apiRequest<T>(`${path}?${search.toString()}`);
  if (!r.ok) return { ok: false, status: r.status, error: r.status === 400 ? "The API refused this filter" : plainError(r) };
  return r.data === null ? { ok: false, status: 502, error: UNREADABLE } : { ok: true, body: r.data };
}

/** One history page of runtime logs. */
export async function getLogs(query: LogQuery): Promise<LogsResult> {
  await connection();
  const fetchedAt = new Date().toISOString();

  if (process.env.DOCKIFY_API_URL) {
    const res = await api<LogPage>("/api/v1/logs", querySearch(query, { from: query.from, to: query.to, cursor: query.cursor }));
    if (!res.ok) return { source: "api", data: null, error: res.error, fetchedAt };
    return { source: "api", data: { lines: res.body.lines ?? [], nextCursor: res.body.nextCursor ?? null }, fetchedAt };
  }

  // Design preview only. Never set in a deployed build: production must always read the API.
  if (isPreviewMode()) return { source: "preview", data: previewPage(query, Date.now()), fetchedAt };

  return { source: "none", data: null, fetchedAt };
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/**
 * The live tail. With an API it pipes the upstream event stream through untouched, forwarding the
 * cookie and Last-Event-ID; `signal` (the browser's request) closes the upstream when the tab goes.
 */
export async function openLogStream(query: LogQuery, since: string | undefined, lastEventId: string | null, signal: AbortSignal): Promise<Response> {
  if (process.env.DOCKIFY_API_URL) {
    // The timeout covers the wait for the stream to open; the stream itself runs until the tab goes.
    const r = await apiStream(`/api/v1/logs/stream?${querySearch(query, { since }).toString()}`, {
      accept: "text/event-stream",
      signal,
      headers: lastEventId && isToken(lastEventId) ? { "last-event-id": lastEventId } : undefined,
    });
    if (!r.ok) return json({ error: plainError(r) }, r.status === 400 || r.status === 401 ? r.status : 502);
    return new Response(r.res.body, { headers: SSE_HEADERS });
  }
  if (isPreviewMode()) return new Response(previewStream(query, lastEventId ?? since, signal), { headers: SSE_HEADERS });
  return json({ error: "No data source" }, 503);
}

// -------------- Preview --------------

/*
 * Preview lines are a pure function of (app, minute): every minute of every running app has its own
 * seeded generator, so history pages, the live tail and a permalink opened later all agree. Line
 * ids carry the time in base 36, so the preview can read a cursor back into a moment.
 */

type Rnd = () => number;
type Voice = [stream: LogStream, weight: number, make: (r: Rnd) => string | string[]];

const pick = <T,>(r: Rnd, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
const ms = (r: Rnd, lo: number, hi: number) => Math.round(lo + r() * (hi - lo));
const VOICES: Record<AppKind, Voice[]> = {
  frontend: [
    ["stdout", 8, (r) => `GET ${pick(r, ["/", "/leaderboard", "/partners", "/rewards", "/faq", "/profile"])} 200 in ${ms(r, 8, 140)}ms`],
    ["stdout", 4, (r) => `GET /api/session 200 in ${ms(r, 3, 30)}ms`],
    ["stdout", 2, (r) => `GET /_next/image?w=${pick(r, [64, 128, 256])} 200 in ${ms(r, 2, 40)}ms`],
    ["stdout", 1, (r) => `GET ${pick(r, ["/admin", "/wp-login.php", "/.env"])} 404 in ${ms(r, 1, 9)}ms`],
    ["stderr", 1, (r) => `Warning: revalidate took ${ms(r, 900, 2400)}ms for /partners`],
    ["stderr", 0.4, () => [
      "Error: fetch failed",
      "    at async getLeaderboard (.next/server/app/leaderboard/page.js:1:2210)",
      "    at async Page (.next/server/app/leaderboard/page.js:1:3104)",
      "  cause: ECONNRESET",
    ]],
  ],
  backend: [
    ["stdout", 6, (r) => `{"level":"info","msg":"request","method":"GET","path":"${pick(r, ["/v1/leaderboard", "/v1/me", "/v1/partners", "/v1/rewards"])}","status":200,"ms":${ms(r, 2, 60)}}`],
    ["stdout", 3, (r) => `{"level":"info","msg":"request","method":"POST","path":"${pick(r, ["/v1/auth/session", "/v1/claims", "/v1/webhooks/discord"])}","status":${pick(r, [200, 200, 201, 204])},"ms":${ms(r, 6, 90)}}`],
    ["stdout", 2, () => `GET /health 200 1ms`],
    ["stdout", 1, (r) => `{"level":"debug","msg":"cache hit","key":"affiliate:stats:${hex(r, 6)}"}`],
    ["stdout", 1, (r) => `cron: refreshed affiliate stats in ${ms(r, 120, 900)}ms`],
    ["stderr", 0.8, (r) => `{"level":"warn","msg":"upstream slow","upstream":"partner-feed","ms":${ms(r, 1500, 4200)}}`],
    ["stderr", 0.3, (r) => `{"level":"error","msg":"request failed","path":"/v1/claims","status":500,"error":"deadlock detected","trace":"${hex(r, 16)}"}`],
  ],
  bot: [
    ["stdout", 4, (r) => `interaction /${pick(r, ["payout", "points", "leaderboard", "link"])} handled in ${ms(r, 40, 320)}ms`],
    ["stdout", 1, () => "heartbeat acknowledged, shard 0"],
    ["stdout", 1, (r) => `role sync: ${ms(r, 0, 4)} members updated`],
    ["stderr", 0.4, () => ["socket closed, reconnecting in 5s", "gateway resumed, replayed 3 events"]],
  ],
  postgres: [
    ["stdout", 3, (r) => `LOG:  checkpoint complete: wrote ${ms(r, 40, 900)} buffers (${(r() * 4).toFixed(1)}%); write=${(r() * 20).toFixed(3)} s`],
    ["stdout", 2, (r) => `LOG:  automatic vacuum of table "app.public.${pick(r, ["sessions", "claims", "events", "payouts"])}": index scans: 1`],
    ["stderr", 0.6, () => "LOG:  could not receive data from client: Connection reset by peer"],
    ["stderr", 0.3, (r) => `WARNING:  ${ms(r, 70, 96)}% of max_connections in use`],
  ],
  redis: [
    ["stdout", 3, (r) => `${ms(r, 1, 100)} changes in 300 seconds. Saving...`],
    ["stdout", 3, () => "Background saving terminated with success"],
    ["stdout", 1, (r) => `DB saved on disk, ${ms(r, 1, 9)} MB of memory used by copy-on-write`],
  ],
  s3: [
    ["stdout", 5, (r) => `PUT /${pick(r, ["avatars", "uploads", "exports"])}/${hex(r, 12)}.webp 200 ${ms(r, 4, 80)}ms`],
    ["stdout", 3, (r) => `GET /${pick(r, ["avatars", "uploads"])}/${hex(r, 12)}.webp 200 ${ms(r, 1, 20)}ms`],
    ["stderr", 0.3, () => "WARNING: Disk usage on /data crossed 70%"],
  ],
};

/** What only one project's apps print, mixed into their kind's voices. */
const EXTRAS: Record<string, Partial<Record<AppKind, Voice[]>>> = {
  horseai: {
    backend: [["stdout", 2, (r) => `payouts: exported ${ms(r, 3, 40)} partner rows`]],
    bot: [["stdout", 2, (r) => `payout status posted for ${ms(r, 1, 12)} partners`]],
  },
  inkwell: {
    backend: [
      ["stdout", 3, (r) => `raffle: settled round ${ms(r, 10_000, 99_999)} in ${ms(r, 30, 180)}ms`],
      ["stderr", 0.5, (r) => `discord bot: denied rewards for ${ms(r, 1, 3)} accounts without the role`],
    ],
  },
  brightlane: {
    backend: [
      ["stdout", 3, (r) => `scraper: Northwind board refreshed, ${ms(r, 40, 220)} rows`],
      ["stderr", 1.2, () => "scraper: Northwind answered 429, retrying in 15m"],
    ],
    postgres: [["stderr", 1.5, () => "FATAL:  sorry, too many clients already"]],
  },
  fieldnote: {
    backend: [
      ["stdout", 3, (r) => `boards: Contoso refresh took ${ms(r, 200, 1200)}ms`],
      ["stdout", 2, (r) => `challenges: ${ms(r, 0, 9)} completions recorded`],
    ],
  },
};

/** Average lines a minute, per kind. */
const RATE: Record<AppKind, number> = { frontend: 5, backend: 6, bot: 2, postgres: 1.2, redis: 0.8, s3: 1 };

/** mulberry32 over a mixed seed: fast, and good enough to look random. */
function rng(seed: number): Rnd {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PreviewApp {
  index: number;
  app: Resource;
  voices: Voice[];
  total: number;
  rate: number;
}

/** The fixture's apps that print anything here: a stopped app is silent, and Vercel keeps its own app's lines. */
function previewApps(now: number): PreviewApp[] {
  return buildPreviewOverview(new Date(now))
    .resources.map((app, index) => ({ app, index }))
    .filter(({ app }) => app.status !== "stopped" && !app.onVercel)
    .map(({ app, index }) => {
      const voices = [...VOICES[app.kind], ...(EXTRAS[app.projectSlug]?.[app.kind] ?? [])];
      const rate = RATE[app.kind] * (app.status === "degraded" ? 2 : 1) * (app.environment === "development" ? 0.5 : 1);
      return { index, app, voices, total: voices.reduce((s, v) => s + v[1], 0), rate };
    });
}

/** Every line one app printed in one minute, oldest first. */
function minuteLines(p: PreviewApp, minute: number): RuntimeLogLine[] {
  const r = rng(Math.imul(minute, 2654435761) ^ Math.imul(p.index + 1, 40503));
  const count = Math.floor(r() * (p.rate * 2 + 1));
  const out: RuntimeLogLine[] = [];
  for (let k = 0; k < count; k++) {
    let roll = r() * p.total;
    const voice = p.voices.find((v) => (roll -= v[1]) < 0) ?? p.voices[0]!;
    const at = minute * 60_000 + Math.floor(r() * 59_000);
    const made = voice[2](r);
    (Array.isArray(made) ? made : [made]).forEach((text, j) => {
      const ts = at + j;
      out.push({ id: `${ts.toString(36)}.${p.index}.${k}.${j}`, ts: new Date(ts).toISOString(), appId: p.app.id, stream: voice[0], text });
    });
  }
  return out;
}

/** The moment a preview id or cursor names: its first part is the time in base 36. */
const idTime = (id: string) => {
  const t = parseInt(id.split(".")[0] ?? "", 36);
  return Number.isFinite(t) ? t : NaN;
};

const order = (a: RuntimeLogLine, b: RuntimeLogLine) => Date.parse(a.ts) - Date.parse(b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The fixture's apps narrowed to the query, plus the line filter. */
function previewScope(q: LogQuery, now: number) {
  const all = previewApps(now);
  const apps = q.apps.length ? all.filter((p) => q.apps.includes(p.app.id)) : all;
  const re = compile(q.q ?? "", !!q.regex);
  const f = { stream: q.stream ?? "all", level: q.level ?? "all" } as const;
  return { apps, keep: (l: RuntimeLogLine) => passes(l, f, re) };
}

/** Walks back from `to` (or the cursor) a minute at a time until a page is full or the window ends. */
function previewPage(q: LogQuery, now: number): LogPage {
  const { apps, keep } = previewScope(q, now);
  const from = Math.max(Date.parse(q.from), now - RETENTION_MS);
  const before = q.cursor ? idTime(q.cursor) : Math.min(q.to ? Date.parse(q.to) : now, now) + 1;
  const found: RuntimeLogLine[] = [];
  let minute = Math.floor((before - 1) / 60_000);
  for (; minute >= Math.floor(from / 60_000) && found.length <= PAGE; minute--) {
    for (const p of apps) {
      for (const l of minuteLines(p, minute)) {
        const t = Date.parse(l.ts);
        if (t >= from && t < before && (!q.cursor || l.id !== q.cursor) && keep(l)) found.push(l);
      }
    }
  }
  found.sort(order);
  const lines = found.slice(-PAGE);
  const more = found.length > PAGE || minute >= Math.floor(from / 60_000);
  return { lines, nextCursor: more && lines.length ? lines[0]!.id : null };
}

/** The preview live tail: once a second, the lines the generator printed since the last tick. */
function previewStream(q: LogQuery, since: string | null | undefined, signal: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const opened = Date.now();
  const resume = since ? idTime(since) : NaN;
  // Resume where the client left off, but never replay more than five minutes.
  let last = Number.isFinite(resume) && resume > opened - 5 * 60_000 ? resume : opened;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pings = 0;
  const stop = () => clearInterval(timer);

  return new ReadableStream({
    start(ctrl) {
      const send = (s: string) => {
        try {
          ctrl.enqueue(enc.encode(s));
        } catch {
          stop();
        }
      };
      send("retry: 3000\n\n");
      const tick = () => {
        const now = Date.now();
        // A stream closes after 30 minutes; the browser reconnects with Last-Event-ID.
        if (signal.aborted || now - opened > 30 * 60_000) {
          stop();
          try {
            ctrl.close();
          } catch {
            // Already closed by the client going away.
          }
          return;
        }
        const { apps, keep } = previewScope(q, now);
        const lines: RuntimeLogLine[] = [];
        for (let m = Math.floor(last / 60_000); m <= Math.floor(now / 60_000); m++) {
          for (const p of apps) for (const l of minuteLines(p, m)) if (Date.parse(l.ts) > last && Date.parse(l.ts) <= now && keep(l)) lines.push(l);
        }
        last = now;
        if (lines.length) {
          lines.sort(order);
          send(`id: ${lines.at(-1)!.id}\nevent: lines\ndata: ${JSON.stringify({ lines })}\n\n`);
        } else if (++pings % 15 === 0) send("event: ping\ndata: {}\n\n");
      };
      timer = setInterval(tick, 1000);
      signal.addEventListener("abort", stop, { once: true });
    },
    cancel: stop,
  });
}
