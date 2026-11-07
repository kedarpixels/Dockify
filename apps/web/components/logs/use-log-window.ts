"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * The virtual window of a chunked log, shared by the runtime log explorer and the build log viewer:
 * which chunks are near the view, the spacers for the rest, and the scrolls the log makes itself.
 * `keyOf` names chunk i in the measured heights; `estimate` sizes it until it has been measured.
 */
export function useLogWindow(box: RefObject<HTMLDivElement | null>, count: number, keyOf: (i: number) => number, estimate: (i: number) => number) {
  const [view, setView] = useState({ top: 0, height: 560 });
  const [heights, setHeights] = useState<ReadonlyMap<number, number>>(() => new Map());

  // The window follows the box's real height, which changes with the viewport.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [box]);

  const onSize = useCallback((key: number, h: number) => {
    setHeights((m) => (m.get(key) === h ? m : new Map(m).set(key, h)));
  }, []);

  const sizeOf = (i: number) => heights.get(keyOf(i)) ?? estimate(i);
  const offsets: number[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    offsets.push(total);
    total += sizeOf(i);
  }
  const overscan = view.height;
  let first = 0;
  while (first < count - 1 && offsets[first]! + sizeOf(first) < view.top - overscan) first++;
  let last = first;
  while (last < count - 1 && offsets[last + 1]! < view.top + view.height + overscan) last++;
  const before = offsets[first] ?? 0;
  const after = count ? total - (offsets[last]! + sizeOf(last)) : 0;

  // Every scroll the log makes itself is remembered, so onScroll can tell it from the user's.
  const wrote = useRef<number | null>(null);
  const scrollBox = useCallback((el: HTMLDivElement, top: number) => {
    el.scrollTop = top;
    wrote.current = el.scrollTop;
    setView({ top: el.scrollTop, height: el.clientHeight });
  }, []);
  /** The real row in the middle of the view. */
  const centreRow = (el: HTMLDivElement, row: HTMLElement) =>
    scrollBox(el, el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight / 2 + row.offsetHeight / 2);
  /** For onScroll: keeps the window current and answers whether this scroll was the user's own. */
  const userScrolled = (el: HTMLDivElement) => {
    setView({ top: el.scrollTop, height: el.clientHeight });
    if (wrote.current !== null && Math.abs(el.scrollTop - wrote.current) < 1) return false;
    wrote.current = null;
    return true;
  };

  return { setHeights, onSize, offsets, total, first, last, before, after, scrollBox, centreRow, userScrolled };
}

/** A chunk's element: it reports its height now, whenever it resizes, and again after a wrap toggle. */
export function useChunkHeight(key: number, onSize: (key: number, height: number) => void, wrap: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    onSize(key, el.offsetHeight);
    const ro = new ResizeObserver(() => onSize(key, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [key, onSize, wrap]);
  return ref;
}
