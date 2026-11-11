"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { CardTitle } from "@/components/card-title";
import { Callout } from "@/components/ui/callout";
import { Skel } from "@/components/ui/skeleton";
import { callJson } from "@/lib/client-api";
import type { DayDeploymentsResult } from "@/lib/data";
import { dayLabel } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import type { RecentDeployment } from "@/lib/types";
import { DeployRow } from "./deploy-row";

/** The open day's panel, which the picked heatmap cell names in aria-controls. */
export const DAY_PANEL_ID = "heat-day-panel";

export interface PickedDay {
  date: string;
  total: number;
  failed: number;
  today: boolean;
}

type Load = { state: "loading" } | { state: "ready"; rows: RecentDeployment[] } | { state: "error"; message: string };

const NONE: RecentDeployment[] = [];

// Finished days never change, so a fetched day is kept for the session. Today is always refetched.
const cache = new Map<string, RecentDeployment[]>();

/** Stepping on aborts the request in flight, so a slow answer for an earlier day never lands on a later one. */
function useDay(day: PickedDay, attempt: number): Load {
  const known = day.total === 0 ? NONE : day.today ? undefined : cache.get(day.date);
  const key = `${day.date}#${attempt}`;
  const [load, setLoad] = useState<{ key: string; value: Load }>({ key: "", value: { state: "loading" } });

  useEffect(() => {
    if (known) return;
    const ctrl = new AbortController();
    void callJson<Partial<DayDeploymentsResult>>(`/api/deployments?day=${encodeURIComponent(day.date)}`, { signal: ctrl.signal }).then((r) => {
      if (ctrl.signal.aborted) return;
      const rows = r.ok ? r.data?.data : undefined;
      if (!rows) {
        const message = r.ok ? (r.data?.error ?? "The API did not answer") : r.error;
        setLoad({ key, value: { state: "error", message } });
        return;
      }
      if (!day.today) cache.set(day.date, rows);
      setLoad({ key, value: { state: "ready", rows } });
    });
    return () => ctrl.abort();
  }, [key, day.date, day.today, known]);

  if (known) return { state: "ready", rows: known };
  return load.key === key ? load.value : { state: "loading" };
}

function fullDate(date: string) {
  return `${dayLabel(date)} ${date.slice(0, 4)}`;
}

/** Left and Right step days from anywhere in the panel. */
export function DayPanel({
  day,
  at,
  count,
  onStep,
  onClose,
}: {
  day: PickedDay;
  /** The day's place among the days that can be picked. */
  at: number;
  count: number;
  onStep: (by: -1 | 1) => void;
  onClose: () => void;
}) {
  const now = useNow(1000);
  const [attempt, setAttempt] = useState(0);
  const load = useDay(day, attempt);
  const panel = useRef<HTMLDivElement>(null);
  const prevKey = useRef<HTMLButtonElement>(null);
  const nextKey = useRef<HTMLButtonElement>(null);
  const canPrev = at > 0;
  const canNext = at < count - 1;
  const ok = day.total - day.failed;

  // Stepping swaps the rows and can disable the key just pressed. Either drops focus to the page,
  // so it lands on the key in the direction of travel, or the other key at the first or last day.
  const step = (by: -1 | 1) => {
    onStep(by);
    const to = at + by;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      const kept = active instanceof HTMLElement && panel.current?.contains(active) && !(active instanceof HTMLButtonElement && active.disabled);
      if (kept) return;
      const ahead = by < 0 ? prevKey.current : nextKey.current;
      const behind = by < 0 ? nextKey.current : prevKey.current;
      const atEdge = by < 0 ? to <= 0 : to >= count - 1;
      (atEdge ? behind : ahead)?.focus();
    });
  };

  return (
    <div
      ref={panel}
      id={DAY_PANEL_ID}
      className="day-panel"
      role="region"
      aria-label={`Deployments on ${fullDate(day.date)}`}
      onKeyDown={(e) => {
        // React sends key events up through portals: a row's Redeploy confirm is drawn on the body
        // but still sits in this panel's tree, and its arrow keys must not step the day under it.
        if (!(e.target instanceof Node) || !panel.current?.contains(e.target)) return;
        if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return;
        if (e.key === "ArrowLeft" && canPrev) {
          e.preventDefault();
          step(-1);
        } else if (e.key === "ArrowRight" && canNext) {
          e.preventDefault();
          step(1);
        }
      }}
    >
      <div className="day-hd card-hd">
        <CardTitle
          id="day-title"
          icon="calendar"
          title={day.today ? `Today, ${dayLabel(day.date)}` : fullDate(day.date)}
          sub={`${ok.toLocaleString("en-US")} succeeded, ${day.failed.toLocaleString("en-US")} failed`}
        />
        <span className="day-keys">
          <button ref={prevKey} type="button" className="btn btn-sm btn-icon" aria-label="Previous day" data-tip="Previous day, Left" data-tip-side="bottom" disabled={!canPrev} onClick={() => step(-1)}>
            <Icon name="chevronLeft" />
          </button>
          <button ref={nextKey} type="button" className="btn btn-sm btn-icon" aria-label="Next day" data-tip="Next day, Right" data-tip-side="bottom" disabled={!canNext} onClick={() => step(1)}>
            <Icon name="chevronRight" />
          </button>
          <button type="button" className="btn btn-sm btn-icon" aria-label="Close day" onClick={onClose}>
            <Icon name="close" />
          </button>
        </span>
      </div>

      {/* One skeleton row per expected deployment (up to 12), so the fold barely moves when rows
          land. Each bar takes its column's class, so narrow lists hide and place it as the row's. */}
      <div key={`${day.date}-${load.state}`} className="day-body" aria-busy={load.state === "loading"}>
        {load.state === "loading" ? (
          <ul className="soft-list" aria-label="Loading deployments">
            {Array.from({ length: Math.min(Math.max(day.total, 1), 12) }, (_, i) => (
              <li key={i} className="soft-row dep-row" aria-hidden="true">
                <Skel w={24} h={24} r={8} />
                <Skel w={`${62 - (i % 3) * 10}%`} className="dep-app" />
                <Skel w={`${78 - (i % 2) * 14}%`} className="dep-msg" />
                <Skel w="64%" className="dep-branch" />
                <Skel w={56} className="dep-hash" />
                <Skel w={40} className="skel-end dep-dur" />
                <Skel w={40} className="skel-end dep-when" />
                <Skel w={24} h={24} r={8} className="dep-actions" />
              </li>
            ))}
          </ul>
        ) : load.state === "error" ? (
          <div className="day-error">
            <Callout
              tone="bad"
              icon="alert"
              role="alert"
              action={
                <button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
                  Try again
                </button>
              }
            >
              Could not load this day. {load.message.trim().replace(/\.+$/, "")}.
            </Callout>
          </div>
        ) : load.rows.length === 0 ? (
          <div className="day-note">
            <span>No deployments on this day.</span>
          </div>
        ) : (
          <ul className="soft-list">
            {load.rows.map((d) => (
              <li key={d.id}>
                <DeployRow d={d} now={now} time={day.today ? "ago" : "clock"} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
