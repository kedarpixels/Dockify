"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChartTooltip, type TooltipRow } from "@/components/chart-tooltip";
import { dayLabel, duration } from "@/lib/format";
import { pctText, type DayState, type StatusDay } from "@/lib/pages/status-page-shared";

/* Keep the tooltip this far inside the viewport. */
const EDGE = 8;

/* A health strip, not a chart: a healthy day is green like every "operational" dot on the page. */
const COLOR: Record<DayState, string> = {
  ok: "var(--ok)",
  minor: "var(--warn)",
  major: "var(--bad)",
  none: "var(--heat-0)",
};

const STATE_TEXT: Record<DayState, string> = {
  ok: "no incidents",
  minor: "degraded",
  major: "outage",
  none: "no data",
};

/** One day's uptime: minutes down over the minutes the day has had so far. */
function dayPct(d: StatusDay, today: string) {
  if (d.state === "none") return null;
  const span = d.date === today ? Math.max(1, Math.floor((Date.now() % 86_400_000) / 60_000)) : 1440;
  return ((span - Math.min(span, d.downMinutes)) / span) * 100;
}

function rows(d: StatusDay, today: string): TooltipRow[] {
  if (d.state === "none") return [{ label: "No data", value: "", color: COLOR.none }];
  const out: TooltipRow[] = [{ label: "Uptime", value: pctText(dayPct(d, today)), color: COLOR[d.state] }];
  if (d.downMinutes) out.push({ label: "Outage", value: duration(d.downMinutes * 60), color: COLOR.major });
  if (d.degradedMinutes) out.push({ label: "Degraded", value: duration(d.degradedMinutes * 60), color: COLOR.minor });
  return out;
}

const spoken = (d: StatusDay, today: string, isToday: boolean) =>
  `${isToday ? "Today" : dayLabel(d.date)}, ${STATE_TEXT[d.state]}${d.state === "none" ? "" : `, ${pctText(dayPct(d, today))} uptime`}`;

/** Narrow screens show the most recent days only (CSS), and the arrow keys stay inside the visible ones. */
export function UptimeBar({ name, days, summary }: { name: string; days: StatusDay[]; summary: string }) {
  const barRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; top: number; bottom: number } | null>(null);
  const [place, setPlace] = useState({ dx: 0, flip: false });
  const today = days.at(-1)?.date ?? "";

  const show = useCallback((i: number | null) => {
    setActive(i);
    const cell = i === null ? null : barRef.current?.children[i];
    if (!(cell instanceof HTMLElement)) return setAnchor(null);
    const r = cell.getBoundingClientRect();
    setAnchor({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
  }, []);

  // The tooltip lives in a fixed layer on <body>, so a scroll or a resize leaves it stale.
  const open = anchor !== null;
  useEffect(() => {
    if (!open) return;
    const hide = () => show(null);
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, { capture: true });
      window.removeEventListener("resize", hide);
    };
  }, [open, show]);

  // Keep the card inside the viewport: slide it sideways (the caret stays on the day) and flip it
  // under the bar when there is no room above.
  useLayoutEffect(() => {
    const el = tipRef.current?.querySelector<HTMLElement>(".ctip");
    if (!anchor || !el) return;
    const r = el.getBoundingClientRect();
    const left = r.left - place.dx;
    const max = Math.max(0, r.width / 2 - 14);
    let dx = 0;
    if (left < EDGE) dx = EDGE - left;
    else if (left + r.width > window.innerWidth - EDGE) dx = window.innerWidth - EDGE - (left + r.width);
    dx = Math.max(-max, Math.min(max, Math.round(dx)));
    const flip = anchor.top - 16 - r.height < EDGE;
    if (dx !== place.dx || flip !== place.flip) setPlace({ dx, flip });
  }, [anchor, place]);

  /** Indexes of the days the current width shows. */
  const visible = () => {
    const kids = Array.from(barRef.current?.children ?? []);
    const first = kids.findIndex((k) => k instanceof HTMLElement && k.offsetParent !== null);
    return { first: first === -1 ? 0 : first, last: days.length - 1 };
  };

  const onKey = (e: React.KeyboardEvent) => {
    const { first, last } = visible();
    const at = active ?? last;
    const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: first, End: last }[e.key];
    if (e.key === "Escape" && active !== null) {
      e.preventDefault();
      return show(null);
    }
    if (next === undefined) return;
    e.preventDefault();
    show(Math.max(first, Math.min(last, next)));
  };

  const onMove = (e: React.PointerEvent) => {
    const i = e.target instanceof HTMLElement ? Number(e.target.dataset.i) : NaN;
    if (!Number.isNaN(i) && i !== active) show(i);
  };

  const day = active === null ? undefined : days[active];

  return (
    <>
      <div
        ref={barRef}
        className="stp-bar"
        role="group"
        tabIndex={0}
        aria-label={`${name}, ${summary}. Left and Right step through the days.`}
        onKeyDown={onKey}
        onFocus={(e) => {
          // Keyboard focus opens today; a click lets the pointer pick the day instead.
          if (active === null && e.currentTarget.matches(":focus-visible")) show(visible().last);
        }}
        onBlur={() => show(null)}
        onPointerMove={onMove}
        onPointerLeave={() => show(null)}
      >
        {days.map((d, i) => (
          <span key={d.date} className="stp-cell" data-s={d.state} data-i={i} data-on={active === i || undefined} />
        ))}
      </div>
      <span className="sr" aria-live="polite">
        {day ? spoken(day, today, day.date === today) : ""}
      </span>
      {anchor && day
        ? createPortal(
            <div ref={tipRef} className="heat-tip-layer" data-flip={place.flip || undefined} style={{ "--tip-dx": `${place.dx}px` } as React.CSSProperties}>
              <ChartTooltip
                x={anchor.x}
                y={place.flip ? anchor.bottom - 6 : anchor.top - 2}
                title={day.date === today ? "Today" : dayLabel(day.date)}
                rows={rows(day, today)}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
