/**
 * A Vercel deployment's logs, read live from Vercel with the stored token and redacted here, like
 * every other log the dashboard shows. Nothing is written to the database: Vercel keeps them.
 *
 *   Build logs    GET /v3/deployments/:id/events: a JSON page, or a stream with follow=1. Finished or
 *                 running alike; Vercel keeps them for as long as the deployment.
 *   Runtime logs  GET /v1/projects/:p/deployments/:d/runtime-logs: a stream only. Vercel documents no
 *                 way to page back, and a connection may end after a few minutes, so the tail is what
 *                 arrives in a short read and the stream reconnects on its own. Older lines stay in
 *                 Vercel's Logs tab, for as long as the plan keeps them (retentionNote).
 *
 * The token goes in an Authorization header to api.vercel.com only, through the guarded client. It
 * and the project's secret values are concealed from every line, in case a build prints them.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { OutboundError, createHttpClient, createStreamClient, type HttpClient, type StreamClient, type StreamEnd } from "@dockify/net-guard";
import { Redactor } from "@dockify/redact";
import type { Db } from "@dockify/db";
import type { Keyring } from "@dockify/crypto";
import { HttpError } from "../../errors.ts";
import type { Reauthorizer } from "../../reauth.ts";
import { loadEntries, loadScope } from "../projects/env-store.ts";
import { sseFrame } from "../deployments/mapping.ts";
import { configOf, findIntegration, openSecret } from "./store.ts";

const VERCEL_API = "https://api.vercel.com";

/** Replaced in tests, so nothing leaves the process. */
let clients: { http: HttpClient; stream: StreamClient } | null = null;
export const setVercelLogClients = (c: { http: HttpClient; stream: StreamClient } | null): void => {
  clients = c;
};
const client = () => (clients ??= { http: createHttpClient(), stream: createStreamClient() });

// ------------------------------------------------------------------ lines

export interface BuildLine {
  ts: string;
  stream: "stdout" | "stderr";
  text: string;
}

/** Events that carry printed text. The rest (metrics, delimiters, state changes) are not log lines. */
const PRINTED = new Set(["stdout", "stderr", "command", "fatal", "exit"]);
const MAX_LINE = 16 * 1024;

/** One event as Vercel sends it, in either of its documented shapes; null when it prints nothing. */
export function eventToLine(raw: unknown): BuildLine | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as { type?: unknown; created?: unknown; date?: unknown; text?: unknown; level?: unknown; payload?: { text?: unknown; date?: unknown; created?: unknown } | null };
  if (typeof e.type !== "string" || !PRINTED.has(e.type)) return null;
  const text = typeof e.text === "string" ? e.text : typeof e.payload?.text === "string" ? e.payload.text : null;
  if (text === null) return null;
  const at = [e.created, e.date, e.payload?.created, e.payload?.date].find((x): x is number => typeof x === "number") ?? Date.now();
  const bad = e.type === "stderr" || e.type === "fatal" || e.level === "error";
  return { ts: new Date(at).toISOString(), stream: bad ? "stderr" : "stdout", text: text.replace(/\r?\n$/, "").slice(0, MAX_LINE) };
}

/** A JSON array, or newline-delimited JSON when Vercel answers as a stream. */
export function parseEvents(body: string): unknown[] {
  const t = body.trim();
  if (!t || t === "null") return [];
  try {
    const all = JSON.parse(t) as unknown;
    return Array.isArray(all) ? all : [all];
  } catch {
    return t.split("\n").flatMap((l) => {
      try {
        return [JSON.parse(l) as unknown];
      } catch {
        return [];
      }
    });
  }
}

export interface RuntimeLine {
  appId: string;
  id: string;
  ts: string;
  stream: "stdout" | "stderr";
  level: "error" | "warn" | "info" | "debug";
  text: string;
}

const LEVEL: Record<string, RuntimeLine["level"]> = { fatal: "error", error: "error", warning: "warn", info: "info", debug: "debug", trace: "debug" };

/** One runtime row. A request with no output of its own reads as its method, path and status. */
export function runtimeToLine(raw: unknown, appId: string): RuntimeLine | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { rowId?: unknown; timestampInMs?: unknown; level?: unknown; message?: unknown; source?: unknown; requestMethod?: unknown; requestPath?: unknown; responseStatusCode?: unknown };
  if (r.source === "delimiter") return null;
  const level = LEVEL[String(r.level)] ?? "info";
  const said = typeof r.message === "string" ? r.message.replace(/\r?\n$/, "") : "";
  const request = [r.requestMethod, r.requestPath, r.responseStatusCode].filter((x) => x !== undefined && x !== null && x !== "").join(" ");
  const text = said || request;
  if (!text) return null;
  const at = typeof r.timestampInMs === "number" ? r.timestampInMs : Date.now();
  const row = typeof r.rowId === "string" && /^[\w.:~-]{1,128}$/.test(r.rowId) ? r.rowId : `${at}`;
  return { id: row, appId, ts: new Date(at).toISOString(), stream: level === "error" ? "stderr" : "stdout", level, text: text.slice(0, MAX_LINE) };
}

