"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useCopy } from "@/components/ui/copy-button";
import { PendingButton } from "@/components/ui/pending";
import { selectedText } from "@/lib/download";
import { clause, plural } from "@/lib/format";
import { useHydrated } from "@/lib/hooks";
import { LogAnnouncer } from "./log-announcer";
import { CHUNK, ROW } from "./log-dom";
import { useLogWindow } from "./use-log-window";
import { LogRows, type AppMeta } from "./log-rows";
import type { RuntimeLogLine } from "./model";

/*
 * The virtualised log surface, the same approach as the build log viewer: lines render in chunks
 * of 200 and only the chunks near the viewport mount; the rest are spacers sized from measured
 * (or estimated) heights. Chunks are keyed by position (`base` + index), so loading older lines
 * on top or trimming the oldest never re-renders the chunks on screen (LogRows compares the lines
 * it holds), and the view stays anchored on the row it showed.
 *
 * Following pins the view to the newest line. Scrolling up pauses the tail, scrolling back to the
 * end resumes it. A time is a permalink: a click copies a link to a window around the line.
 *
 * The box is a log for assistive tech but not a live region: lines stream faster than speech, so
 * LogAnnouncer sums them up every few seconds instead.
 */

const LINE_HASH = /^#L-([\w.:~-]{1,128})$/;
const hashLine = (hash: string) => LINE_HASH.exec(hash)?.[1];

