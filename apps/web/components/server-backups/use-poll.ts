"use client";

import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { elevateThrowing } from "@/components/step-up/step-up";
import { callJson } from "@/lib/client-api";
import { apiFetch } from "@/lib/hooks";
import type { RestoreProgress } from "@/lib/pages/server-backups";

/** A poll shows the page's "Updating" mark only once it has taken this long, as useOverview does. */
const SLOW_MS = 600;

/**
 * Refetches a page result from its own route on an interval, pausing while the tab is hidden,
 * the same way useOverview does. Only live API data polls: the preview fixture is static, and
 * re-reading it would undo the local effects of the preview's actions.
 *
 * One request runs at a time. A local write (setResult) wins over any poll already in flight,
 * and `hold()` drops polls entirely while an optimistic change waits on its save, so a snapshot
 * read before the save never flips the screen back. `accept` can turn a snapshot away, so a
 * page keeps its last good data through a failed read. `refreshing` turns on only when a poll is
 * slow, so a quick one never flashes the "Updating" mark.
 */
export function usePoll<T extends { source: string }>(initial: T, url: string, ms: number, accept: (next: T) => boolean = () => true) {
  const [result, setLocal] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const alive = useRef(false);
  const inFlight = useRef(false);
  const version = useRef(0);
  const holds = useRef(0);

  const setResult = useCallback((next: SetStateAction<T>) => {
    version.current++;
    setLocal(next);
  }, []);

  const accepts = useRef(accept);
  useEffect(() => {
    accepts.current = accept;
  });

  const pull = useCallback(async () => {
    if (document.hidden || inFlight.current || holds.current) return;
    inFlight.current = true;
    const seen = version.current;
    const slow = setTimeout(() => {
      if (alive.current) setRefreshing(true);
    }, SLOW_MS);
    try {
      const res = await apiFetch(url, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as T;
      if (alive.current && seen === version.current && !holds.current && accepts.current(body)) setLocal(body);
    } catch {
      // Keep the last good snapshot; the next tick retries.
    } finally {
      clearTimeout(slow);
      inFlight.current = false;
      if (alive.current) setRefreshing(false);
    }
  }, [url]);

  useEffect(() => {
    alive.current = true;
    if (initial.source !== "api") {
      return () => {
        alive.current = false;
      };
    }
    // `pull` never rejects (it catches everything), so nothing is lost by not awaiting it here.
    const id = setInterval(() => void pull(), ms);
    const onVisible = () => {
      if (!document.hidden) void pull();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [initial.source, ms, pull]);

  /** Pauses polling until the returned release runs; safe to release more than once. */
  const hold = useCallback(() => {
    holds.current++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      holds.current--;
    };
  }, []);

  return { result, setResult, refreshing, hold };
}

/** Follows a restore's job, for followRestore. */
export const readRestore = (runId: string) => (jobId: string) => callJson<RestoreProgress>(`/api/backups/${encodeURIComponent(runId)}/restore/${encodeURIComponent(jobId)}`);

/** What an elevated write on these pages needs the check for, as "Confirm it is you" says it. */
const WHAT: Array<[RegExp, string]> = [
  [/^\/api\/server\/updates\/apply$/, "Installing an update"],
  [/^\/api\/server\/updates\/rollback$/, "Rolling back Dockify"],
  [/^\/api\/server\/updates\/policy$/, "Changing the update policy"],
  [/^\/api\/backups\/[^/]+\/restore$/, "Restoring a backup"],
  [/^\/api\/backups\/orphans\//, "Deleting backups"],
  [/^\/api\/backups\/schedules\//, "Changing a backup schedule"],
];

/**
 * Sends JSON to one of this app's routes; resolves to the body or throws its error (with the
 * route's `code`). An elevated write the API refuses for a missing step-up asks "Confirm it is you"
 * and is sent once more; closing that dialog throws an error `wasCancelled` (components/step-up) reads.
 */
export function send<T>(url: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  const what = WHAT.find(([re]) => re.test(url))?.[1];
  return elevateThrowing(async () => {
    const r = await callJson<T>(url, { method, body });
    if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code });
    return (r.data ?? {}) as T;
  }, { what });
}