// ------------------------------------------------------------------ what a read needs

interface Link {
  token: string;
  teamId: string | null;
  /** A new redactor per read, since its PEM state belongs to one run of lines. */
  redactor: () => Redactor;
}

const SECRETS_TTL_MS = 60_000;
const secretCache = new Map<string, { at: number; values: string[] }>();

/** The project's secret values, for the literal pass. One that cannot be opened empties nothing else. */
async function projectSecrets(db: Db, ring: Keyring, projectId: string): Promise<string[]> {
  const hit = secretCache.get(projectId);
  if (hit && Date.now() - hit.at < SECRETS_TTL_MS) return hit.values;
  const values: string[] = [];
  const scope = await loadScope(db, projectId);
  const entries = await loadEntries(db, ring, scope, (secret) => secret).catch(() => new Map());
  for (const e of entries.values()) if (e.secret && typeof e.value === "string") values.push(e.value);
  secretCache.set(projectId, { at: Date.now(), values });
  return values;
}

async function linkFor(db: Db, ring: Keyring, projectId: string): Promise<Link> {
  const row = await findIntegration(db, "vercel");
  const token = row && row.status !== "disconnected" ? await openSecret(db, ring, row, "primary") : null;
  if (!row || !token) throw new HttpError(409, "Vercel is not connected", "NOT_CONNECTED");
  const secrets = await projectSecrets(db, ring, projectId);
  return {
    token,
    teamId: configOf<{ team?: { id?: string } | null }>(row).team?.id ?? null,
    redactor: () => new Redactor().conceal([token, ...secrets]),
  };
}

const withTeam = (path: string, teamId: string | null) => `${VERCEL_API}${path}${teamId ? `${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(teamId)}` : ""}`;

function refused(status: number): HttpError {
  if (status === 401 || status === 403) return new HttpError(502, "Vercel refused the stored token. Reconnect Vercel in Settings.", "VERCEL_TOKEN");
  if (status === 429) return new HttpError(503, "Vercel is limiting this token for now. Try again in a minute.", "VERCEL_LIMITED");
  return new HttpError(502, `Vercel answered ${status}`, "UPSTREAM");
}

const unreachable = (e: unknown): HttpError => (e instanceof HttpError ? e : new HttpError(502, e instanceof OutboundError && e.code === "TIMEOUT" ? "Vercel did not answer in time" : "Vercel could not be reached", "UPSTREAM"));

// ------------------------------------------------------------------ build logs: the page

const PAGE_EVENTS = 10_000;
const SMALLER_PAGE = 2_000;
const MAX_BODY = 32 * 1024 * 1024;
const MAX_LINES_PER_PAGE = 5_000;
const MAX_PAGE_BYTES = 1024 * 1024;
/** A running build is asked at most this often, however many viewers poll. */
const LIVE_CACHE_MS = 2_000;
const DONE_CACHE_MS = 30_000;
const MAX_CACHED_TEXT = 4 * 1024 * 1024;

export const TRUNCATED_NOTICE = "This log is too large to show whole. These are its last lines. The full log is on Vercel.";
export const GONE_NOTICE = "Vercel no longer has a log for this deployment.";

interface Whole {
  lines: BuildLine[];
  truncated: boolean;
}

const builds = new Map<string, { at: number; terminal: boolean; read: Promise<Whole> }>();

async function readWhole(link: Link, externalId: string): Promise<Whole> {
  const ask = async (limit: number): Promise<unknown[] | null> => {
    const url = withTeam(`/v3/deployments/${encodeURIComponent(externalId)}/events?direction=backward&limit=${limit}&builds=1`, link.teamId);
    const res = await client().http({ method: "GET", url, headers: { Authorization: `Bearer ${link.token}` }, timeoutMs: 30_000, maxBytes: MAX_BODY });
    if (res.status === 404 || res.status === 410) return null;
    if (res.status < 200 || res.status >= 300) throw refused(res.status);
    return parseEvents(res.body.toString("utf8")).reverse();
  };
  let events: unknown[] | null;
  let limit = PAGE_EVENTS;
  try {
    events = await ask(limit);
  } catch (e) {
    if (!(e instanceof OutboundError && e.code === "TOO_LARGE")) throw unreachable(e);
    limit = SMALLER_PAGE;
    events = await ask(limit).catch((again: unknown) => {
      throw unreachable(again);
    });
  }
  if (events === null) return { lines: [{ ts: new Date().toISOString(), stream: "stderr", text: GONE_NOTICE }], truncated: false };
  const redact = link.redactor();
  const lines: BuildLine[] = [];
  for (const raw of events) {
    const l = eventToLine(raw);
    if (l) lines.push({ ...l, text: redact.line(l.text) });
  }
  const truncated = events.length >= limit;
  if (truncated) lines.unshift({ ts: lines[0]?.ts ?? new Date().toISOString(), stream: "stderr", text: TRUNCATED_NOTICE });
  return { lines, truncated };
}

