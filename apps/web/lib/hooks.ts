"use client";

import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { publishOverview } from "./live-overview";
import type { OverviewResult } from "./types";

/* -------------- Session expiry -------------- */

/* Flips once per page load: after the first 401 the console stays behind the notice until the
   operator signs in again, which is a full navigation and starts a fresh page. */
let sessionEnded = false;
const sessionListeners = new Set<() => void>();

/** Marks the session as ended, which shows the full-screen notice the console layout mounts. */
export function endSession() {
  if (sessionEnded) return;
  sessionEnded = true;
  for (const fn of sessionListeners) fn();
}

const subscribeSession = (fn: () => void) => {
  sessionListeners.add(fn);
  return () => {
    sessionListeners.delete(fn);
  };
};

/** True once any client fetch learned that the session ended. Always false on the server. */
export function useSessionEnded() {
  return useSyncExternalStore(
    subscribeSession,
    () => sessionEnded,
    () => false,
  );
}

/**
 * `fetch` for same-origin console calls. A 401, or an answer that a server loader redirected to
 * /login (fetch follows redirects, so it ends there), ends the session. Errors and other statuses
 * pass through untouched, so callers keep their own handling.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401 || (res.redirected && landedOnLogin(res.url))) endSession();
  return res;
}

function landedOnLogin(url: string) {
  try {
    const u = new URL(url);
    return u.origin === location.origin && u.pathname === "/login";
  } catch {
    return false;
  }
}

/**
 * A clock that re-renders its caller every `ms`, so relative times and timers stay current.
 * Pass `start` (the snapshot time) so the server and the first client render agree.
 */
export function useNow(ms: number, start?: string) {
  const [now, setNow] = useState(() => {
    const t = start ? Date.parse(start) : NaN;
    return Number.isNaN(t) ? Date.now() : t;
  });
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the server render and hydration share `start`; the real clock begins once mounted.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const stamp = (r: OverviewResult) => Date.parse(r.fetchedAt) || 0;

/** How long a refresh runs before the page says it is updating. */
const SLOW_MS = 600;

/**
 * Refetches the overview on an interval and when the tab comes back, pausing while it is hidden.
 * Only the newest snapshot wins, a failed refresh keeps the last good data, and a fresher `initial`
 * from the server (after router.refresh) replaces what the poll holds. `refreshing` turns on only
 * once a refresh has taken 600ms, so a quick one never flashes an "Updating" note.
 */
export function useOverview(initial: OverviewResult, ms = 15_000) {
  const [result, setResult] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [seen, setSeen] = useState(initial);

  if (initial !== seen) {
    setSeen(initial);
    if (stamp(initial) >= stamp(result)) setResult(initial);
  }

  useEffect(() => publishOverview(result), [result]);

  useEffect(() => {
    if (initial.source === "none") return;
    let ctrl: AbortController | null = null;
    let slow: ReturnType<typeof setTimeout> | undefined;

    const pull = async () => {
      if (document.hidden) return;
      ctrl?.abort();
      const mine = new AbortController();
      ctrl = mine;
      clearTimeout(slow);
      slow = setTimeout(() => {
        if (ctrl === mine) setRefreshing(true);
      }, SLOW_MS);
      try {
        const res = await apiFetch("/api/overview", { cache: "no-store", signal: mine.signal });
        if (!res.ok) return;
        const next = (await res.json()) as OverviewResult;
        if (mine.signal.aborted) return;
        setResult((cur) => {
          if (stamp(next) < stamp(cur)) return cur;
          return next.data || !cur.data ? next : { ...cur, error: next.error };
        });
      } catch {
        // Aborted, offline or bad JSON: keep the last good snapshot; the next tick retries.
      } finally {
        if (ctrl === mine) {
          clearTimeout(slow);
          setRefreshing(false);
        }
      }
    };

    // `pull` never rejects (it catches everything), so nothing is lost by not awaiting it here.
    const tick = () => void pull();
    const id = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      clearTimeout(slow);
      document.removeEventListener("visibilitychange", tick);
      ctrl?.abort();
      ctrl = null;
    };
  }, [initial.source, ms]);

  return { result, refreshing };
}

/* Keys that already counted up in this page load. Coming back to a page, or a poll that changes a
   value, shows the number straight away instead of counting from zero again. Only effects write
   it, so the server render always starts from 0, the same as the first client render. */
const counted = new Set<string>();

/**
 * Eases a number from 0 to `target` (900ms, ease out), then follows it without animating. A target
 * that changes while the first count runs is eased toward from where the count is.
 * Without `key` it counts once per mount; with `key` once per page load, so a figure that remounts
 * (a tab switch, a page revisit) shows straight away. Reduced motion shows the target at once.
 */
export function useCountUp(target: number, ms = 900, key?: string) {
  const [value, setValue] = useState(() => (key !== undefined && counted.has(key) ? target : 0));
  const current = useRef(value);
  const done = useRef(key !== undefined && counted.has(key));
  useEffect(() => {
    if (key !== undefined) counted.add(key);
    if (done.current || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      done.current = true;
      current.current = target;
      setValue(target);
      return;
    }
    const from = current.current;
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      current.current = from + (target - from) * (1 - Math.pow(1 - k, 3));
      setValue(current.current);
      if (k < 1) raf = requestAnimationFrame(step);
      else done.current = true;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [key, target, ms]);
  return value;
}

/**
 * Every popover's "a press outside closes me". While `active`, a pointer press outside all of
 * `inside` calls `onOutside`. `capture` hears the press before anything inside the page can stop it.
 */
export function useOutsidePress(active: boolean, inside: ReadonlyArray<RefObject<Element | null>>, onOutside: () => void, capture = false) {
  const press = useEffectEvent((e: PointerEvent) => {
    if (!inside.some((r) => r.current?.contains(e.target as Node))) onOutside();
  });
  useEffect(() => {
    if (!active) return;
    const on = (e: PointerEvent) => press(e);
    document.addEventListener("pointerdown", on, capture);
    return () => document.removeEventListener("pointerdown", on, capture);
  }, [active, capture]);
}

/**
 * Whether a popover of `height` should open above `anchor`: the room below ends first, at the
 * viewport or at a scrolling ancestor of `from`, and there is more room above. `height` includes
 * its gap. From the anchor and a measured height, not the popover's own rect: an entry animation
 * shifts that by a few pixels, which is exactly enough to hide a small overflow.
 */
export function opensUp(anchor: DOMRect, height: number, from: Element | null) {
  let top = 0;
  let bottom = window.innerHeight;
  for (let el = from; el; el = el.parentElement) {
    if (!/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
    const box = el.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
  }
  const below = bottom - anchor.bottom;
  return below < height && anchor.top - top > below;
}

const noop = () => () => {};

/**
 * False during the server render and hydration, true right after. Use it for output that differs
 * between the server and the browser (local times), so hydration never mismatches.
 */
export function useHydrated() {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

/**
 * "/" focuses `ref` from anywhere on the page. It stays out of the way while the operator types in
 * a field, holds a modifier, or works in a dialog the field is not inside. When several fields
 * listen, the first one registered wins.
 */
export function useSlashFocus(ref: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const field = ref.current;
      if (!field || !field.getClientRects().length) return;
      const modal = [...document.querySelectorAll('[aria-modal="true"]')].at(-1);
      if (modal && !modal.contains(field)) return;
      e.preventDefault();
      field.focus();
      field.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ref, enabled]);
}
