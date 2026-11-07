"use client";

import { useState } from "react";
import type { IconName } from "@/components/icon";
import { SparkArea } from "@/components/spark-area";
import { KpiCell } from "@/components/ui/kpi";
import { Segmented } from "@/components/ui/segmented";
import { Skel } from "@/components/ui/skeleton";
import { callJson } from "@/lib/client-api";
import { clause, sizePair } from "@/lib/format";
import { useHydrated } from "@/lib/hooks";
import { pointLabel, useTimeFormat } from "@/lib/time-prefs";
import type { MetricPoint, MetricRange, MetricsResult, ServerMetrics } from "@/lib/pages/server-backups";
import type { HostSnapshot } from "@/lib/types";
import { useKeyedLoad } from "@/lib/use-keyed-load";
import { useTween } from "./live";

/*
 * The four host metric cards on /server: the shared KPI cell with its own range picker in the
 * head, the live figure (labelled "Now": it never depends on the range), then the range's chart and
 * its average and peak, which show only once that range's samples are in (lib/use-keyed-load.ts).
 */

const RANGES: Array<{ value: MetricRange; label: string }> = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
];

type MetricKey = "cpu" | "memory" | "disk" | "network";

const METRICS: Array<{ key: MetricKey; name: string; icon: IconName }> = [
  { key: "cpu", name: "CPU", icon: "cpu" },
  { key: "memory", name: "Memory", icon: "layers" },
  { key: "disk", name: "Disk", icon: "box" },
  { key: "network", name: "Network", icon: "activity" },
];


/** A busy reading: the figure gains the warn or bad dot, the chart keeps the one chart colour. */
const toneOf = (pct: number) => (pct > 85 ? "bad" : pct > 70 ? "warn" : undefined);

/** One range's samples from the dashboard's route. */
async function readRange(range: string, signal: AbortSignal) {
  const r = await callJson<MetricsResult>(`/api/server/metrics?range=${range}`, { signal });
  if (!r.ok) return { error: r.error, aborted: r.aborted };
  const points = r.data?.data?.points;
  return points ? { data: points } : { error: r.data?.error ?? "The API sent no samples" };
}

function MetricCard({ metric, host, initial }: { metric: (typeof METRICS)[number]; host: HostSnapshot; initial: ServerMetrics | null }) {
  const [range, setRange] = useState<MetricRange>("24h");
  const q = useKeyedLoad<MetricPoint[]>(range, readRange, initial ? { key: initial.range, data: initial.points } : null);
  const series = q.data ?? undefined;
  const time = useTimeFormat();
  const net = metric.key === "network";
  const local = useHydrated();
  // An unknown link speed comes as null: the card says "Outbound" and nothing divides by it. The
  // series is Mbps already (the API's toPoints), so it is drawn as it comes.
  const link = host.network.capacityMbps ?? 0;
  const share = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
  const nowPct =
    metric.key === "cpu"
      ? host.cpu.usedPct
      : metric.key === "memory"
        ? share(host.memory.usedBytes, host.memory.totalBytes)
        : metric.key === "disk"
          ? share(host.disk.usedBytes, host.disk.totalBytes)
          : share(host.network.outMbps, link);
  const tone = net ? undefined : toneOf(nowPct);
  const live = net ? host.network.outMbps : nowPct;
  // Each poll eases the figure from the last reading to the new one.
  const eased = useTween(live);
  const detail =
    metric.key === "cpu"
      ? `${host.cpu.cores} vCPU, load ${host.load1.toFixed(2)}`
      : metric.key === "memory"
        ? sizePair(host.memory.usedBytes, host.memory.totalBytes)
        : metric.key === "disk"
          ? sizePair(host.disk.usedBytes, host.disk.totalBytes)
          : link > 0
            ? `Outbound, ${link >= 1000 ? `${link / 1000} Gbps` : `${link} Mbps`} link`
            : "Outbound";

  // Stored samples keep their own times; the live reading is the one point called "Now", so the
  // chart, Average and Peak agree with the figure above them.
  const points = series?.length
    ? [
        ...series.map((p) => ({
          label: pointLabel(p.at, range, local, time),
          value: net ? Math.round(p.network * 10) / 10 : p[metric.key],
        })),
        { label: "Now", value: Math.round(live * 10) / 10 },
      ]
    : undefined;
  const values = points?.map((p) => p.value) ?? [];
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const peak = values.length ? Math.max(...values) : 0;
  const fmt = (v: number) => (net ? `${Math.round(v)} Mbps` : `${Math.round(v)}%`);

  return (
    <KpiCell
      cell={{
        icon: metric.icon,
        label: metric.name,
        value: net ? Math.round(eased).toLocaleString("en-US") : `${Math.round(eased)}%`,
        unit: net ? "Mbps" : undefined,
        lead: `Now, ${detail}`,
        tone,
      }}
      actions={<Segmented label={`${metric.name} range`} value={range} onChange={setRange} options={RANGES} />}
    >
      <div className="sb-trend">
        {points && points.length > 1 ? (
          <SparkArea
            fluid
            points={points}
            unit={net ? "Mbps out" : metric.name}
            format={net ? "int" : "pct"}
            domain={[0, net ? Math.max(1, peak) * 1.5 : Math.min(100, Math.max(10, peak) * 1.5)]}
            tone="var(--chart)"
          />
        ) : q.error ? (
          <div className="sb-trend-msg" role="alert">
            <span>Could not load the {range} series. {clause(q.error)}.</span>
            <button type="button" className="btn btn-xs" onClick={q.reload}>
              Try again
            </button>
          </div>
        ) : series ? (
          <div className="sb-trend-msg">
            <span>No samples for this range yet.</span>
          </div>
        ) : (
          <div className="sb-trend-load" role="status" aria-label="Loading">
            <Skel h="100%" r={8} />
          </div>
        )}
      </div>
      <div className="sb-trend-ft num">
        {points && points.length > 1 ? (
          <>
            <span>Average {fmt(avg)}</span>
            <span>Peak {fmt(peak)}</span>
          </>
        ) : (
          <span>{range === "1h" ? "Last hour" : range === "24h" ? "Last 24 hours" : "Last 7 days"}</span>
        )}
      </div>
    </KpiCell>
  );
}

/** Four metric cards, each with its own range. The page's 24h samples come with every poll. */
export function Metrics({ host, initial }: { host: HostSnapshot; initial: ServerMetrics | null }) {
  return (
    <section className="kpi" aria-label="Host metrics">
      <div className="kpi-grid sb-metrics" data-cols="2">
        {METRICS.map((m) => (
          <MetricCard key={m.key} metric={m} host={host} initial={initial} />
        ))}
      </div>
    </section>
  );
}
