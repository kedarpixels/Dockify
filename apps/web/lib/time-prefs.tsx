"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { absTime, chartTime, clockTime, dayHeading, DEFAULT_TIME, setBrowserTimePrefs, timeParts } from "./format";
import { useHydrated } from "./hooks";
import type { TimePrefs } from "./types";

// The server render reads the same saved zone and clock, so an explicit choice never causes a
// hydration mismatch; only "browser default" waits for mount.

interface TimePrefsState {
  prefs: TimePrefs;
  apply: (next: TimePrefs) => void;
}

const TimePrefsContext = createContext<TimePrefsState>({ prefs: DEFAULT_TIME, apply: () => {} });

export function TimePrefsProvider({ value, children }: { value: TimePrefs | null | undefined; children: React.ReactNode }) {
  const timeZone = value?.timeZone ?? null;
  const hour12 = value?.hour12 ?? false;
  const [saved, setSaved] = useState<{ from: string; prefs: TimePrefs } | null>(null);
  // A saved choice holds until the session payload itself changes (the next load or refresh).
  const from = `${timeZone ?? ""}|${hour12}`;
  const local = saved && saved.from === from ? saved.prefs : null;
  const prefs = useMemo(() => local ?? { timeZone, hour12 }, [local, timeZone, hour12]);
  // During render on purpose, not in an effect: lib/format reads this module-level choice, and the
  // server and first client render must already format with it. Idempotent.
  setBrowserTimePrefs(prefs);
  const state = useMemo(() => ({ prefs, apply: (next: TimePrefs) => setSaved({ from, prefs: next }) }), [prefs, from]);
  return (
    <TimePrefsContext.Provider value={state}>
      <div className="time-scope">
        {children}
      </div>
    </TimePrefsContext.Provider>
  );
}

export const useTimePrefs = () => useContext(TimePrefsContext).prefs;
export const useApplyTimePrefs = () => useContext(TimePrefsContext).apply;

export function useTimeFormat() {
  const prefs = useTimePrefs();
  return useMemo(
    () => ({
      prefs,
      abs: (iso: string, o: { utc?: boolean } = {}) => absTime(iso, { ...o, prefs }),
      clock: (at: string | number | Date, o: { utc?: boolean; seconds?: boolean } = {}) => clockTime(at, { ...o, prefs }),
      parts: (at: string | number | Date, o: { utc?: boolean } = {}) => timeParts(at, { ...o, prefs }),
      chart: (at: string | number | Date, o: { utc?: boolean; withDay?: boolean } = {}) => chartTime(at, { ...o, prefs }),
    }),
    [prefs],
  );
}

export type TimeFormat = ReturnType<typeof useTimeFormat>;

/** "14:05", or "Thu 14:05" over 7 days. Browser-local times read UTC until hydrated. */
export function pointLabel(at: string, range: "1h" | "24h" | "7d", local: boolean, time: TimeFormat) {
  return time.chart(at, { utc: !local && !time.prefs.timeZone, withDay: range === "7d" });
}

/** Day headings on the reader's own calendar days once hydrated; UTC days for the server render. */
export function useDayHeading() {
  const { prefs } = useTimeFormat();
  const hydrated = useHydrated();
  return useCallback((iso: string, now: number) => dayHeading(iso, now, hydrated ? prefs : undefined), [hydrated, prefs]);
}

/** A time's hover tip. With no zone picked it reads UTC until hydrated, so both renders agree. */
export function useAbsTip() {
  const hydrated = useHydrated();
  const { prefs, abs } = useTimeFormat();
  return useCallback((iso: string, utc = false) => abs(iso, { utc: utc || (!hydrated && !prefs.timeZone) }), [abs, hydrated, prefs.timeZone]);
}

/** "30 Oct 2026, 14:05 UTC" in the user's clock, for server-scheduled moments. */
export function useUtcAt() {
  const { abs } = useTimeFormat();
  return useCallback((iso: string) => abs(iso, { utc: true }), [abs]);
}
