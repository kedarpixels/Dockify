"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CardTitle } from "@/components/card-title";
import { ChartTooltip } from "@/components/chart-tooltip";
import { Node } from "@/components/ui/rule";
import { dayLabel, monthShort, plural } from "@/lib/format";
import type { Overview } from "@/lib/types";
import { DAY_PANEL_ID, DayPanel, type PickedDay } from "./day-panel";

const DAY = 86_400_000;
const GAP = 4;
/* GitHub labels every other row so the 12px text never crowds the 16px pitch. */
const DAYS = ["Mon", "", "Wed", "", "Fri", "", ""];
/* Keep the tooltip this far inside the viewport. */
const EDGE = 8;

interface Cell {
  date: string;
  total: number;
  failed: number;
  level: 0 | 1 | 2 | 3 | 4;
  today: boolean;
  empty: boolean;
  /** A day later than today: shown hollow, so the year reads as "not yet" past today. */
  future: boolean;
}

/** Lays one calendar year of the trend out as Monday-first week columns, Jan 1 to Dec 31. */
function layout(trend: Overview["deployTrend"], todayIso: string) {
  const last = trend.at(-1)?.date ?? todayIso;
  const lastT = Date.parse(`${last}T00:00:00Z`);
  const intoWeek = (new Date(lastT).getUTCDay() + 6) % 7;
  const weeks = Math.ceil((trend.length - intoWeek - 1) / 7) + 1;
  const start = lastT - (intoWeek + (weeks - 1) * 7) * DAY;
  const byDate = new Map(trend.map((d) => [d.date, d]));
  const max = Math.max(1, ...trend.map((d) => d.total));

  const cells: Cell[] = [];
  const months: string[] = [];
  let prev = "";
  for (let w = 0; w < weeks; w++) {
    const m = monthShort(new Date(start + w * 7 * DAY).toISOString().slice(0, 10));
    months.push(m === prev ? "" : m);
    prev = m;
    for (let d = 0; d < 7; d++) {
      const date = new Date(start + (w * 7 + d) * DAY).toISOString().slice(0, 10);
      const hit = byDate.get(date);
      const total = hit?.total ?? 0;
      const r = total / max;
      cells.push({
        date,
        total,
        failed: hit?.failed ?? 0,
        level: total === 0 ? 0 : r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4,
        today: date === todayIso,
        empty: !hit,
        future: date > todayIso && !(hit && hit.total > 0),
      });
    }
  }
  // Drop a month label when the next one starts within two columns, so partial months never collide.
  for (let i = 0; i < months.length; i++) {
    if (!months[i]) continue;
    const next = months.findIndex((m, j) => j > i && m);
    if (next !== -1 && next - i < 3) months[i] = "";
  }
  return { weeks, cells, months };
}

function cellLabel(c: Cell) {
  return `${c.today ? "Today" : dayLabel(c.date)}, ${plural(c.total, "deployment")}${c.failed ? `, ${c.failed.toLocaleString("en-US")} failed` : ""}`;
}

