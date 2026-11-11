"use client";

import { useSyncExternalStore } from "react";
import type { OverviewResult } from "./types";

/* The newest overview any page polled, for the shell. The layout reads the overview once per load,
   so without this the sidebar, command menu and tab title would keep that first snapshot. */
let latest: OverviewResult | null = null;
const listeners = new Set<() => void>();

/** Called by useOverview on every snapshot; the shell never fetches for itself. */
export function publishOverview(next: OverviewResult) {
  if (next === latest) return;
  latest = next;
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** The newest polled overview in this page load; null on the server and before the first poll. */
export function useLatestOverview() {
  return useSyncExternalStore(
    subscribe,
    () => latest,
    () => null,
  );
}
