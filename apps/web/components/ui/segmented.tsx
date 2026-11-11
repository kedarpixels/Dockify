"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { ChipTone } from "./chip";
import type { FieldIds } from "./field";

export interface SegmentOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Accessible name when the label is an icon only. */
  ariaLabel?: string;
  tip?: string;
}

export interface SegmentFilter<T extends string> {
  value: T;
  label: string;
  /** A status filter (Healthy, Failed) leads with its tone dot; a kind filter (Postgres) has none. */
  tone?: ChipTone;
  /** How many rows the option keeps. Give it whenever the list is in memory; leave it off when the list pages from the server. */
  count?: number;
  tip?: string;
}

/** The one way to build a list filter's options, so every toolbar reads alike. */
export function filterOptions<T extends string>(filters: SegmentFilter<T>[]): SegmentOption<T>[] {
  return filters.map((f) => ({
    value: f.value,
    tip: f.tip,
    label: (
      <>
        {f.tone ? <span className="dot" data-tone={f.tone} aria-hidden="true" /> : null}
        {f.label}
        {f.count !== undefined ? (
          <>
            <span className="sr">, </span>
            <span className="seg2-count num">{f.count.toLocaleString("en-US")}</span>
          </>
        ) : null}
      </>
    ),
  }));
}

export const segOption = (track: HTMLElement | null, value: string) => track?.querySelector<HTMLElement>(`[data-value="${CSS.escape(value)}"]`) ?? null;

type ThumbPlace = { x: number; w: number; instant: boolean } | null;

// The track is observed too: a sibling growing moves the chosen option without resizing it. Hidden
// (display: none) measures 0, so there is no thumb until it shows instead of one sliding in from the left.
export function useSegThumb(trackRef: React.RefObject<HTMLDivElement | null>, value: string, values: string): ThumbPlace {
  const [thumb, setThumb] = useState<ThumbPlace>(null);
  useLayoutEffect(() => {
    const box = trackRef.current;
    const el = segOption(box, value);
    if (!el || !box) {
      setThumb(null);
      return;
    }
    const place = (instant: boolean) => {
      if (!el.offsetWidth) {
        setThumb(null);
        return;
      }
      setThumb((t) => (t && t.x === el.offsetLeft && t.w === el.offsetWidth ? t : { x: el.offsetLeft, w: el.offsetWidth, instant: instant || !t }));
    };
    place(false);
    const ro = new ResizeObserver(() => place(true));
    ro.observe(el);
    ro.observe(box);
    return () => ro.disconnect();
  }, [trackRef, value, values]);
  return thumb;
}

export function SegThumb({ thumb }: { thumb: ThumbPlace }) {
  if (!thumb) return null;
  return (
    <span
      className="seg2-thumb"
      aria-hidden="true"
      style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w, transition: thumb.instant ? "none" : undefined }}
    />
  );
}

/** For a page's sections (content that swaps), use Tabs, which looks the same. Inside a Field pass `ids`. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  iconOnly = false,
  ids,
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  label: string;
  iconOnly?: boolean;
  ids?: FieldIds;
}) {
  const track = useRef<HTMLDivElement>(null);
  const thumb = useSegThumb(track, value, JSON.stringify(options.map((o) => o.value)));

  // With no option chosen the first one takes the tab stop, so the group stays reachable.
  const chosen = options.findIndex((o) => o.value === value);
  const tabStop = chosen >= 0 ? chosen : 0;

  const move = (e: React.KeyboardEvent, i: number) => {
    const n = options.length;
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n
      : e.key === "Home" ? 0
      : e.key === "End" ? n - 1
      : -1;
    if (to < 0) return;
    e.preventDefault();
    const next = options[to]!;
    onChange(next.value);
    segOption(track.current, next.value)?.focus();
  };

  return (
    <div
      ref={track}
      id={ids?.id}
      className="seg2"
      data-icon-only={iconOnly || undefined}
      role="radiogroup"
      aria-label={ids?.labelId ? undefined : label}
      aria-labelledby={ids?.labelId}
      aria-describedby={ids?.describedBy}
      aria-invalid={ids?.invalid || undefined}
    >
      <SegThumb thumb={thumb} />
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={o.ariaLabel}
          tabIndex={i === tabStop ? 0 : -1}
          data-value={o.value}
          data-tip={o.tip}
          className="seg2-opt"
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => move(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
