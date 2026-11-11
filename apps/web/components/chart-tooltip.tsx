export interface TooltipRow {
  label: string;
  value: string;
  color: string;
}

/** x and y are the point in the positioned parent. Place it outside overflow: hidden boxes or it clips. */
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
