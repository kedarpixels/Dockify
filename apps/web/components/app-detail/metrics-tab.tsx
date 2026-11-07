"use client";

import type { IconName } from "@/components/icon";
import { cores } from "@/components/project-detail/shared";
import { SparkArea } from "@/components/spark-area";
import { Empty } from "@/components/ui/empty";
import { KpiCell, type KpiData } from "@/components/ui/kpi";
import { Meter } from "@/components/ui/meter";
import { Segmented } from "@/components/ui/segmented";
import { Skel } from "@/components/ui/skeleton";
import { When } from "@/components/ui/when";
import { bytes, plural, usagePct } from "@/lib/format";
import { useHydrated } from "@/lib/hooks";
import { pointLabel, useTimeFormat } from "@/lib/time-prefs";
import type { AppDetail, AppMetricPoint, AppMetrics } from "@/lib/pages/project-detail";
import type { MetricRange } from "@/lib/pages/server-backups";
import { useCan } from "@/lib/viewer";
import { TabCard, TabFailed } from "./states";
import { useAppTab } from "./use-tab";
import { notRunning } from "@/lib/derive";

/* Metrics: CPU, memory, network and restarts over 1h, 24h or 7d, then how close the app sits to
   each configured limit. One range drives all four charts. Each metric is a KpiCell (the KPI
   strip's ruled cell) with its chart and its averages under the figures. */

const RANGES: Array<{ value: MetricRange; label: string }> = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
];

const RANGE_WORDS: Record<MetricRange, string> = { "1h": "Last hour", "24h": "Last 24 hours", "7d": "Last 7 days" };


const toneOf = (pct: number) => (pct > 85 ? "bad" : pct > 70 ? "warn" : undefined);
const rate = (bps: number) => `${bytes(bps)}/s`;

interface Series {
  key: string;
  name: string;
  icon: IconName;
  value: string;
  detail: string;
  tone?: "warn" | "bad";
  unit: string;
  format: "int" | "pct";
  pick: (p: AppMetricPoint) => number;
  domain?: [number, number];
  foot: (values: number[]) => [string, string];
}

/** The four cells, in order, for the skeleton too. */
const CELLS: Array<{ key: string; name: string; icon: IconName }> = [
  { key: "cpu", name: "CPU", icon: "cpu" },
  { key: "memory", name: "Memory", icon: "layers" },
  { key: "network", name: "Network", icon: "updown" },
  { key: "restarts", name: "Restarts", icon: "refresh" },
];

