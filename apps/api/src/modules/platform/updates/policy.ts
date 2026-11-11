/**
 * When an update may install on its own. Skip and pause hold back every automatic install,
 * critical ones too; a manual install still works.
 */
import type { Offer } from "./release.ts";

export type UpdateMode = "manual" | "security" | "all";

export interface UpdateWindow {
  /** 0 Sunday to 6 Saturday, in the instance time zone. */
  days: number[];
  /** "HH:MM", 24 hour. An end at or before the start runs past midnight into the next day. */
  start: string;
  end: string;
}

export interface UpdatePolicy {
  mode: UpdateMode;
  /** null means any time. */
  window: UpdateWindow | null;
  timeZone: string;
  skipVersion: string | null;
  pausedUntil: Date | null;
}

export const DEFAULT_WINDOW: UpdateWindow = { days: [0, 1, 2, 3, 4, 5, 6], start: "03:00", end: "05:00" };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const minutesOf = (hhmm: string): number => {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`not a time of day: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
};

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const DAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localClock(at: Date, tz: string): { day: number; minute: number } {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    fmtCache.set(tz, f);
  }
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  return { day: DAY[parts.weekday ?? "Sun"] ?? 0, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** A window that runs past midnight belongs to the day it opens. */
export function inWindow(at: Date, w: UpdateWindow | null, tz: string): boolean {
  if (!w) return true;
  if (!w.days.length) return false;
  const { day, minute } = localClock(at, tz);
  const s = minutesOf(w.start);
  const e = minutesOf(w.end);
  if (s < e) return w.days.includes(day) && minute >= s && minute < e;
  // Past midnight (or a full day when start equals end).
  if (minute >= s) return w.days.includes(day);
  return minute < e && w.days.includes((day + 6) % 7);
}

const STEP_MS = 5 * 60_000;

/** At or after `from`, at 5 minute resolution, or null if the window never opens. */
export function nextWindowOpen(from: Date, w: UpdateWindow | null, tz: string): Date | null {
  if (!w) return from;
  if (!w.days.length) return null;
  const start = Math.ceil(from.getTime() / STEP_MS) * STEP_MS;
  if (inWindow(from, w, tz)) return from;
  for (let t = start, end = start + 8 * 86_400_000; t <= end; t += STEP_MS) {
    const d = new Date(t);
    if (inWindow(d, w, tz)) return d;
  }
  return null;
}

export type AutoDecision =
  | { action: "none"; reason: string }
  | { action: "notify"; reason: string }
  | { action: "wait"; reason: string; until: Date | null }
  | { action: "install"; reason: string };

export function decideAuto(now: Date, policy: UpdatePolicy, offer: Offer): AutoDecision {
  const rel = offer.target;
  if (!rel) return { action: "none", reason: "no newer release" };
  if (policy.skipVersion && policy.skipVersion.replace(/^v/, "") === rel.version.replace(/^v/, "")) {
    return { action: "none", reason: `${rel.version} is skipped` };
  }
  if (policy.mode === "manual") return { action: "notify", reason: "updates are manual" };
  if (policy.mode === "security" && !offer.critical) return { action: "notify", reason: `${rel.version} is not a security release` };
  if (policy.pausedUntil && policy.pausedUntil > now) return { action: "wait", reason: "automatic updates are paused", until: policy.pausedUntil };
  if (!inWindow(now, policy.window, policy.timeZone)) {
    return { action: "wait", reason: "outside the maintenance window", until: nextWindowOpen(now, policy.window, policy.timeZone) };
  }
  return { action: "install", reason: offer.critical ? "critical security release" : "automatic updates are on" };
}

/** Six hours plus up to an hour of jitter, so a fleet never asks the feed at the same minute. */
export const CHECK_EVERY_MS = 6 * 3_600_000;
export const nextCheckAt = (from: Date, rand: () => number = Math.random): Date =>
  new Date(from.getTime() + CHECK_EVERY_MS + Math.floor(rand() * 3_600_000));
