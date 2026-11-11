"use client";

import { memo } from "react";
import { MONTHS } from "@/lib/format";
import { useTimeFormat, type TimeFormat } from "@/lib/time-prefs";
import { sameLines } from "./log-dom";
import { useChunkHeight } from "./use-log-window";
import { cleanText, leadingLevel, levelOf, splitHits, type LogLevel, type RuntimeLogLine } from "./model";

export interface AppMeta {
  label: string;
  env?: string;
  slot: number;
}

/** The level column: a short tag on screen, the word for screen readers. */
const LEVEL_TAG: Record<LogLevel, string> = { error: "ERR", warn: "WARN", info: "INFO", debug: "DBG" };
const LEVEL_WORD: Record<LogLevel, string> = { error: "Error", warn: "Warning", info: "Info", debug: "Debug" };

type RowsProps = {
  lines: RuntimeLogLine[];
  /** The chunk's position key; heights are stored under it. */
  index: number;
  apps: Map<string, AppMeta>;
  re: RegExp | null;
  /** Wrapping changes the height, so a toggle measures again. */
  wrap: boolean;
  /** The line the URL points at (#L-id). */
  targetId?: string;
  copiedId?: string;
  onSize: (index: number, height: number) => void;
};

/** The list slices its mounted chunks afresh each render, so a chunk compares the lines it holds. */
const sameRows = (a: RowsProps, b: RowsProps) =>
  sameLines(a.lines, b.lines) &&
  a.index === b.index &&
  a.apps === b.apps &&
  a.re === b.re &&
  a.wrap === b.wrap &&
  a.targetId === b.targetId &&
  a.copiedId === b.copiedId &&
  a.onSize === b.onSize;

/** Rows only render after mount, so this never hydrates. */
function stamp(iso: string, time: TimeFormat) {
  const p = time.parts(iso);
  return { day: p ? `${p.day} ${MONTHS[p.month]}` : "", time: time.clock(iso, { seconds: true }) };
}

/** Memoised so an append re-renders only the chunk it lands in. */
export const LogRows = memo(function LogRows({
  lines,
  index,
  apps,
  re,
  wrap,
  targetId,
  copiedId,
  onSize,
}: RowsProps) {
  const ref = useChunkHeight(index, onSize, wrap);
  const time = useTimeFormat();

  return (
    <div ref={ref}>
      {lines.map((l) => {
        const app = apps.get(l.appId);
        const level = levelOf(l);
        const text = cleanText(l.text);
        // A line that opens with its own level word ("INFO server started") already says it, so
        // the tag is left out and that word stands in the level column instead of "INFO INFO".
        const tagged = leadingLevel(text) !== level;
        const at = stamp(l.ts, time);
        const copied = l.id === copiedId;
        const name = app ? `${app.label}${app.env ? ` ${app.env}` : ""}` : l.appId;
        return (
          <div
            key={l.id}
            className="lx-line"
            data-id={l.id}
            data-level={level}
            data-target={l.id === targetId || undefined}
            style={{ ["--lx-app" as string]: `var(--lx-c${app?.slot ?? 7})` }}
          >
            <a
              className="lx-ts"
              href={`#L-${l.id}`}
              tabIndex={-1}
              aria-label={`Copy link to the line at ${at.time}`}
              data-tip={copied ? "Link copied" : undefined}
              data-tip-side={copied ? "right" : undefined}
              data-copied={copied || undefined}
            >
              <span className="lx-day">{at.day} </span>
              {at.time}
            </a>
            <span className="lx-app" title={name}>
              <span className="lx-dot" aria-hidden="true" />
              <span className="lx-app-name">{app?.label ?? l.appId}</span>
              {app?.env ? <span className="lx-env">{app.env}</span> : null}
            </span>
            {/* An untagged line keeps the cell, so every line's text starts on the same column. */}
            <span className="lx-lvl">
              {tagged ? (
                <>
                  <span aria-hidden="true">{LEVEL_TAG[level]}</span>
                  <span className="sr">{LEVEL_WORD[level]}</span>
                </>
              ) : null}
            </span>
            <span className="lx-tx" data-stream={l.stream}>
              {splitHits(text, re).map((p, i) =>
                p.hit ? (
                  <mark key={i} className="lx-hit">
                    {p.text}
                  </mark>
                ) : (
                  p.text
                ),
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}, sameRows);