export function LogList({
  lines,
  base,
  apps,
  re,
  wrap,
  follow,
  onPause,
  fresh,
  pinKey,
  older,
  status,
  permalink,
}: {
  lines: RuntimeLogLine[];
  base: number;
  apps: Map<string, AppMeta>;
  re: RegExp | null;
  wrap: boolean;
  /** Pinned to the newest line (live and not paused). */
  follow: boolean;
  /** Pauses or resumes the tail; only called while the stream is live. */
  onPause?: (on: boolean) => void;
  /** Lines waiting while paused, for the pill. */
  fresh: number;
  /** A new value lands the view on the newest line once (a new filter set). */
  pinKey: string;
  older: { more: boolean; trimmed: boolean; pending: boolean; error?: string; load: () => void };
  /** Replaces the rows while loading, empty or failed. */
  status?: React.ReactNode;
  /** The link a line's time copies. */
  permalink: (line: RuntimeLogLine) => string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const mounted = useHydrated();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // Chunks by position: key k holds the positions k * CHUNK up to the next multiple, clipped to the
  // lines held, so a prepend or a trim leaves every other chunk's lines where they were.
  const end = base + lines.length;
  const keys: number[] = [];
  const spans: Array<[from: number, to: number]> = [];
  if (lines.length) {
    for (let k = Math.floor(base / CHUNK); k * CHUNK < end; k++) {
      keys.push(k);
      spans.push([Math.max(k * CHUNK, base) - base, Math.min((k + 1) * CHUNK, end) - base]);
    }
  }
  // Heights go by position key; a chunk not measured yet is estimated from its lines.
  const { setHeights, onSize, offsets, total, first, last, before, after, scrollBox, centreRow, userScrolled } = useLogWindow(box, keys.length, (i) => keys[i]!, (i) => (spans[i]![1] - spans[i]![0]) * ROW);

  // Wrapping changes every chunk's height, and a new filter set is another log: either way the
  // mounted chunks measure again and the rest re-estimate. A trim drops the heights of chunks that
  // left the top, so the map never holds more than the lines do.
  const lowKey = Math.floor(base / CHUNK);
  const [measured, setMeasured] = useState({ wrap, pinKey, lowKey });
  if (wrap !== measured.wrap || pinKey !== measured.pinKey) {
    setMeasured({ wrap, pinKey, lowKey });
    setHeights(new Map());
  } else if (lowKey !== measured.lowKey) {
    setMeasured({ wrap, pinKey, lowKey });
    setHeights((m) => new Map([...m].filter(([k]) => k >= lowKey)));
  }

  /** The lines of the mounted chunks only. */
  const shown: Array<{ key: number; lines: RuntimeLogLine[] }> = [];
  if (keys.length) for (let i = first; i <= last; i++) shown.push({ key: keys[i]!, lines: lines.slice(spans[i]![0], spans[i]![1]) });

  const onScroll = () => {
    const el = box.current;
    if (!el || !userScrolled(el) || !onPause) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < ROW * 2;
    if (follow && !atEnd) onPause(true);
    else if (!follow && atEnd) onPause(false);
  };

  // Follow: after every append or remeasure, pin the view to the newest line.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !follow || !mounted) return;
    scrollBox(el, el.scrollHeight);
  }, [end, follow, mounted, total, scrollBox]);

  // A new filter set opens on its newest line, live or not.
  const pinned = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !mounted || !lines.length || pinned.current === pinKey || status) return;
    pinned.current = pinKey;
    scrollBox(el, el.scrollHeight);
  });

  // Older lines on top keep the row that was at the top of the view exactly where it was.
  const anchor = useRef<{ id: string; offset: number; base: number } | null>(null);
  const loadOlder = () => {
    const el = box.current;
    const row = el ? Array.from(el.querySelectorAll<HTMLElement>(".lx-line")).find((r) => r.offsetTop + r.offsetHeight > el.scrollTop) : undefined;
    if (el && row) anchor.current = { id: row.dataset.id!, offset: row.getBoundingClientRect().top - el.getBoundingClientRect().top, base };
    older.load();
  };
  useLayoutEffect(() => {
    const el = box.current;
    const a = anchor.current;
    if (!el || !a || a.base === base) return;
    anchor.current = null;
    // First by estimate, so the anchor's chunk stays mounted, then exactly from the real row.
    scrollBox(el, el.scrollTop + (a.base - base) * ROW);
    const row = el.querySelector<HTMLElement>(`[data-id="${CSS.escape(a.id)}"]`);
    if (row) scrollBox(el, el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset);
  }, [base, scrollBox]);

  // A jump lands near the line by offset, so its chunk mounts, then centres the real row.
  const jump = useRef<{ id: string; placed: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const want = jump.current;
    if (!el || !want || !mounted) return;
    const row = el.querySelector<HTMLElement>(`[data-id="${CSS.escape(want.id)}"]`);
    if (row) {
      jump.current = null;
      centreRow(el, row);
      return;
    }
    const idx = lines.findIndex((l) => l.id === want.id);
    if (idx < 0 || want.placed) {
      jump.current = null;
      return;
    }
    want.placed = true;
    const pos = base + idx;
    const i = keys.indexOf(Math.floor(pos / CHUNK));
    scrollBox(el, Math.max(0, offsets[i]! + (pos - Math.max(keys[i]! * CHUNK, base)) * ROW - el.clientHeight / 2));
  });

  // #L-id in the URL marks that line and, once it is loaded, scrolls to it and pauses the tail.
  const [target, setTarget] = useState<string | undefined>(undefined);
  const wanted = useRef<string | undefined>(undefined);
  useEffect(() => {
    const read = () => {
      const id = hashLine(window.location.hash);
      setTarget(id);
      wanted.current = id;
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const reveal = useEffectEvent((id: string) => {
    if (follow) onPause?.(true);
    pinned.current = pinKey;
    jump.current = { id, placed: false };
    rerender();
  });
  useEffect(() => {
    const id = wanted.current;
    if (!mounted || id === undefined || !lines.some((l) => l.id === id)) return;
    wanted.current = undefined;
    reveal(id);
  }, [mounted, lines, target]);

  // Clicking a time copies its permalink and marks the line, without a page jump.
  const link = useCopy();
  const [linkId, setLinkId] = useState<string | undefined>(undefined);
  const onBoxClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.lx-ts");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    const id = hashLine(a.hash);
    const line = id ? lines.find((l) => l.id === id) : undefined;
    if (!line) return;
    window.history.replaceState(window.history.state, "", `#L-${line.id}`);
    setTarget(line.id);
    if (follow) onPause?.(true);
    setLinkId(line.id);
    void link.copy(permalink(line));
  };

  const onCopy = (e: React.ClipboardEvent) => {
    const sel = window.getSelection();
    if (!sel || !box.current || sel.isCollapsed || !sel.rangeCount) return;
    const out = selectedText(sel.getRangeAt(0), box.current, ".lx-line", ".lx-tx");
    if (out === null) return;
    e.clipboardData.setData("text/plain", out);
    e.preventDefault();
  };

  const inChunk = (c: RuntimeLogLine[], id?: string) => (id !== undefined && c.some((l) => l.id === id) ? id : undefined);
  const copiedId = link.state === "done" ? linkId : undefined;

  return (
    <div className="lx-stage">
      <div
        ref={box}
        className="lx-box"
        data-wrap={wrap || undefined}
        onScroll={onScroll}
        onClick={onBoxClick}
        onCopy={onCopy}
        tabIndex={0}
        role="log"
        aria-label="Runtime logs"
        aria-live="off"
        aria-busy={!mounted}
      >
        {status ? (
          <div className="lx-status">{status}</div>
        ) : mounted ? (
          <>
            <div className="lx-edge">
              {older.more ? (
                <>
                  <PendingButton className="btn btn-xs" pending={older.pending} onClick={loadOlder}>
                    {older.error ? "Try again" : "Load older lines"}
                  </PendingButton>
                  {older.error ? <span className="tone-bad">Could not load older lines. {clause(older.error)}.</span> : null}
                </>
              ) : (
                <span>{older.trimmed ? "Older lines left the view. Pick a shorter range to see them" : "Start of the range"}</span>
              )}
            </div>
            <div className="lx-rows" style={{ paddingTop: before, paddingBottom: after }}>
              {shown.map((c) => (
                <LogRows
                  key={c.key}
                  index={c.key}
                  lines={c.lines}
                  apps={apps}
                  re={re}
                  wrap={wrap}
                  targetId={inChunk(c.lines, target)}
                  copiedId={inChunk(c.lines, copiedId)}
                  onSize={onSize}
                />
              ))}
            </div>
          </>
        ) : null}
      </div>
      {fresh > 0 && !status ? (
        <button type="button" className="new-pill lx-new num" onClick={() => onPause?.(false)}>
          <span className="dot" data-tone="live" aria-hidden="true" />
          {plural(fresh, "new line")}
        </button>
      ) : null}
      {/* Keyed on the filter set: a new set of lines is a new log, not news to read out. */}
      <LogAnnouncer key={pinKey} count={end} active={!!onPause && !status} />
    </div>
  );
}