function cached(link: Link, externalId: string, terminal: boolean): Promise<Whole> {
  const hit = builds.get(externalId);
  if (hit && hit.terminal === terminal && Date.now() - hit.at < (terminal ? DONE_CACHE_MS : LIVE_CACHE_MS)) return hit.read;
  const read = readWhole(link, externalId);
  const entry = { at: Date.now(), terminal, read };
  builds.set(externalId, entry);
  // Oldest first, so the map stays small; a large log or a failure is not kept at all.
  if (builds.size > 16) builds.delete(builds.keys().next().value!);
  void read.then(
    (w) => {
      if (w.lines.reduce((n, l) => n + l.text.length, 0) > MAX_CACHED_TEXT && builds.get(externalId) === entry) builds.delete(externalId);
    },
    () => {
      if (builds.get(externalId) === entry) builds.delete(externalId);
    },
  );
  return read;
}

export const clearVercelLogCache = (): void => {
  builds.clear();
  secretCache.clear();
};

/** The lines after `after`, in the shape of deployments.logs. Seq is the line's place in the log, from 1. */
export async function readBuildLog(db: Db, ring: Keyring, d: { externalId: string | null; projectId: string; terminal: boolean }, after: number) {
  // Dockify asked Vercel to deploy and Vercel has not answered yet: nothing to read so far.
  if (!d.externalId) return { lines: [], done: d.terminal, source: "vercel" as const };
  const link = await linkFor(db, ring, d.projectId);
  const whole = await cached(link, d.externalId, d.terminal);
  const lines: Array<BuildLine & { seq: number }> = [];
  let bytes = 0;
  let more = false;
  for (let i = Math.max(0, after); i < whole.lines.length; i++) {
    const l = whole.lines[i]!;
    bytes += l.text.length + 48;
    if (lines.length >= MAX_LINES_PER_PAGE || (lines.length > 0 && bytes > MAX_PAGE_BYTES)) {
      more = true;
      break;
    }
    lines.push({ ...l, seq: i + 1 });
  }
  return { lines, done: d.terminal && !more, source: "vercel" as const, ...(whole.truncated ? { truncated: true } : {}) };
}

// ------------------------------------------------------------------ streams

const MAX_STREAMS_PER_USER = 4;
const MAX_STREAMS_TOTAL = 24;
const HEARTBEAT_MS = 15_000;
const MAX_STREAM_MS = 60 * 60_000;
const RECONNECT_MS = 2_000;
const MAX_RECONNECT_MS = 30_000;
/** Reconnects in a row with no new line before the stream says it has stopped. */
const MAX_QUIET_FAILURES = 5;
const open = new Map<string, number>();
let openTotal = 0;

function takeSlot(userId: string): () => void {
  if ((open.get(userId) ?? 0) >= MAX_STREAMS_PER_USER || openTotal >= MAX_STREAMS_TOTAL) throw new HttpError(429, "Too many open Vercel log streams", "TOO_MANY_STREAMS");
  open.set(userId, (open.get(userId) ?? 0) + 1);
  openTotal++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openTotal--;
    const left = (open.get(userId) ?? 1) - 1;
    if (left <= 0) open.delete(userId);
    else open.set(userId, left);
  };
}

export const openVercelStreams = (): number => openTotal;

interface Pump {
  /** The upstream address to read; called again for each reconnect. */
  url: () => string;
  onLine(raw: string): Promise<boolean>;
  /** The stream ended because Vercel finished sending: what to say, or null to reconnect. */
  finished(end: StreamEnd | null): Promise<{ event: string; data: unknown } | null>;
}

/**
 * Runs one SSE answer over an upstream stream, with reconnects. The slot is taken before the hijack
 * so a refusal is a clean 429; a viewer who leaves aborts the upstream at once, and a lapsed session
 * ends the stream at the next standing check.
 */
