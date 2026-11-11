import { usagePct } from "@/lib/format";
import { cx } from "./cx";

/* Warn above 70%, bad above 85% (or pass `tone`). */
export function Meter({
  label,
  pct,
  text,
  tone,
  width = 48,
  className,
}: {
  /** Names the bar for screen readers: "Memory 1.2 GB". */
  label: string;
  pct: number;
  /** The reading after the bar; the rounded percentage when left out. */
  text?: string;
  tone?: "warn" | "bad";
  width?: number;
  className?: string;
}) {
  const p = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  const t = tone ?? (p > 85 ? "bad" : p > 70 ? "warn" : undefined);
  const reading = text ?? usagePct(p);
  return (
    <span className={cx("gauge", className)} data-tone={t}>
      <span className="bar" data-tone={t} role="img" aria-label={`${label} ${reading}`} style={{ width }}>
        {/* Any load above 0 shows at least 3px, so a light one never reads as empty. */}
        <span style={{ width: p > 0 ? `round(max(${p}%, 3px), 1px)` : 0 }} />
      </span>
      <span className="gauge-val num" aria-hidden="true">
        {reading}
      </span>
    </span>
  );
}
