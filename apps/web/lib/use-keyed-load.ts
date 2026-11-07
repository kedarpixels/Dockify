"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/*
 * The one way a range or a filter that refetches reads its data. Data belongs to the key it was
 * asked for, so another key's values can never show under the picked label:
 *
 *   - a key with no answer yet has `data: null` and `loading: true`, so the caller draws its
 *     same-size skeleton;
 *   - a key answered earlier shows at once and is asked again in the background (`loading` stays
 *     true until the new answer lands), and a failed refresh keeps what it has;
 *   - moving to another key aborts the request, and a late answer is dropped;
 *   - `seed` is data the page already holds for one key (a server render, a poll): it always wins,
 *     and that key asks nothing.
 *
 *   const q = useKeyedLoad(range, (r, signal) => read(r, signal));
 *   q.data ? <Chart points={q.data} /> : q.error ? <Failed onRetry={q.reload} /> : <Skeleton />
 */

export type KeyedAnswer<T> = { data: T | null; error?: string | null } | { error: string; aborted?: boolean };

interface Entry<T> {
  data: T | null;
  error: string | null;
}

export function useKeyedLoad<T>(key: string, load: (key: string, signal: AbortSignal) => Promise<KeyedAnswer<T>>, seed?: { key: string; data: T } | null) {
  const [entries, setEntries] = useState<Record<string, Entry<T>>>({});
  const [nonce, setNonce] = useState(0);
  // The request the last answer belongs to: until it matches this one, the key is loading.
  const [answered, setAnswered] = useState<string | null>(null);
  // Data from whichever key answered last, for what does not depend on the key (a "right now" card).
  const [latest, setLatest] = useState<T | null>(null);
  const reader = useRef(load);
  useEffect(() => {
    reader.current = load;
  }, [load]);

  const seeded = seed?.key === key;
  const request = `${key}#${nonce}`;

  useEffect(() => {
    if (seeded) return;
    const ctrl = new AbortController();
    void reader.current(key, ctrl.signal).then((r) => {
      if (ctrl.signal.aborted) return;
      setAnswered(request);
      if ("data" in r) {
        if (r.data) setLatest(r.data);
        setEntries((s) => ({ ...s, [key]: { data: r.data, error: r.error ?? null } }));
      } else if (!r.aborted) {
        setEntries((s) => ({ ...s, [key]: { data: s[key]?.data ?? null, error: r.error } }));
      }
    });
    return () => ctrl.abort();
  }, [key, request, seeded]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  /** Local edits after a write, until the next read. */
  const patch = useCallback((fn: (d: T) => T) => setEntries((s) => (s[key]?.data ? { ...s, [key]: { ...s[key], data: fn(s[key].data) } } : s)), [key]);

  const entry = entries[key];
  return {
    data: seeded ? seed.data : (entry?.data ?? null),
    latest: seeded ? seed.data : latest,
    error: seeded ? null : (entry?.error ?? null),
    loading: !seeded && answered !== request,
    reload,
    patch,
  };
}