async function pump(req: FastifyRequest, reply: FastifyReply, token: string, userId: string, allowed: Reauthorizer, build: (send: (frame: string) => Promise<boolean>) => Pump): Promise<void> {
  const release = takeSlot(userId);
  const stop = new AbortController();
  const raw = reply.raw;
  let closed = false;
  const leave = (): void => {
    closed = true;
    stop.abort();
    release();
  };
  raw.on("close", leave);
  reply.hijack();
  raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
    connection: "keep-alive",
  });
  const send = async (frame: string): Promise<boolean> => {
    if (closed || raw.destroyed || raw.writableEnded) return false;
    if (raw.write(frame)) return true;
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 10_000);
      raw.once("drain", () => {
        clearTimeout(t);
        resolve(true);
      });
    });
  };
  const beat = setInterval(() => {
    void send(": ping\n\n");
    void allowed().then((ok) => {
      if (ok || closed) return;
      void send(sseFrame("end", { reason: "unauthorized" })).finally(() => stop.abort());
    });
  }, HEARTBEAT_MS);
  beat.unref();

  const started = Date.now();
  const flow = build(send);
  let quiet = 0;
  try {
    await send("retry: 3000\n\n");
    while (!closed && !stop.signal.aborted) {
      if (Date.now() - started > MAX_STREAM_MS) {
        await send(sseFrame("end", { reason: "max_duration" }));
        break;
      }
      let progressed = false;
      let end: StreamEnd | null = null;
      try {
        const res = await client().stream({ url: flow.url(), headers: { Authorization: `Bearer ${token}` }, signal: stop.signal, idleMs: 5 * 60_000, maxMs: MAX_STREAM_MS });
        if (res.status === 404 || res.status === 410) {
          res.close();
          await send(sseFrame("end", { reason: "gone" }));
          break;
        }
        if (res.status === 401 || res.status === 403) {
          res.close();
          await send(sseFrame("end", { reason: "token" }));
          break;
        }
        if (res.status === 429 || res.status >= 500) res.close();
        else if (res.status < 200 || res.status >= 300) {
          res.close();
          await send(sseFrame("end", { reason: "refused" }));
          break;
        } else {
          for await (const line of res.lines()) {
            if (await flow.onLine(line)) progressed = true;
            if (closed || stop.signal.aborted) break;
          }
          end = res.ended;
        }
      } catch {
        if (closed || stop.signal.aborted) break;
      }
      if (closed || stop.signal.aborted) break;
      const final = await flow.finished(end);
      if (final) {
        await send(sseFrame(final.event, final.data));
        break;
      }
      quiet = progressed ? 0 : quiet + 1;
      if (quiet >= MAX_QUIET_FAILURES && end !== "done") {
        await send(sseFrame("end", { reason: "stopped" }));
        break;
      }
      // Each quiet round waits longer, so an upstream that keeps closing at once is not asked every 2 s for an hour.
      await new Promise((r) => setTimeout(r, Math.min(RECONNECT_MS * (quiet + 1), MAX_RECONNECT_MS)));
    }
  } finally {
    clearInterval(beat);
    stop.abort();
    release();
    if (!raw.writableEnded) raw.end();
  }
}

/**
 * The live build log. Events `line` (id = seq, the same seq as the page) and `done` with the final
 * status. Vercel closes the follow once the build has finished, so a finished deployment streams its
 * whole log and ends. `after` skips what the viewer already has.
 */
export async function streamBuildLog(
  db: Db, ring: Keyring, req: FastifyRequest, reply: FastifyReply,
  d: { id: string; externalId: string | null; projectId: string; status: string },
  after: number, allowed: Reauthorizer, settled: () => Promise<string | null>, userId: string,
): Promise<void> {
  if (!d.externalId) throw new HttpError(409, "Vercel has not accepted this deployment yet", "NOT_STARTED");
  const link = await linkFor(db, ring, d.projectId);
  const lastId = Number(req.headers["last-event-id"]);
  let cursor = Number.isInteger(lastId) && lastId >= 0 ? lastId : Math.max(0, after);
  const externalId = d.externalId;
  await pump(req, reply, link.token, userId, allowed, (send) => {
    let redact = link.redactor();
    let seq = 0;
    return {
      url: () => {
        // Each connection replays from the start; the seq below skips what was already sent.
        seq = 0;
        redact = link.redactor();
        return withTeam(`/v3/deployments/${encodeURIComponent(externalId)}/events?direction=forward&follow=1&limit=-1&builds=1`, link.teamId);
      },
      async onLine(raw) {
        if (!raw.trim()) return false;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return false;
        }
        const l = eventToLine(parsed);
        if (!l) return false;
        seq++;
        const text = redact.line(l.text);
        if (seq <= cursor) return false;
        cursor = seq;
        await send(sseFrame("line", { ...l, text, seq }, seq));
        return true;
      },
      async finished(end) {
        const status = await settled();
        if (status) return { event: "done", data: { status } };
        // Vercel says the follow is over, and the mirror has not caught up: the page reads the row next.
        return end === "done" ? { event: "done", data: { status: "syncing" } } : null;
      },
    };
  });
}

