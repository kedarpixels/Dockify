"use client";

import { memo } from "react";
import { sameLines } from "@/components/logs/log-dom";
import { inferLevel } from "@/components/logs/model";
import { useChunkHeight } from "@/components/logs/use-log-window";
import type { LogLine } from "@/lib/pages/deployments";
import { useTimeFormat } from "@/lib/time-prefs";

/**
 * A build log line's level from its own words. BuildKit prints its normal progress on stderr, so
 * the stream alone never makes a line an error here.
 */
export const lineLevel = (l: LogLine) => inferLevel(l, { stderrIsError: false });

const SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * A case-insensitive matcher for the literal text `q`: regex characters in it match themselves.
 * Not global, so `test` keeps no state between lines; the group lets `split` keep each hit.
 */
export const matcher = (q: string) => (q ? new RegExp(`(${q.replace(SPECIAL, "\\$&")})`, "i") : null);

/** The text with every hit of `re` wrapped in a mark; split puts the hits at the odd indexes. */
function highlight(text: string, re: RegExp | null, active: boolean) {
  if (!re) return text;
  const parts = text.split(re);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 ? (
      <mark key={i} className="lg-hit" data-active={active || undefined}>
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

type ChunkProps = {
  lines: LogLine[];
  re: RegExp | null;
  /** Wrapping changes the height, so a toggle measures again. */
  wrap: boolean;
  activeSeq?: number;
  flashSeq?: number;
  /** The line the URL points at (#L120). */
  targetSeq?: number;
  /** The line whose link was just copied; its number shows a short "Link copied" tip. */
  copiedSeq?: number;
  index: number;
  onSize: (index: number, height: number) => void;
};

const sameChunk = (a: ChunkProps, b: ChunkProps) =>
  sameLines(a.lines, b.lines) &&
  a.re === b.re &&
  a.wrap === b.wrap &&
  a.activeSeq === b.activeSeq &&
  a.flashSeq === b.flashSeq &&
  a.targetSeq === b.targetSeq &&
  a.copiedSeq === b.copiedSeq &&
  a.index === b.index &&
  a.onSize === b.onSize;

/** Up to CHUNK rows, memoised so an append re-renders only the chunk it lands in. */
export const LogChunk = memo(function LogChunk({
  lines,
  re,
  wrap,
  activeSeq,
  flashSeq,
  targetSeq,
  copiedSeq,
  index,
  onSize,
}: ChunkProps) {
  const time = useTimeFormat();
  const ref = useChunkHeight(index, onSize, wrap);
  return (
    <div ref={ref}>
      {lines.map((l) => (
        <div
          key={l.seq}
          className="lg-line"
          data-seq={l.seq}
          data-level={lineLevel(l)}
          data-active={l.seq === activeSeq || l.seq === flashSeq || undefined}
          data-target={l.seq === targetSeq || undefined}
        >
          <a
            className="lg-no"
            href={`#L${l.seq}`}
            tabIndex={-1}
            aria-label={`Copy link to line ${l.seq}`}
            data-tip={l.seq === copiedSeq ? "Link copied" : undefined}
            data-tip-side={l.seq === copiedSeq ? "right" : undefined}
            data-copied={l.seq === copiedSeq || undefined}
          >
            {l.seq}
          </a>
          <span className="lg-ts" aria-hidden="true">
            {time.clock(l.ts, { seconds: true })}
          </span>
          <span className="lg-tx">{highlight(l.text, re, l.seq === activeSeq)}</span>
        </div>
      ))}
    </div>
  );
}, sameChunk);
