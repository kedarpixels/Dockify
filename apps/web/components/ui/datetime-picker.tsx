"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { Icon } from "@/components/icon";
import { MONTHS, timeParts } from "@/lib/format";
import { useOutsidePress } from "@/lib/hooks";
import { isTopLayer, openLayer } from "@/lib/modal";
import { useTimePrefs } from "@/lib/time-prefs";
import type { TimePrefs } from "@/lib/types";
import type { FieldIds } from "./field";
import { Segmented, type SegmentOption } from "./segmented";

// The value is the same "YYYY-MM-DDTHH:mm" wall clock string a datetime-local input uses. The open
// calendar is portaled to the body, so a dialog's scrolling body never clips it.

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MERIDIEM: SegmentOption<"am" | "pm">[] = [
  { value: "am", label: "AM" },
  { value: "pm", label: "PM" },
];

/* GAP is the room between the trigger and the calendar; EDGE is the margin the calendar keeps inside the viewport. */
const GAP = 6;
const EDGE = 8;

const pad = (n: number) => String(n).padStart(2, "0");

interface Day {
  y: number;
  /** 0 to 11. */
  mo: number;
  d: number;
}

interface Parts extends Day {
  h: number;
  mi: number;
}

function parse(v: string): Parts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  return m ? { y: +m[1]!, mo: +m[2]! - 1, d: +m[3]!, h: +m[4]!, mi: +m[5]! } : null;
}
const format = (p: Parts) => `${p.y}-${pad(p.mo + 1)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
const ord = (p: Day) => p.y * 10000 + (p.mo + 1) * 100 + p.d;
const daysIn = (y: number, mo: number) => new Date(y, mo + 1, 0).getDate();
const weekday = (p: Day) => new Date(p.y, p.mo, p.d, 12).getDay();

/** Calendar arithmetic at noon, so a zone whose clocks jump at midnight never lands on the wrong day. */
function dayOf(y: number, mo: number, d: number): Day {
  const t = new Date(y, mo, d, 12);
  return { y: t.getFullYear(), mo: t.getMonth(), d: t.getDate() };
}

/** The same day `n` months on, pulled back to the last day of a shorter month. */
function shiftMonth(p: Day, n: number): Day {
  const first = dayOf(p.y, p.mo + n, 1);
  return { ...first, d: Math.min(p.d, daysIn(first.y, first.mo)) };
}

function nowIn(prefs: TimePrefs): Parts {
  const p = timeParts(Date.now(), { prefs });
  if (p) return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute };
  const n = new Date();
  return { y: n.getFullYear(), mo: n.getMonth(), d: n.getDate(), h: n.getHours(), mi: n.getMinutes() };
}

/* The day grid and the AM/PM switch each keep a single tab stop. */
const tabbables = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")].filter((el) => el.tabIndex >= 0);

/** Like Enter in a field: through the form's default (first) submit button, and not at all while it is disabled. */
function submitLikeEnter(form: HTMLFormElement | null | undefined) {
  if (!form) return;
  const main = [...form.elements].find(
    (el): el is HTMLButtonElement | HTMLInputElement => (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) && el.type === "submit",
  );
  if (main?.disabled) return;
  form.requestSubmit(main);
}

export function DateTimePicker({
  value,
  onChange,
  min,
  max,
  hour12,
  id,
  ids,
  label,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  min?: string;
  max?: string;
  /** Defaults to the signed-in user's clock. */
  hour12?: boolean;
  id?: string;
  ids?: FieldIds;
  /** Accessible name for the trigger and the calendar. */
  label: string;
  autoFocus?: boolean;
}) {
  const prefs = useTimePrefs();
  const twelve = hour12 ?? prefs.hour12;
  const uid = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const minute = useRef<HTMLInputElement>(null);

  const picked = parse(value);
  const cur = picked ?? nowIn(prefs);
  const [view, setView] = useState({ y: cur.y, mo: cur.mo });
  // The day holding the grid's one tab stop once a click or an arrow key has moved it.
  const [active, setActive] = useState<Day | null>(null);
  // Set by the arrow keys only, so focus follows the active day for the keyboard and never on its own.
  const moveFocus = useRef(false);

  const minD = min ? parse(min) : null;
  const maxD = max ? parse(max) : null;
  const inRange = (p: Day) => (!minD || ord(p) >= ord(minD)) && (!maxD || ord(p) <= ord(maxD));
  const clampDay = (p: Day): Day => (minD && ord(p) < ord(minD) ? minD : maxD && ord(p) > ord(maxD) ? maxD : p);

  const show = () => {
    setView({ y: cur.y, mo: cur.mo });
    setActive(null);
    setOpen(true);
  };

  // Esc and the trigger give focus back to the trigger; a click elsewhere keeps the focus it made.
  const hide = (refocus: boolean) => {
    if (refocus) trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  };

  // The trigger does not count as outside: its own click toggles the calendar.
  useOutsidePress(open, [panel, trigger], () => hide(false), true);

  // Enter makes the choice final. The flush commits the value and closes the calendar before the
  // form submits, so the form's handler reads the new value, not the one from the last render.
  const confirm = (next: Parts) => {
    trigger.current?.focus({ preventScroll: true });
    flushSync(() => {
      onChange(format(next));
      setOpen(false);
    });
    submitLikeEnter(trigger.current?.form);
  };

  useLayoutEffect(() => {
    const t = trigger.current;
    const p = panel.current;
    if (!open || !t || !p) return;

    // Inside a modal the calendar is the top layer while open, so the dialog under it neither pulls
    // focus back nor answers Tab or Esc. On a page there is nothing to hold back, and no scroll lock.
    const layer = t.closest("[aria-modal='true']") ? `${uid}-layer` : null;
    const release = layer ? openLayer(layer) : null;

    // Under the trigger, or above it when the calendar does not fit below and fits better above;
    // then kept at least EDGE inside the viewport on every side.
    const place = () => {
      const r = t.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const h = p.offsetHeight;
      const below = vh - EDGE - GAP - r.bottom;
      const above = r.top - GAP - EDGE;
      const up = h > below && above > below;
      const top = up ? r.top - GAP - h : r.bottom + GAP;
      p.style.top = `${Math.round(Math.max(EDGE, Math.min(top, vh - EDGE - h)))}px`;
      p.style.left = `${Math.round(Math.max(EDGE, Math.min(r.left, vw - EDGE - p.offsetWidth)))}px`;
      p.dataset.side = up ? "top" : "bottom";
    };
    place();
    (p.querySelector<HTMLElement>(".dtp-day[tabindex='0']") ?? tabbables(p)[0])?.focus({ preventScroll: true });

    // A six-week month is taller and the trigger can move, so both are observed. Scroll capture
    // hears every scroller (a dialog body, the page), so the calendar follows its trigger.
    const ro = new ResizeObserver(place);
    ro.observe(p);
    ro.observe(t);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);

    // Capture runs before any bubbling Esc handler, and the calendar keeps this Esc to itself, so
    // the first Esc closes only the calendar and a second one reaches the dialog.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || (layer && !isTopLayer(layer))) return;
      e.preventDefault();
      e.stopPropagation();
      hide(true);
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("keydown", onKey, true);
      release?.();
    };
  }, [open, uid]);

  // After an arrow key, focus follows the active day, into the next or previous month if it crossed one.
  useLayoutEffect(() => {
    if (!moveFocus.current || !active) return;
    moveFocus.current = false;
    panel.current?.querySelector<HTMLElement>(`.dtp-day[data-day="${active.d}"]`)?.focus({ preventScroll: true });
  }, [active, view]);

  // Tab walks the calendar. Past either end it closes onto the trigger; going forward, the browser's
  // own Tab then carries on from the trigger, as if the calendar sat in the tab order right after it.
  const onPanelKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !panel.current) return;
    const items = tabbables(panel.current);
    if (document.activeElement !== (e.shiftKey ? items[0] : items.at(-1))) return;
    if (e.shiftKey) e.preventDefault();
    trigger.current?.focus({ preventScroll: true });
    flushSync(() => setOpen(false));
  };

  // The usual calendar keys: arrows by day and week, Home and End within the week, Page Up and Down by month (year with Shift).
  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const d = Number((e.target as HTMLElement).closest<HTMLElement>(".dtp-day")?.dataset.day);
    if (!d) return;
    const from: Day = { y: view.y, mo: view.mo, d };
    if (e.key === "Enter") {
      e.preventDefault();
      confirm({ ...cur, ...from });
      return;
    }
    const moves: Record<string, () => Day> = {
      ArrowLeft: () => dayOf(from.y, from.mo, from.d - 1),
      ArrowRight: () => dayOf(from.y, from.mo, from.d + 1),
      ArrowUp: () => dayOf(from.y, from.mo, from.d - 7),
      ArrowDown: () => dayOf(from.y, from.mo, from.d + 7),
      Home: () => dayOf(from.y, from.mo, from.d - weekday(from)),
      End: () => dayOf(from.y, from.mo, from.d + 6 - weekday(from)),
      PageUp: () => shiftMonth(from, e.shiftKey ? -12 : -1),
      PageDown: () => shiftMonth(from, e.shiftKey ? 12 : 1),
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    const next = clampDay(move());
    moveFocus.current = true;
    setActive(next);
    setView({ y: next.y, mo: next.mo });
  };

  const pickDay = (d: number) => {
    setActive({ y: view.y, mo: view.mo, d });
    onChange(format({ ...cur, y: view.y, mo: view.mo, d }));
  };

  const setTime = (h: number, mi: number) => onChange(format({ ...cur, h, mi }));
  const pm = cur.h >= 12;
  // A 12-hour field shows 1 to 12; which half of the day it is comes from the AM/PM switch.
  const toH24 = (shown: number) => (twelve ? (shown % 12) + (pm ? 12 : 0) : shown);
  const shownHour = twelve ? cur.h % 12 || 12 : cur.h;

  // The trigger reads in the app's one absolute format: "30 Oct 2026, 14:05", or "30 Oct 2026, 2:05 PM".
  const clock = twelve ? `${shownHour}:${pad(cur.mi)} ${pm ? "PM" : "AM"}` : `${pad(cur.h)}:${pad(cur.mi)}`;
  const display = picked ? `${cur.d} ${MONTHS[cur.mo]} ${cur.y}, ${clock}` : "Pick a date";

  // Month keys stay focusable at the edge of the allowed range (aria-disabled, not disabled), so
  // focus is never dropped onto the page from under the calendar.
  const noPrev = !!minD && view.y * 12 + view.mo <= minD.y * 12 + minD.mo;
  const noNext = !!maxD && view.y * 12 + view.mo >= maxD.y * 12 + maxD.mo;
  const turn = (n: number) =>
    setView((v) => {
      const f = dayOf(v.y, v.mo + n, 1);
      return { y: f.y, mo: f.mo };
    });

  const lead = new Date(view.y, view.mo, 1).getDay();
  const cells: Array<number | null> = [...Array<null>(lead).fill(null), ...Array.from({ length: daysIn(view.y, view.mo) }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
  const usable = (d: number) => inRange({ y: view.y, mo: view.mo, d });
  const inView = (p: Day | null): p is Day => !!p && p.y === view.y && p.mo === view.mo;
  // The grid keeps a single tab stop: the day the keys moved to, else the chosen day, else the first open one.
  const stop = inView(active) && usable(active.d) ? active.d : inView(picked) && usable(picked.d) ? picked.d : (cells.find((d): d is number => d !== null && usable(d)) ?? null);

  return (
    <div className="dtp" data-open={open}>
      <button
        ref={trigger}
        type="button"
        id={id ?? ids?.id}
        className="dtp-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${uid}-cal` : undefined}
        aria-label={`${label}, ${display}`}
        aria-describedby={ids?.describedBy}
        aria-invalid={ids?.invalid || undefined}
        autoFocus={autoFocus}
        onClick={() => (open ? hide(true) : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            show();
          }
        }}
      >
        <Icon name="calendar" size={16} />
        <span className="dtp-value num">{display}</span>
        <Icon name="chevronDown" size={16} />
      </button>

      {open
        ? createPortal(
            <div ref={panel} id={`${uid}-cal`} className="dtp-pop" role="dialog" aria-label={label} onKeyDown={onPanelKey}>
              <div className="dtp-head">
                <button type="button" className="dtp-nav" aria-label="Previous month" aria-disabled={noPrev || undefined} onClick={() => !noPrev && turn(-1)}>
                  <Icon name="chevronLeft" size={16} />
                </button>
                <span id={`${uid}-month`} className="dtp-month" aria-live="polite">
                  {MON[view.mo]} {view.y}
                </span>
                <button type="button" className="dtp-nav" aria-label="Next month" aria-disabled={noNext || undefined} onClick={() => !noNext && turn(1)}>
                  <Icon name="chevronRight" size={16} />
                </button>
              </div>

              <div className="dtp-grid" role="grid" aria-labelledby={`${uid}-month`} onKeyDown={onGridKey}>
                <div className="dtp-row" role="row">
                  {DOW.map((d, i) => (
                    <span key={d} className="dtp-dow" role="columnheader" aria-label={DOW_LONG[i]}>
                      {d}
                    </span>
                  ))}
                </div>
                {weeks.map((week, w) => (
                  <div key={w} className="dtp-row" role="row">
                    {week.map((d, i) =>
                      d === null ? (
                        <span key={`e${i}`} className="dtp-cell" role="gridcell" />
                      ) : (
                        <span key={d} className="dtp-cell" role="gridcell" aria-selected={inView(picked) && picked.d === d}>
                          <button
                            type="button"
                            className="dtp-day"
                            data-day={d}
                            tabIndex={d === stop ? 0 : -1}
                            disabled={!usable(d)}
                            aria-label={`${DOW_LONG[(lead + d - 1) % 7]}, ${d} ${MON[view.mo]} ${view.y}`}
                            onClick={() => pickDay(d)}
                          >
                            {d}
                          </button>
                        </span>
                      ),
                    )}
                  </div>
                ))}
              </div>

              <div className="dtp-time" role="group" aria-label="Time">
                <Icon name="clock" size={16} />
                <TimeField
                  label="Hours"
                  value={shownHour}
                  lo={twelve ? 1 : 0}
                  hi={twelve ? 12 : 23}
                  next={minute}
                  onSet={(n) => setTime(toH24(n), cur.mi)}
                  onEnter={(n) => confirm({ ...cur, h: toH24(n) })}
                />
                <span className="dtp-colon" aria-hidden="true">
                  :
                </span>
                <TimeField inputRef={minute} label="Minutes" value={cur.mi} lo={0} hi={59} onSet={(n) => setTime(cur.h, n)} onEnter={(n) => confirm({ ...cur, mi: n })} />
                {twelve ? (
                  <Segmented label="AM or PM" value={pm ? "pm" : "am"} options={MERIDIEM} onChange={(m) => setTime((cur.h % 12) + (m === "pm" ? 12 : 0), cur.mi)} />
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** Two digits, or one that no second digit could follow ("7" for an hour), finish the part and hand focus to `next`. */
function TimeField({
  label,
  value,
  lo,
  hi,
  onSet,
  onEnter,
  next,
  inputRef,
}: {
  label: string;
  value: number;
  lo: number;
  hi: number;
  onSet: (n: number) => void;
  onEnter: (n: number) => void;
  next?: React.RefObject<HTMLInputElement | null>;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  // The digits as typed ("1" on the way to "14"); null shows the value padded to two digits.
  const [draft, setDraft] = useState<string | null>(null);
  // A click selects the value on focus, and its own mouseup would collapse that selection again.
  const keep = useRef(false);
  // Out of range reads as the top of the range: 75 minutes is 59, and a 12-hour "0" is 12.
  const fit = (n: number) => (n < lo || n > hi ? hi : n);
  // After React writes the new value the caret sits at the end; selecting again lets typing replace it.
  const reselect = (el: HTMLInputElement) =>
    requestAnimationFrame(() => {
      if (document.activeElement === el) el.select();
    });

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={2}
      autoComplete="off"
      spellCheck={false}
      enterKeyHint="done"
      role="spinbutton"
      aria-label={label}
      aria-valuemin={lo}
      aria-valuemax={hi}
      aria-valuenow={value}
      className="field dtp-num num"
      value={draft ?? pad(value)}
      onFocus={(e) => {
        setDraft(null);
        e.currentTarget.select();
      }}
      onPointerDown={(e) => {
        keep.current = document.activeElement !== e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (keep.current) e.preventDefault();
        keep.current = false;
      }}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        const text = e.target.value;
        if (/\D/.test(text)) return;
        if (!text) return setDraft("");
        onSet(fit(Number(text)));
        if (text.length === 2 || Number(text) * 10 > hi) {
          setDraft(null);
          if (next?.current) next.current.focus();
          else reselect(e.currentTarget);
        } else setDraft(text);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const span = hi - lo + 1;
          onSet(lo + ((value - lo + (e.key === "ArrowUp" ? 1 : span - 1)) % span));
          setDraft(null);
          reselect(e.currentTarget);
        } else if (e.key === "Enter") {
          e.preventDefault();
          onEnter(value);
        }
      }}
    />
  );
}