/** The live runtime log. Events `line` (id = Vercel's row id) and `end`. It reconnects as Vercel closes. */
export async function streamRuntimeLog(
  db: Db, ring: Keyring, req: FastifyRequest, reply: FastifyReply,
  d: { appId: string; externalId: string; vercelProjectId: string; projectId: string },
  allowed: Reauthorizer, userId: string,
): Promise<void> {
  const link = await linkFor(db, ring, d.projectId);
  await pump(req, reply, link.token, userId, allowed, (send) => {
    const redact = link.redactor();
    const seen = new Set<string>();
    return {
      url: () => withTeam(`/v1/projects/${encodeURIComponent(d.vercelProjectId)}/deployments/${encodeURIComponent(d.externalId)}/runtime-logs`, link.teamId),
      async onLine(raw) {
        if (!raw.trim()) return false;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return false;
        }
        const l = runtimeToLine(parsed, d.appId);
        if (!l || seen.has(l.id)) return false;
        seen.add(l.id);
        // A reconnect can send recent rows again; remembering the last few thousand is plenty.
        if (seen.size > 5_000) seen.delete(seen.values().next().value!);
        await send(sseFrame("line", { ...l, text: redact.line(l.text) }, undefined));
        return true;
      },
      finished: async () => null,
    };
  });
}

const TAIL_WAIT_MS = 3_000;

/** What arrives in a short read of the runtime stream: Vercel has no way to ask for the last N. */
export async function tailRuntime(db: Db, ring: Keyring, d: { appId: string; externalId: string; vercelProjectId: string; projectId: string }, tail: number) {
  const link = await linkFor(db, ring, d.projectId);
  const url = withTeam(`/v1/projects/${encodeURIComponent(d.vercelProjectId)}/deployments/${encodeURIComponent(d.externalId)}/runtime-logs`, link.teamId);
  let res: Awaited<ReturnType<StreamClient>>;
  try {
    res = await client().stream({ url, headers: { Authorization: `Bearer ${link.token}` }, maxMs: TAIL_WAIT_MS, idleMs: TAIL_WAIT_MS, timeoutMs: 10_000, maxBytes: 8 * 1024 * 1024 });
  } catch (e) {
    throw unreachable(e);
  }
  if (res.status === 404 || res.status === 410) {
    res.close();
    return [];
  }
  if (res.status < 200 || res.status >= 300) {
    res.close();
    throw refused(res.status);
  }
  const redact = link.redactor();
  const lines: RuntimeLine[] = [];
  const seen = new Set<string>();
  try {
    for await (const raw of res.lines()) {
      if (!raw.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      const l = runtimeToLine(parsed, d.appId);
      if (!l || seen.has(l.id)) continue;
      seen.add(l.id);
      lines.push({ ...l, text: redact.line(l.text) });
    }
  } catch {
    // A connection that drops mid read still leaves what it already sent, and the live stream follows.
  } finally {
    res.close();
  }
  return lines.slice(-tail);
}

// ------------------------------------------------------------------ what the page may say

const BY_PLAN = { hobby: 1, pro: 24, enterprise: 72, observabilityPlus: 720 };
/** Vercel's own limit per request; lines beyond it never reach any reader. */
const LINES_PER_REQUEST = 256;

/**
 * How far back Vercel keeps runtime logs, as far as Dockify can tell: Vercel does not report a plan,
 * but it accepts a webhook only from Pro or Enterprise.
 */
export function retentionNote(webhookActive: boolean) {
  return {
    plan: webhookActive ? ("pro_or_enterprise" as const) : ("unknown" as const),
    minHours: webhookActive ? BY_PLAN.pro : null,
    note: webhookActive
      ? "Vercel keeps runtime logs for at least 1 day on this plan, longer on Enterprise or with Observability Plus, and at most 256 lines per request."
      : "Vercel keeps runtime logs for 1 hour on Hobby, 1 day on Pro, 3 days on Enterprise and 30 days with Observability Plus, and at most 256 lines per request. Vercel does not tell Dockify the plan.",
    byPlanHours: BY_PLAN,
    linesPerRequest: LINES_PER_REQUEST,
  };
}
