export interface TooltipRow {
  label: string;
  value: string;
  color: string;
}

/**
 * Pointer-following chart tooltip in the portfolio tooltip style: inverted ink card, 8px radius,
 * 12px text, a down caret under the point. x and y are the point in the positioned parent; the
 * card sits centred above it. Keep it unclipped by placing it outside overflow: hidden boxes.
 */
export function ChartTooltip({ x, y, title, rows }: { x: number; y: number; title: string; rows: TooltipRow[] }) {
  return (
    <div className="ctip" style={{ left: x, top: y }} role="tooltip">
      <div className="ctip-title">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="ctip-row">
          <i style={{ background: r.color }} />
          <span>{r.label}</span>
          <b className="num">{r.value}</b>
        </div>
      ))}
    </div>
  );
}