function seriesOf(m: AppMetrics, range: MetricRange): Series[] {
  const now = m.current!;
  const memPct = (b: number) => (m.limits.memoryBytes ? (b / m.limits.memoryBytes) * 100 : 0);
  const last = m.points.at(-1);
  const restarts = m.points.reduce((a, p) => a + p.restarts, 0);
  const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
  const peak = (v: number[]) => (v.length ? Math.max(...v) : 0);
  // Percent charts keep a little headroom over their peak, so a quiet app never reads as flat at the top.
  const pctDomain = (pick: (p: AppMetricPoint) => number): [number, number] => [0, Math.min(100, Math.max(10, peak(m.points.map(pick)) * 1.4))];
  const cpu = (p: AppMetricPoint) => p.cpuPct;
  const mem = (p: AppMetricPoint) => Math.round(memPct(p.memoryBytes) * 10) / 10;
  const series: Series[] = [
    {
      key: "cpu",
      name: "CPU",
      icon: "cpu",
      value: usagePct(now.cpuPct),
      detail: `Now, of the ${cores(m.limits.cpuCores)} limit`,
      tone: toneOf(now.cpuPct),
      unit: "CPU",
      format: "pct",
      pick: cpu,
      domain: pctDomain(cpu),
      foot: (v) => [`Average ${Math.round(avg(v))}%`, `Peak ${Math.round(peak(v))}%`],
    },
    {
      key: "memory",
      name: "Memory",
      icon: "layers",
      value: bytes(now.memoryBytes),
      detail: `Now, of ${bytes(m.limits.memoryBytes)}, ${usagePct(memPct(now.memoryBytes))}`,
      tone: toneOf(memPct(now.memoryBytes)),
      unit: "Memory",
      format: "pct",
      pick: mem,
      domain: pctDomain(mem),
      foot: (v) => [`Average ${Math.round(avg(v))}%`, `Peak ${Math.round(peak(v))}%`],
    },
    {
      key: "network",
      name: "Network",
      icon: "updown",
      value: rate((last?.netInBps ?? 0) + (last?.netOutBps ?? 0)),
      detail: `Now, in ${rate(last?.netInBps ?? 0)}, out ${rate(last?.netOutBps ?? 0)}`,
      unit: "KB/s",
      format: "int",
      pick: (p) => Math.round((p.netInBps + p.netOutBps) / 1024),
      foot: (v) => [`Average ${Math.round(avg(v)).toLocaleString("en-US")} KB/s`, `Peak ${Math.round(peak(v)).toLocaleString("en-US")} KB/s`],
    },
    {
      key: "restarts",
      name: "Restarts",
      icon: "refresh",
      value: restarts.toLocaleString("en-US"),
      detail: restarts ? RANGE_WORDS[range] : `None, ${RANGE_WORDS[range].toLowerCase()}`,
      tone: restarts >= 3 ? "bad" : restarts ? "warn" : undefined,
      unit: "Restarts",
      format: "int",
      pick: (p) => p.restarts,
      domain: [0, Math.max(2, ...m.points.map((p) => p.restarts))],
      foot: () => ["", ""],
    },
  ];
  return series;
}

/** One metric: the KPI cell's head and figure (a tone dot when it runs hot), then its chart and foot. */
function MetricCell({ s, m, range, now, local, delay }: { s: Series; m: AppMetrics; range: MetricRange; now: number; local: boolean; delay: number }) {
  const time = useTimeFormat();
  const values = m.points.map(s.pick);
  const points = m.points.map((p, i, a) => ({ label: i === a.length - 1 ? "Now" : pointLabel(p.at, range, local, time), value: s.pick(p) }));
  const [left, right] = s.foot(values);
  const cell: KpiData = { icon: s.icon, label: s.name, value: s.value, lead: s.detail, tone: s.tone };
  return (
    <KpiCell cell={cell} delay={delay}>
      <div className="at-mchart">
        <SparkArea fluid points={points} unit={s.unit} format={s.format} domain={s.domain} tone={s.tone ? `var(--${s.tone})` : "var(--chart)"} />
      </div>
      <div className="at-mfoot num">
        {s.key === "restarts" ? (
          <span>{m.lastRestartAt ? <When iso={m.lastRestartAt} now={now} prefix="Last restart" /> : "No restarts recorded"}</span>
        ) : (
          <>
            <span>{left}</span>
            <span>{right}</span>
          </>
        )}
      </div>
    </KpiCell>
  );
}

/** The four cells at their loaded size: real labels, bars for the figures, the chart and the foot. */
function CellSkeleton({ c }: { c: (typeof CELLS)[number] }) {
  return (
    <KpiCell cell={{ icon: c.icon, label: c.name, value: <Skel w={96} h={28} />, lead: <Skel w={120} /> }}>
      <div className="at-mchart">
        <Skel h="100%" r={8} />
      </div>
      <div className="at-mfoot">
        <Skel w={96} />
        <Skel w={72} />
      </div>
    </KpiCell>
  );
}

