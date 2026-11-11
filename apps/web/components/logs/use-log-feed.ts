"use client";

import { useCallback, useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { callJson } from "@/lib/client-api";
import type { LogPage, LogsResult } from "@/lib/pages/logs";
import { filterKey, isLiveRange, queryOf, querySearch, type LogFilters, type LogQuery, type RuntimeLogLine } from "./model";

// Every answer carries the filter key it was asked for, so one that lands after a filter change is
// dropped. `base` is the position of lines[0], so the viewer can key its chunks by position.

/** The view keeps at most this many lines; past it the oldest go, down to TRIM_TO. */
const MAX_LINES = 20_000;
const TRIM_TO = 15_000;

export type LivePhase = "off" | "connecting" | "live" | "retrying" | "stopped";

interface Feed {
  key: string;
  phase: "loading" | "ready" | "error" | "invalid";
  error?: string;
  lines: RuntimeLogLine[];
  base: number;
  older: string | null;
  /** The cap dropped the oldest lines, so older pages can no longer join up. */
  trimmed: boolean;
  olderPhase: "idle" | "loading" | "error";
  olderError?: string;
  /** Lines that arrived while paused, shown on resume. */
  buffer: RuntimeLogLine[];
  /** Lines the server or the cap skipped, for the gap note. */
  dropped: number;
  paused: boolean;
}

type Action =
  | { type: "loading"; key: string }
  | { type: "invalid"; key: string }
  | { type: "page"; key: string; page: LogPage }
  | { type: "fail"; key: string; error: string }
  | { type: "older"; key: string }
  | { type: "olderPage"; key: string; page: LogPage }
  | { type: "olderFail"; key: string; error: string }
  | { type: "append"; key: string; lines: RuntimeLogLine[] }
  | { type: "gap"; key: string; dropped: number }
  | { type: "pause"; on: boolean };

const blank = (key: string, phase: Feed["phase"]): Feed => ({ key, phase, lines: [], base: 0, older: null, trimmed: false, olderPhase: "idle", buffer: [], dropped: 0, paused: false });

/** Appends past the cap trim the oldest lines, moving `base` so surviving chunks keep their place. */
function capped(f: Feed, lines: RuntimeLogLine[]): Feed {
  const all = [...f.lines, ...lines];
  if (all.length <= MAX_LINES) return { ...f, lines: all };
  const cut = all.length - TRIM_TO;
  return { ...f, lines: all.slice(cut), base: f.base + cut, older: null, trimmed: true };
}

function reduce(f: Feed, a: Action): Feed {
  if (a.type === "pause") {
    if (a.on === f.paused) return f;
    return a.on ? { ...f, paused: true } : { ...capped(f, f.buffer), buffer: [], paused: false };
  }
  if (a.type === "loading") return { ...blank(a.key, "loading"), paused: f.paused && f.key === a.key };
  if (a.type === "invalid") return blank(a.key, "invalid");
  if (a.key !== f.key) return f;
  switch (a.type) {
    case "page":
      return { ...f, phase: "ready", error: undefined, lines: a.page.lines, base: 0, older: a.page.nextCursor, trimmed: false, buffer: [], dropped: 0 };
    case "fail":
      return { ...f, phase: "error", error: a.error };
    case "older":
      return { ...f, olderPhase: "loading", olderError: undefined };
    case "olderPage": {
      const known = new Set(f.lines.map((l) => l.id));
      const fresh = a.page.lines.filter((l) => !known.has(l.id));
      return { ...f, lines: [...fresh, ...f.lines], base: f.base - fresh.length, older: a.page.nextCursor, olderPhase: "idle" };
    }
    case "olderFail":
      return { ...f, olderPhase: "error", olderError: a.error };
    case "append": {
      if (f.phase !== "ready") return f;
      if (f.paused) {
        const buffer = [...f.buffer, ...a.lines];
        const over = Math.max(0, buffer.length - MAX_LINES);
        return { ...f, buffer: over ? buffer.slice(over) : buffer, dropped: f.dropped + over };
      }
      return capped(f, a.lines);
    }
    case "gap":
      return { ...f, dropped: f.dropped + a.dropped };
  }
}

async function fetchPage(q: LogQuery, cursor: string | null, signal?: AbortSignal): Promise<{ page: LogPage } | { error: string; aborted?: boolean }> {
  const r = await callJson<LogsResult>(`/api/logs?${querySearch(q, { from: q.from, to: q.to, cursor })}`, { signal });
  if (!r.ok) return { error: r.error, aborted: r.aborted };
  if (!r.data?.data) return { error: r.data?.error ?? "The API did not answer" };
  return { page: r.data.data };
}

export function useLogFeed({ filters, initial, enabled }: { filters: LogFilters; initial: LogsResult | null; enabled: boolean }) {
  const key = filterKey(filters);
  const [feed, dispatch] = useReducer(reduce, key, (k): Feed =>
    initial?.data ? { ...blank(k, "ready"), lines: initial.data.lines, older: initial.data.nextCursor } : initial ? { ...blank(k, "error"), error: initial.error } : blank(k, "invalid"),
  );
  const [attempt, setAttempt] = useState(0);
  // The query a key was loaded with: older pages and the stream reuse its fixed window. Set by the
  // load effect, never during render, since the window is anchored on the clock.
  const asked = useRef<{ key: string; query: LogQuery | null }>({ key: "", query: null });
  // The key the server already loaded, skipped once (and again under a strict mode re-run).
  const seeded = useRef<string | null>(initial ? key : null);

  // The server rendered the first set, so the very first run reuses it and only notes the window it covers.
  const load = useEffectEvent((signal: AbortSignal | null) => {
    const query = queryOf(filters, Date.now());
    asked.current = { key, query };
    if (!signal) return;
    if (!query) {
      dispatch({ type: "invalid", key });
      return;
    }
    dispatch({ type: "loading", key });
    void fetchPage(query, null, signal).then((r) => {
      if ("page" in r) dispatch({ type: "page", key, page: r.page });
      else if (!r.aborted) dispatch({ type: "fail", key, error: r.error });
    });
  });
  useEffect(() => {
    if (!enabled) return;
    if (seeded.current === key && attempt === 0) {
      load(null);
      return;
    }
    seeded.current = null;
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [key, attempt, enabled]);

  // Relative ranges only. The tail knows what is already shown, so a reconnect never shows a line twice.
  const ready = feed.phase === "ready" && feed.key === key;
  const tail = enabled && ready && isLiveRange(filters);
  const [streamTry, setStreamTry] = useState(0);
  const stream = `${key}|${attempt}|${streamTry}`;
  const [phase, setPhase] = useState<{ stream: string; live: LivePhase }>({ stream: "", live: "off" });
  const live: LivePhase = !tail ? "off" : phase.stream === stream ? phase.live : "connecting";
  const snapshot = useEffectEvent(() => ({ since: feed.lines.at(-1)?.id, shown: [...feed.lines, ...feed.buffer].map((l) => l.id) }));
  useEffect(() => {
    if (!tail) return;
    const query = asked.current.key === key ? asked.current.query : null;
    if (!query || typeof EventSource === "undefined") return;
    const { since, shown } = snapshot();
    const ids = new Set(shown);
    const set = (next: LivePhase) => setPhase({ stream, live: next });
    const es = new EventSource(`/api/logs/stream?${querySearch(query, { since })}`);
    es.onopen = () => set("live");
    es.onerror = () => set(es.readyState === EventSource.CLOSED ? "stopped" : "retrying");
    es.addEventListener("lines", (e) => {
      try {
        const lines = (JSON.parse((e as MessageEvent<string>).data) as { lines?: RuntimeLogLine[] }).lines ?? [];
        const fresh = lines.filter((l) => l && typeof l.id === "string" && !ids.has(l.id));
        for (const l of fresh) ids.add(l.id);
        if (fresh.length) dispatch({ type: "append", key, lines: fresh });
        set("live");
      } catch {
        // A malformed batch is skipped; the next one carries on.
      }
    });
    es.addEventListener("gap", (e) => {
      try {
        const n = Number((JSON.parse((e as MessageEvent<string>).data) as { dropped?: number }).dropped);
        if (n > 0) dispatch({ type: "gap", key, dropped: n });
      } catch {
        // Ignored, as above.
      }
    });
    return () => es.close();
  }, [tail, key, stream]);

  const loadOlder = useCallback(async () => {
    const cursor = feed.older;
    const query = asked.current.key === feed.key ? asked.current.query : null;
    if (!cursor || !query || feed.olderPhase === "loading") return;
    const k = feed.key;
    dispatch({ type: "older", key: k });
    const r = await fetchPage(query, cursor);
    if ("page" in r) dispatch({ type: "olderPage", key: k, page: r.page });
    else dispatch({ type: "olderFail", key: k, error: r.error });
  }, [feed.older, feed.key, feed.olderPhase]);

  return {
    feed,
    live,
    setPaused: useCallback((on: boolean) => dispatch({ type: "pause", on }), []),
    loadOlder,
    retry: useCallback(() => setAttempt((n) => n + 1), []),
    reconnect: useCallback(() => setStreamTry((n) => n + 1), []),
  };
}
