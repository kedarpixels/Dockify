"use client";

import { useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { LogAnnouncer } from "@/components/logs/log-announcer";
import { useCopy } from "@/components/ui/copy-button";
import { SearchField } from "@/components/ui/field";
import { Rule } from "@/components/ui/rule";
import { downloadText, selectedText } from "@/lib/download";
import { plural } from "@/lib/format";
import { useHydrated } from "@/lib/hooks";
import type { LogLine } from "@/lib/pages/deployments";
import { CHUNK, ROW } from "@/components/logs/log-dom";
import { LogKeys } from "@/components/logs/log-keys";
import { useLogWindow } from "@/components/logs/use-log-window";
import { lineLevel, LogChunk, matcher } from "./log-chunk";

/*
 * Build log viewer. Lines render in chunks of 200 and only the chunks near the viewport are
 * mounted; the rest are spacers sized from measured (or estimated) heights, so a 5,000 line log
 * scrolls as smoothly as a 50 line one, wrapped or not. A chunk re-renders only when its own lines
 * change (LogChunk compares them), so appending re-renders the last chunk alone.
 *
 * Line numbers are permalinks: a click copies the page URL with #L120 and marks the line, and a
 * URL that arrives with #L120 opens scrolled to it. A selection across rows copies only the log
 * text, one line per row, without the gutter.
 *
 * The box is a log for assistive tech but not a live region: a build prints faster than speech, so
 * LogAnnouncer sums the new lines up every few seconds and says the outcome once.
 */

/** "#L120" -> 120. */
const hashLine = (hash: string) => {
  const m = /^#L(\d+)$/.exec(hash);
  return m ? Number(m[1]) : undefined;
};

export function LogViewer({
  lines,
  live,
  follow,
  onFollow,
  fileName,
  status,
  openAtError = false,
  announce = null,
}: {
  lines: LogLine[];
  /** Still printing: shows the follow toggle and the streaming note. */
  live: boolean;
  follow: boolean;
  onFollow: (on: boolean) => void;
  fileName: string;
  /** Replaces the body when the log could not be read or has no lines yet. */
  status?: React.ReactNode;
  /** A failed build opens on its first error line instead of the top. */
  openAtError?: boolean;
  /** Said to screen readers when it changes, such as "Deployment ready". */
  announce?: string | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const countId = useId();
  const mounted = useHydrated();
  const [wrap, setWrap] = useState(false);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const q = text.trim();
  const re = useMemo(() => matcher(q), [q]);

  const count = Math.ceil(lines.length / CHUNK);
  // Chunks by index; one not measured yet is estimated from its lines.
  const { setHeights, onSize, offsets, total, first, last, before, after, scrollBox, centreRow, userScrolled } = useLogWindow(box, count, (i) => i, (i) => Math.min(CHUNK, lines.length - i * CHUNK) * ROW);
  /** The lines of the mounted chunks only. */
  const shown: Array<{ index: number; lines: LogLine[] }> = [];
  if (count) for (let i = first; i <= last; i++) shown.push({ index: i, lines: lines.slice(i * CHUNK, (i + 1) * CHUNK) });

  // Search hits, one per matching line, oldest first.
  const hits = useMemo(() => (re ? lines.filter((l) => re.test(l.text)).map((l) => l.seq) : []), [lines, re]);
  const activeSeq = hits.length ? hits[Math.min(active, hits.length - 1)] : undefined;

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    // A follow pin or a jump to a line never pauses or resumes the tail; only the user does.
    if (!userScrolled(el)) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < ROW * 2;
    // Scrolling up while live pauses the tail; scrolling back to the end resumes it.
    if (live && follow && !atEnd) onFollow(false);
    else if (live && !follow && atEnd && !q) onFollow(true);
  };

  // Follow the tail: after every append or remeasure, pin the view to the last line.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !follow || !mounted) return;
    scrollBox(el, el.scrollHeight);
  }, [lines.length, follow, mounted, total, scrollBox]);

  // A jump lands near the line by offset, so its chunk mounts, then centres the real row. It runs
  // after every render, reading that render's offsets, until the row is on screen.
  const jump = useRef<{ seq: number; placed: boolean } | null>(null);
  const jumpTo = useCallback((seq: number) => {
    jump.current = { seq, placed: false };
    rerender();
  }, []);
  useLayoutEffect(() => {
    const el = box.current;
    const want = jump.current;
    if (!el || !want || !mounted) return;
    const row = el.querySelector<HTMLElement>(`[data-seq="${want.seq}"]`);
    if (row) {
      jump.current = null;
      centreRow(el, row);
      return;
    }
    const idx = lines.findIndex((l) => l.seq === want.seq);
    if (idx < 0 || want.placed) {
      jump.current = null;
      return;
    }
    want.placed = true;
    scrollBox(el, Math.max(0, offsets[Math.floor(idx / CHUNK)]! + (idx % CHUNK) * ROW - el.clientHeight / 2));
  });

  /** Moves the view to a line, pausing the tail first so the next append does not pull it away. */
  const reveal = (seq: number) => {
    if (follow) onFollow(false);
    jumpTo(seq);
  };
  const revealLater = useEffectEvent(reveal);

  // Only a new active hit moves the view, so a live append never drags it back.
  useEffect(() => {
    if (activeSeq !== undefined) revealLater(activeSeq);
  }, [activeSeq]);

  // The first error line, the usual place a failed build explains itself. Stderr alone does not
  // count: BuildKit prints its normal progress there, so a clean build has no key to jump with.
  const firstError = useMemo(() => lines.find((l) => lineLevel(l) === "error")?.seq, [lines]);
  const [flash, setFlash] = useState<number | undefined>(undefined);
  const toError = () => {
    if (firstError === undefined) return;
    reveal(firstError);
    setFlash(firstError);
  };

  // #L120 in the URL marks that line and, once it exists (a live log may still be printing it),
  // scrolls to it. A link to a line beats the open-at-error landing, so this runs first.
  const opened = useRef(false);
  const [target, setTarget] = useState<number | undefined>(undefined);
  const wanted = useRef<number | undefined>(undefined);
  useEffect(() => {
    const read = () => {
      const seq = hashLine(window.location.hash);
      setTarget(seq);
      wanted.current = seq;
      if (seq !== undefined) opened.current = true;
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  useEffect(() => {
    const seq = wanted.current;
    if (!mounted || seq === undefined || !lines.some((l) => l.seq === seq)) return;
    wanted.current = undefined;
    revealLater(seq);
  }, [mounted, lines, target]);

  // Opening a failed build lands on its first error.
  const openError = useEffectEvent(toError);
  useEffect(() => {
    if (!mounted || opened.current || !openAtError || firstError === undefined) return;
    opened.current = true;
    openError();
  }, [mounted, openAtError, firstError]);

  // Clicking a line number copies its permalink and marks the line, without a page jump.
  const link = useCopy();
  const [linkSeq, setLinkSeq] = useState<number | undefined>(undefined);
  const copiedSeq = link.state === "done" ? linkSeq : undefined;
  const onBoxClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.lg-no");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    const seq = hashLine(a.hash);
    if (seq === undefined) return;
    window.history.replaceState(window.history.state, "", `#L${seq}`);
    setTarget(seq);
    if (follow) onFollow(false);
    const url = `${window.location.origin}${window.location.pathname}${window.location.search}#L${seq}`;
    setLinkSeq(seq);
    void link.copy(url);
  };

  // A selection across rows copies only the text column. A selection inside one row is left to
  // the browser.
  const onCopy = (e: React.ClipboardEvent) => {
    const sel = window.getSelection();
    if (!sel || !box.current || sel.isCollapsed || !sel.rangeCount) return;
    const out = selectedText(sel.getRangeAt(0), box.current, ".lg-line", ".lg-tx");
    if (out === null) return;
    e.clipboardData.setData("text/plain", out);
    e.preventDefault();
  };

  // While follow is paused on a live log, count what printed since, for the "N new lines" pill.
  const paused = live && !follow;
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  if (paused && pausedAt === null) setPausedAt(lines.length);
  if (!paused && pausedAt !== null) setPausedAt(null);
  const fresh = paused && pausedAt !== null ? Math.max(0, lines.length - pausedAt) : 0;

  // The error row flash fades after a moment.
  useEffect(() => {
    if (flash === undefined) return;
    const t = setTimeout(() => setFlash(undefined), 2400);
    return () => clearTimeout(t);
  }, [flash]);

  /** Moves to the next or previous hit; a single hit is brought back into view. */
  const step = (by: number) => {
    if (!hits.length) return;
    const next = (Math.min(active, hits.length - 1) + by + hits.length) % hits.length;
    setActive(next);
    if (hits[next] === activeSeq) reveal(hits[next]!);
  };

  /** Enter in the search moves to the next hit, Shift Enter to the previous one. */
  const onFindKey = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || e.target !== field.current) return;
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  };

  /** The log text for Copy all, joined only when it is pressed. */
  const allText = async () => lines.map((l) => l.text).join("\n");

  const download = () => downloadText(fileName, lines.map((l) => `${l.ts} ${l.stream === "stderr" ? "ERR" : "OUT"} ${l.text}`).join("\n"));

  // Wrapping changes every chunk's height: the mounted ones measure again, the rest re-estimate.
  const toggleWrap = () => {
    setHeights(new Map());
    setWrap(!wrap);
  };

  const digits = String(lines.at(-1)?.seq ?? 1).length;
  const within = (c: LogLine[], seq?: number) => (seq !== undefined && c[0]!.seq <= seq && c.at(-1)!.seq >= seq ? seq : undefined);

  return (
    <div className="lg" data-wrap={wrap || undefined} style={{ ["--lg-digits" as string]: Math.max(3, digits) }}>
      <div className="toolbar lg-tools" onKeyDown={onFindKey}>
        <SearchField
          value={text}
          onChange={(v) => {
            setText(v);
            setActive(0);
          }}
          inputRef={field}
          label="Search build log"
          placeholder="Search log lines"
          describedBy={q ? countId : undefined}
        >
          {/* Only a query brings its count and the previous and next keys, and they sit inside the
              field the way the regex key does on /logs, so typing never grows the toolbar. */}
          {q ? (
            <>
              <span id={countId} className="lg-count num" aria-live="polite">
                {hits.length ? `${(Math.min(active, hits.length - 1) + 1).toLocaleString("en-US")} of ${hits.length.toLocaleString("en-US")}` : "No matches"}
              </span>
              <span className="lg-keys">
                <button
                  type="button"
                  className="btn btn-xs btn-icon"
                  aria-label="Previous match"
                  data-tip="Previous match, Shift Enter"
                  data-tip-side="bottom"
                  disabled={!hits.length}
                  onClick={() => step(-1)}
                >
                  <Icon name="chevronUp" />
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-icon"
                  aria-label="Next match"
                  data-tip="Next match, Enter"
                  data-tip-side="bottom"
                  disabled={!hits.length}
                  onClick={() => step(1)}
                >
                  <Icon name="chevronDown" />
                </button>
              </span>
            </>
          ) : null}
        </SearchField>
        <span className="lg-keys lg-keys-end">
          {live ? (
            <button type="button" className="btn" aria-pressed={follow} onClick={() => onFollow(!follow)}>
              Follow
            </button>
          ) : null}
          {firstError !== undefined && !live ? (
            <button type="button" className="btn btn-icon" aria-label="Jump to first error" data-tip="Jump to first error" onClick={toError}>
              <Icon name="alert" />
            </button>
          ) : null}
          <LogKeys wrap={wrap} onWrap={toggleWrap} allText={allText} empty={lines.length === 0} download={download} />
        </span>
      </div>
      <Rule />

      <div className="lg-stage">
        <div
          ref={box}
          className="lg-box"
          onScroll={onScroll}
          onClick={onBoxClick}
          onCopy={onCopy}
          tabIndex={0}
          role="log"
          aria-label="Build log"
          aria-live="off"
          aria-busy={!mounted}
        >
          {status ? (
            <div className="lg-status">{status}</div>
          ) : mounted ? (
            <div className="lg-rows" style={{ paddingTop: before, paddingBottom: after }}>
              {shown.map((c) => (
                <LogChunk
                  key={c.index}
                  index={c.index}
                  lines={c.lines}
                  re={re}
                  wrap={wrap}
                  activeSeq={within(c.lines, activeSeq)}
                  flashSeq={within(c.lines, flash)}
                  targetSeq={within(c.lines, target)}
                  copiedSeq={within(c.lines, copiedSeq)}
                  onSize={onSize}
                />
              ))}
            </div>
          ) : null}
        </div>
        {fresh > 0 && !status ? (
          <button type="button" className="new-pill lg-new num" onClick={() => onFollow(true)}>
            <span className="dot" data-tone="live" aria-hidden="true" />
            {plural(fresh, "new line")}
          </button>
        ) : null}
      </div>
      <LogAnnouncer count={lines.length} active={live} message={announce} />
    </div>
  );
}
