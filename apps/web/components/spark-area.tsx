"use client";

import { useId, useRef, useState } from "react";
import { ChartTooltip } from "@/components/chart-tooltip";

export interface SparkPoint {
  label: string;
  value: number;
}

const W = 120;
const H = 44;
const PAD = 4;

/** Smooth path through the points using Catmull-Rom segments converted to cubic Beziers, held monotone per segment. */
function smooth(pts: Array<[number, number]>) {
  if (pts.length < 2) return "";
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    // Each handle stays between the segment's end heights, so the curve never overshoots: a run of
    // zeros before a rise would otherwise dip below the baseline just before it climbs.
    const lo = Math.min(p1[1], p2[1]);
    const hi = Math.max(p1[1], p2[1]);
    const clampY = (y: number) => Math.min(hi, Math.max(lo, y));
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, clampY(p1[1] + (p2[1] - p0[1]) / 6)] as const;
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, clampY(p2[1] - (p3[1] - p1[1]) / 6)] as const;
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** `domain` pins the vertical scale (0 to 100 for percentages); without it the line fills the available height. */
export function SparkArea({
  points,
  unit,
  format = "int",
  domain,
  fluid = false,
  tone = "var(--chart)",
}: {
  points: SparkPoint[];
  unit: string;
  format?: "int" | "pct";
  domain?: [number, number];
  fluid?: boolean;
  tone?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  // A single sample draws as a flat line across the box; no samples draw nothing.
  const values = points.length === 1 ? [points[0]!.value, points[0]!.value] : points.map((p) => p.value);
  const [lo, hi] = domain ?? [Math.min(...values), Math.max(...values)];
  const span = hi - lo || 1;
  const pts = values.map(
    (v, i) => [(i * W) / (values.length - 1), PAD + (1 - (Math.min(Math.max(v, lo), hi) - lo) / span) * (H - PAD * 2)] as [number, number],
  );
  const label = unit ? unit[0]!.toUpperCase() + unit.slice(1) : "Value";
  const line = smooth(pts);
  const fmt = (v: number) => (format === "pct" ? `${v.toFixed(1)}%` : String(Math.round(v)));

  const move = (e: React.PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const rel = Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1);
    const i = Math.round(rel * (values.length - 1));
    setHover({ i, x: (pts[i]![0] / W) * box.width, y: (pts[i]![1] / H) * box.height });
  };

  if (pts.length < 2) return <div className="sparkarea" data-fluid={fluid} role="img" aria-label={`No ${unit} data yet`} />;

  // Points can shrink under a held pointer; clamp so the marker never reads past the end.
  const atIndex = hover ? Math.min(hover.i, pts.length - 1) : pts.length - 1;
  const at = pts[atIndex]!;
  const point = hover ? points[Math.min(hover.i, points.length - 1)] : undefined;
  return (
    <div
      ref={ref}
      className="sparkarea"
      data-fluid={fluid}
      style={{ ["--spark" as string]: tone }}
      onPointerMove={move}
      onPointerLeave={() => setHover(null)}
      role="img"
      aria-label={`Trend of ${unit}`}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: tone, stopOpacity: 0.22 }} />
            <stop offset="1" style={{ stopColor: tone, stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        <path d={`${line} L${W},${H} L0,${H} Z`} fill={`url(#${id})`} className="sparkarea-fill" />
        <path d={line} className="sparkarea-line" />
        {hover ? <line x1={at[0]} x2={at[0]} y1={0} y2={H} className="sparkarea-cursor" /> : null}
      </svg>
      <span className="sparkarea-dot" style={{ left: `round(${(at[0] / W) * 100}%, 1px)`, top: `round(${(at[1] / H) * 100}%, 1px)` }} />
      {hover && point ? (
        <ChartTooltip
          x={hover.x}
          y={hover.y}
          title={point.label}
          rows={[{ label, value: fmt(point.value), color: tone }]}
        />
      ) : null}
    </div>
  );
}
