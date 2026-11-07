"use client";

import { Icon, type IconName } from "@/components/icon";
import { SparkArea, type SparkPoint } from "@/components/spark-area";
import { useCountUp } from "@/lib/hooks";
import { Chip } from "./chip";
import { IconTile } from "./icon-tile";
import { Corners } from "./rule";

/*
 * The KPI strip: one to four ruled cells (tile and label, an optional change chip, a big figure, a
 * muted lead, an optional trend). One look on every page: 16px from the head to the figure and a
 * node on every cell corner, so the strip sits in the ruled frame like every other grid.
 *
 *   <KpiStrip cells={kpis} />                                         lib/derive Kpi objects pass straight in
 *   <KpiStrip label="Summary" cells={[{ icon: "folder", label: "Projects", value: 4, lead: "3 environments" }]} />
 *   <KpiStrip cells={[{ icon: "archive", label: "Stored", value: "18.4", unit: "GB", lead: "Across 12 backups" }]} />
 *
 * A metric card with its own keys (a range picker in the head) is a KpiCell with `actions`, inside a
 * `.kpi` > `.kpi-grid` of its own:
 *
 *   <section className="kpi" aria-label="Server metrics">
 *     <div className="kpi-grid" data-cols="2">
 *       <KpiCell cell={cpu} actions={<Segmented label="Range" ... />} />
 *     </div>
 *   </section>
 *
 * Numeric values count up once per page load (keyed by label), then follow the data.
 */

export interface KpiData {
  icon: IconName;
  label: string;
  /** A number counts up and is formatted by `format`; anything else (text, a <When>) shows as is. */
  value: number | React.ReactNode;
  /** "int" 1,234 (default), "pct" 99.2%, "ratio" adds "of {total}". */
  format?: "int" | "pct" | "ratio";
  total?: number;
  /** Small muted unit after the figure: "GB", "ms". */
  unit?: string;
  lead?: React.ReactNode;
  /** Same as `lead`; the name lib/derive's Kpi uses. */
  sub?: string;
  delta?: { text: string; dir: "up" | "down" | "flat"; tone: "ok" | "warn" | "bad" | "idle"; hint?: string };
  /** Status dot after the figure; "live" pulses. */
  tone?: "ok" | "live" | "warn" | "bad";
  spark?: { points: SparkPoint[]; unit: string; format: "int" | "pct" };
}

function Figure({ value, format = "int", label }: { value: number; format?: KpiData["format"]; label: string }) {
  const v = useCountUp(value, 900, `kpi:${label}`);
  return <>{format === "pct" ? `${v.toFixed(1)}%` : Math.round(v).toLocaleString("en-US")}</>;
}

/**
 * One ruled cell. Use it directly only inside a `.kpi` > `.kpi-grid` of your own (a metric card).
 * `actions` sits at the right end of the head, such as a range Segmented; `children` follow the
 * figures, such as a full-width chart.
 */
export function KpiCell({
  cell,
  delay = 0,
  actions,
  children,
}: {
  cell: KpiData;
  delay?: number;
  /** Keys at the right end of the head. */
  actions?: React.ReactNode;
  /** Anything under the figures and the trend. */
  children?: React.ReactNode;
}) {
  const lead = cell.lead ?? cell.sub;
  const d = cell.delta;
  return (
    <div className="kpi-cell reveal" style={{ animationDelay: `${delay}ms` }}>
      <Corners />
      <div className="kpi-head">
        <IconTile size="md">
          <Icon name={cell.icon} />
        </IconTile>
        <span className="kpi-label" title={typeof cell.label === "string" ? cell.label : undefined}>{cell.label}</span>
        {actions ? <div className="kpi-actions">{actions}</div> : null}
      </div>
      <div className="kpi-body">
        <div className="kpi-figs">
          <span className="kpi-value num">
            {typeof cell.value === "number" ? <Figure value={cell.value} format={cell.format} label={cell.label} /> : cell.value}
            {cell.unit ? <small>{cell.unit}</small> : null}
            {cell.format === "ratio" && cell.total !== undefined ? <small>of {cell.total.toLocaleString("en-US")}</small> : null}
            {cell.tone ? <span className={cell.tone === "live" ? "dot pulse" : "dot"} data-tone={cell.tone} aria-hidden="true" /> : null}
            {/* The change rides on the figure, so the label keeps its full width on narrow laptops. */}
            {d ? (
              <Chip
                size="sm"
                tone={d.tone}
                className="kpi-delta num"
                tip={d.hint}
                icon={<Icon name={d.dir === "up" ? "arrowUp" : d.dir === "down" ? "arrowDown" : "minus"} size={12} />}
              >
                {d.text}
              </Chip>
            ) : null}
          </span>
          {lead ? <span className="kpi-lead num">{lead}</span> : null}
        </div>
        {cell.spark && cell.spark.points.length > 1 ? (
          <SparkArea points={cell.spark.points} unit={cell.spark.unit} format={cell.spark.format} />
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** The ruled strip. 4 cells go 4, 2 across as the strip narrows; 3 go 3, 1; 2 stay 2. */
export function KpiStrip({
  cells,
  label = "Key numbers",
}: {
  cells: KpiData[];
  label?: string;
}) {
  return (
    <section aria-label={label} className="kpi">
      <div className="kpi-grid" data-cols={Math.min(4, Math.max(1, cells.length))}>
        {cells.map((c, i) => (
          <KpiCell key={c.label} cell={c} delay={i * 50} />
        ))}
      </div>
    </section>
  );
}