/** `todayIso` is today in the zone the trend's days are counted in (today.ts). */
export function DeployHeatmap({ trend, rollbacks, todayIso }: { trend: Overview["deployTrend"]; rollbacks: number; todayIso: string }) {
  const cardRef = useRef<HTMLElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ cell: Cell; x: number; y: number } | null>(null);
  const [place, setPlace] = useState({ dx: 0, flip: false });
  const [picked, setPicked] = useState<string | null>(null);
  // The last picked day stays rendered while the panel folds shut.
  const [shown, setShown] = useState<string | null>(null);
  const [focusDate, setFocusDate] = useState<string | null>(null);
  // Measured, so the fold animates to the exact height on open, on close and when the content changes.
  const dayBody = useRef<HTMLDivElement>(null);
  const [dayH, setDayH] = useState(0);
  useLayoutEffect(() => {
    const node = dayBody.current;
    if (!node) return;
    setDayH(node.offsetHeight);
    const ro = new ResizeObserver(() => setDayH(node.offsetHeight));
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  // Today's year, unless the trend has none of it yet (a stale snapshot over New Year). The API also
  // sends up to 59 days of the previous year for the 30-day KPIs; those are not part of this grid.
  const year = useMemo(() => {
    const now = todayIso.slice(0, 4);
    return trend.some((d) => d.date.startsWith(now)) ? now : (trend.at(-1)?.date.slice(0, 4) ?? now);
  }, [trend, todayIso]);
  const yearTrend = useMemo(() => trend.filter((d) => d.date.startsWith(year)), [trend, year]);
  const { weeks, cells, months } = useMemo(() => layout(yearTrend, todayIso), [yearTrend, todayIso]);

  const real = useMemo(() => cells.filter((c) => !c.empty && !c.future), [cells]);
  const index = useMemo(() => new Map(real.map((c, i) => [c.date, i])), [real]);
  // Grid position of every day, so arrow keys move by calendar day and week even across gaps.
  const slot = useMemo(() => new Map(cells.map((c, i) => [c.date, i])), [cells]);
  const rover = focusDate && index.has(focusDate) ? focusDate : (picked ?? (index.has(todayIso) ? todayIso : real.at(-1)?.date));

  const summary = useMemo(() => {
    const total = real.reduce((a, c) => a + c.total, 0);
    const failed = real.reduce((a, c) => a + c.failed, 0);
    // The year zero-fills every day, so "this week" and the streak count only days up to today.
    const upto = real.filter((c) => c.date <= todayIso);
    const intoWeek = (new Date(`${todayIso}T00:00:00Z`).getUTCDay() + 6) % 7;
    const thisWeek = upto.slice(-(intoWeek + 1)).reduce((a, c) => a + c.total, 0);
    const busiest = real.reduce<Cell | undefined>((a, c) => (!a || c.total > a.total ? c : a), undefined);
    let streak = 0;
    // Today is not over, so a streak still counts while today has no deploy yet.
    let from = upto.length - 1;
    if (upto[from]?.date === todayIso && upto[from]!.total === 0) from--;
    for (let i = from; i >= 0 && upto[i]!.total > 0; i--) streak++;
    const n = (v: number) => v.toLocaleString("en-US");
    return {
      caption: total ? `${plural(total, "deployment")} in ${year}` : `No deployments in ${year} yet`,
      stats: [
        { label: "This week", value: plural(thisWeek, "deployment") },
        { label: "Busiest day", value: busiest?.total ? `${dayLabel(busiest.date)}, ${plural(busiest.total, "deployment")}` : "None yet" },
        { label: "Current streak", value: plural(streak, "day") },
        { label: "Failed", value: `${n(failed)} of ${n(total)}` },
        { label: "Rollbacks", value: n(rollbacks) },
      ],
    };
  }, [real, rollbacks, todayIso, year]);

  // Narrow screens scroll the grid sideways: start with today's week at the right edge, not on empty weeks.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const cell = gridRef.current?.querySelector<HTMLElement>(`[data-date="${todayIso}"]`);
    if (!cell) {
      el.scrollLeft = el.scrollWidth;
      return;
    }
    el.scrollLeft += cell.getBoundingClientRect().right - el.getBoundingClientRect().right + 16;
  }, [weeks, todayIso]);

  // The tooltip lives in a fixed layer on <body>, so a stale position after a scroll or resize must go.
  const tipOpen = tip !== null;
  useEffect(() => {
    if (!tipOpen) return;
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, { capture: true });
      window.removeEventListener("resize", hide);
    };
  }, [tipOpen]);

  // Keep the card inside the viewport: slide it sideways (the caret stays on the point) and flip
  // it under the pointer when there is no room above.
  useLayoutEffect(() => {
    const el = tipRef.current?.querySelector<HTMLElement>(".ctip");
    if (!tip || !el) return;
    const r = el.getBoundingClientRect();
    const left = r.left - place.dx;
    const max = Math.max(0, r.width / 2 - 14);
    let dx = 0;
    if (left < EDGE) dx = EDGE - left;
    else if (left + r.width > window.innerWidth - EDGE) dx = window.innerWidth - EDGE - (left + r.width);
    dx = Math.max(-max, Math.min(max, Math.round(dx)));
    const flip = tip.y - 14 - r.height < EDGE;
    if (dx !== place.dx || flip !== place.flip) setPlace({ dx, flip });
  }, [tip, place]);

  const focusCell = useCallback((date: string) => {
    setFocusDate(date);
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-date="${date}"]`)?.focus({ preventScroll: false }));
  }, []);

  const pick = useCallback((date: string | null) => {
    setPicked(date);
    if (date) {
      setShown(date);
      setFocusDate(date);
    }
    setTip(null);
  }, []);

  const close = useCallback(() => {
    const was = picked;
    pick(null);
    if (was && cardRef.current?.contains(document.activeElement)) focusCell(was);
  }, [picked, pick, focusCell]);

  // Escape closes the day while focus is on the card or nowhere in particular. Focus inside a
  // menu, popover or dialog elsewhere leaves Escape to that owner.
  useEffect(() => {
    if (!picked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("[aria-modal='true'], dialog[open]")) return;
      const active = document.activeElement;
      if (active && active !== document.body && !cardRef.current?.contains(active)) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [picked, close]);

  const step = (by: -1 | 1) => {
    const at = picked ? index.get(picked) : undefined;
    const next = at === undefined ? undefined : real[at + by];
    if (next) pick(next.date);
  };

  // Up and Down move a day, Left and Right a week, clamped to the first and last real day.
  const onGridKey = (e: React.KeyboardEvent) => {
    const from = e.target instanceof HTMLElement ? e.target.dataset.date : undefined;
    const delta = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[e.key];
    if (!from || delta === undefined) return;
    e.preventDefault();
    const at = slot.get(from);
    const lo = slot.get(real[0]?.date ?? "");
    const hi = slot.get(real.at(-1)?.date ?? "");
    if (at === undefined || lo === undefined || hi === undefined) return;
    const target = cells[Math.max(lo, Math.min(hi, at + delta))];
    if (!target || target.empty || target.date === from) return;
    focusCell(target.date);
    if (picked) pick(target.date);
  };

  const show = useCallback((cell: Cell, e: React.PointerEvent) => {
    const { clientX: x, clientY: y } = e;
    setTip((t) => (t?.cell === cell && t.x === x && t.y === y ? t : { cell, x, y }));
  }, []);
  const hideTip = useCallback(() => setTip(null), []);
  const hovered = tip?.cell.date;

  // The cells re-render only when the hovered, picked or focusable day changes, not on every
  // pointer move that just slides the tooltip.
  const grid = useMemo(
    () =>
      cells.map((c, i) => {
        const delay = { animationDelay: `${Math.floor(i / 7) * 8}ms` };
        // Slots outside the year and days still to come are not pickable: no tooltip, focus or panel.
        if (c.empty) return <span key={c.date} className="cell" data-l={0} data-empty="true" style={delay} onPointerMove={hideTip} />;
        if (c.future) return <span key={c.date} className="cell" data-l={0} data-future="true" style={delay} onPointerMove={hideTip} />;
        const on = picked === c.date;
        return (
          <button
            key={c.date}
            type="button"
            className="cell"
            data-l={c.level}
            data-date={c.date}
            data-on={hovered === c.date || undefined}
            data-picked={on || undefined}
            aria-expanded={on}
            aria-controls={on ? DAY_PANEL_ID : undefined}
            aria-label={cellLabel(c)}
            tabIndex={c.date === rover ? 0 : -1}
            style={delay}
            onFocus={(e) => {
              setFocusDate(c.date);
              // The keyboard gets the same count card as the pointer, above the focused cell.
              if (e.currentTarget.matches(":focus-visible")) {
                const r = e.currentTarget.getBoundingClientRect();
                setTip({ cell: c, x: r.left + r.width / 2, y: r.top });
              }
            }}
            onBlur={hideTip}
            onPointerMove={(e) => show(c, e)}
            onClick={() => pick(on ? null : c.date)}
          />
        );
      }),
    [cells, picked, hovered, rover, show, hideTip, pick],
  );

  const cols = {
    gridTemplateColumns: `repeat(${weeks}, var(--cell))`,
    columnGap: GAP,
    "--weeks": weeks,
  } as React.CSSProperties;
  const panelCell = shown ? real[index.get(shown) ?? -1] : undefined;
  const panelDay: PickedDay | undefined = panelCell
    ? {
        date: panelCell.date,
        total: panelCell.total,
        failed: panelCell.failed,
        today: panelCell.today,
      }
    : undefined;
  const panelAt = panelCell ? (index.get(panelCell.date) ?? -1) : -1;

  return (
    <section ref={cardRef} className="card reveal heat-card" aria-labelledby="heat-title" style={{ animationDelay: "120ms" }}>
      <div className="card-hd">
        <CardTitle id="heat-title" icon="bars" title="Deploy activity" sub="Deployments per day, this year" />
      </div>
      <div className="heat-body">
        <div className="heat-main">
          <div ref={wrapRef} className="heat-wrap">
            <div className="heat">
              <span />
              <div className="heat-months" style={cols} aria-hidden="true">
                {months.map((m, i) => (
                  <span key={i}>{m}</span>
                ))}
              </div>
              <div className="heat-days" aria-hidden="true">
                {DAYS.map((d, i) => (
                  <span key={i}>{d}</span>
                ))}
              </div>
              <div
                ref={gridRef}
                className="heat-grid"
                style={cols}
                role="group"
                aria-label={`${summary.caption}. Arrow keys move between days, Enter opens one.`}
                data-picking={picked ? true : undefined}
                onKeyDown={onGridKey}
                onPointerLeave={hideTip}
              >
                {grid}
              </div>
            </div>
          </div>
          <div className="heat-foot">
            <span className="heat-caption num">{summary.caption}</span>
            <span className="heat-legend" aria-hidden="true">
              Less
              {[0, 1, 2, 3, 4].map((l) => (
                <i key={l} className="cell" data-l={l} />
              ))}
              More
            </span>
          </div>
        </div>
        <dl className="heat-stats">
          {summary.stats.map((s) => (
            <div key={s.label} className="heat-stat">
              <Node pos="tl" />
              <Node pos="tr" />
              <dt>{s.label}</dt>
              <dd className="num">{s.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="heat-day" data-open={picked ? true : undefined} inert={!picked}>
        {/* Nodes sit outside the folding box so its clip never cuts them. */}
        <Node pos="tl" onLine />
        <Node pos="tr" onLine />
        <div className="heat-day-inner" style={{ height: picked ? dayH : 0 }}>
          <div ref={dayBody}>
            {panelDay ? <DayPanel day={panelDay} at={panelAt} count={real.length} onStep={step} onClose={close} /> : null}
          </div>
        </div>
      </div>

      {tip
        ? createPortal(
            <div ref={tipRef} className="heat-tip-layer" data-flip={place.flip || undefined} style={{ "--tip-dx": `${place.dx}px` } as React.CSSProperties}>
              <ChartTooltip
                x={tip.x}
                y={tip.y}
                title={tip.cell.today ? "Today" : dayLabel(tip.cell.date)}
                rows={[
                  {
                    label: "Succeeded",
                    value: (tip.cell.total - tip.cell.failed).toLocaleString("en-US"),
                    color: "var(--chart)",
                  },
                  {
                    label: "Failed",
                    value: tip.cell.failed.toLocaleString("en-US"),
                    color: "var(--bad)",
                  },
                ]}
              />
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