/** How close the app runs to each limit: one row per limit with a meter and its reading. */
function Limits({ m, onSettings }: { m: AppMetrics; onSettings: () => void }) {
  const can = useCan();
  const now = m.current!;
  const rows = [
    { name: "CPU", limit: cores(m.limits.cpuCores), pct: now.cpuPct, text: usagePct(now.cpuPct) },
    {
      name: "Memory",
      limit: bytes(m.limits.memoryBytes),
      pct: m.limits.memoryBytes ? (now.memoryBytes / m.limits.memoryBytes) * 100 : 0,
      text: bytes(now.memoryBytes),
    },
    { name: "Processes", limit: `${m.limits.pids.toLocaleString("en-US")} processes`, pct: m.limits.pids ? (now.pids / m.limits.pids) * 100 : 0, text: now.pids.toLocaleString("en-US") },
  ];
  return (
    <TabCard
      id="at-lim-title"
      icon="sliders"
      title="Limit usage"
      sub="Right now, against the limits this app runs with"
      actions={
        // A labelled write key is not rendered for a Viewer.
        can.manage ? (
          <button type="button" className="btn btn-sm" onClick={onSettings}>
            Change limits
          </button>
        ) : undefined
      }
    >
      <ul className="soft-list at-lim">
        {rows.map((r) => (
          <li key={r.name} className="at-lim-row">
            <span className="two">
              <span className="two-main">{r.name}</span>
              <span className="two-sub num">Limit {r.limit}</span>
            </span>
            <Meter label={r.name} pct={r.pct} text={r.text} className="at-lim-meter" />
          </li>
        ))}
      </ul>
    </TabCard>
  );
}

export function MetricsTab({ app, now, range, onRange, onSettings }: { app: AppDetail; now: number; range: MetricRange; onRange: (r: MetricRange) => void; onSettings: () => void }) {
  const local = useHydrated();
  const q = useAppTab<AppMetrics>(app.id, "metrics", { range });
  const m = q.data;
  // The limits read "right now", whichever range answered last, so the card holds while a range loads.
  const current = m?.current ? m : (q.latest?.current ? q.latest : null);
  const head = <Segmented label="Metrics range" value={range} onChange={onRange} options={RANGES} />;

  let body: React.ReactNode;
  if (!m && q.loading) {
    body = (
      <section className="kpi" aria-busy="true">
        <div className="kpi-grid at-mgrid" data-cols="2" role="status" aria-label="Loading metrics">
          {CELLS.map((c) => (
            <CellSkeleton key={c.key} c={c} />
          ))}
        </div>
      </section>
    );
  } else if (!m) {
    body = <TabFailed error={q.error} onRetry={q.reload} what="Metrics for this app" />;
  } else if (!m.current || m.points.length < 2) {
    // A missing reading is not a stopped app: say "Not running" only when the header offers Start.
    const stopped = notRunning(app.status);
    body = (
      <Empty
        icon="server"
        title={stopped ? "Not running" : "No metrics yet"}
        body={stopped ? "Start the app to see its CPU, memory, network and restarts here." : "Charts appear once the metrics sampler has a few readings for this app."}
      />
    );
  } else {
    const series = seriesOf(m, range);
    body = (
      <section className="kpi" aria-label={`Metrics, ${RANGE_WORDS[range].toLowerCase()}`}>
        <div className="kpi-grid at-mgrid" data-cols="2" data-loading={q.loading || undefined} aria-busy={q.loading || undefined}>
          {series.map((s, i) => (
            <MetricCell key={s.key} s={s} m={m} range={range} now={now} local={local} delay={i * 50} />
          ))}
        </div>
      </section>
    );
  }

  const restarts = m?.points.reduce((a, p) => a + p.restarts, 0) ?? 0;
  return (
    <div className="pd-stack">
      <TabCard
        id="at-met-title"
        icon="activity"
        title="Metrics"
        sub={m?.current ? `${RANGE_WORDS[range]}, ${plural(restarts, "restart")}` : RANGE_WORDS[range]}
        actions={head}
      >
        {body}
      </TabCard>
      {current ? <Limits m={current} onSettings={onSettings} /> : null}
    </div>
  );
}
