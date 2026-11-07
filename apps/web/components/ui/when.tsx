"use client";

import { timeAgo } from "@/lib/format";
import { useNow } from "@/lib/hooks";
import { useAbsTip } from "@/lib/time-prefs";
import { cx } from "./cx";

/*
 * Every relative time: "5m ago" in a <time dateTime>, with the absolute moment in its tip.
 *
 *   <When iso={d.createdAt} now={now} />                       ticks with the page clock
 *   <When iso={run.startedAt} now={now} utc prefix="Started" />  "Started 3h ago", tip in UTC
 *   <When iso={cert.checkedAt} start={initial.fetchedAt} />     no page clock: ticks on its own
 *   <When iso={d.startedAt} now={now} live />                   in flight: "Now", tip "Started 30 Oct 2026, 14:05"
 *
 * Pass the page's `now` (from useNow) where there is one, so a long list shares one clock. Without
 * it the time ticks every `tick` ms on its own; pass `start` (the snapshot time) so the server and
 * the first client render agree. `utc` follows the zone rule in lib/format.ts `absTime`.
 *
 * A time with no `prefix` starts its cell, so it reads "Just now" and "Yesterday". Words that lead
 * into the time ("Checked", "joined") go in `prefix`, never in the text before the element, so the
 * sentence keeps "Checked just now".
 */

type WhenProps = {
  iso: string | null | undefined;
  /** The page clock. */
  now?: number;
  /** Own tick in ms when there is no page clock. */
  tick?: number;
  /** Snapshot time for the first render when there is no page clock. */
  start?: string;
  utc?: boolean;
  /** Sentence start before the relative time: "Checked" reads "Checked 3m ago". */
  prefix?: string;
  /** Shown, muted, when there is no time at all. */
  fallback?: string;
  /** Still running (a build, a backup): reads "Now", the start time in the tip. `iso` is the start. */
  live?: boolean;
  tipSide?: "bottom";
  tipAlign?: "end";
  className?: string;
};

export function When(props: WhenProps) {
  return props.now === undefined ? <LiveWhen {...props} /> : <WhenAt {...props} now={props.now} />;
}

function LiveWhen({ tick = 30_000, start, ...rest }: WhenProps) {
  const now = useNow(tick, start);
  return <WhenAt {...rest} now={now} />;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function WhenAt({ iso, now, utc, prefix, fallback = "Never", live, tipSide, tipAlign, className }: WhenProps & { now: number }) {
  const tip = useAbsTip();
  const t = iso ? Date.parse(iso) : NaN;
  const known = Boolean(iso) && !Number.isNaN(t);
  if (live) {
    const word = prefix ? `${prefix} now` : "Now";
    if (!known) return <span className={cx("when", className)}>{word}</span>;
    return (
      <time
        dateTime={iso!}
        className={cx("when", className)}
        data-tip={`Started ${tip(iso!, utc)}`}
        data-tip-side={tipSide}
        data-tip-align={tipAlign}
        suppressHydrationWarning
      >
        {word}
      </time>
    );
  }
  if (!known) return <span className={cx("none", className)}>{fallback}</span>;
  const rel = timeAgo(iso!, now);
  return (
    <time
      dateTime={iso!}
      className={cx("when", className)}
      data-tip={tip(iso!, utc)}
      data-tip-side={tipSide}
      data-tip-align={tipAlign}
      suppressHydrationWarning
    >
      {prefix ? `${prefix} ${rel}` : capital(rel)}
    </time>
  );
}
