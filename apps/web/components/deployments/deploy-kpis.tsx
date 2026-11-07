"use client";

import type { SparkPoint } from "@/components/spark-area";
import { KpiStrip, type KpiData } from "@/components/ui/kpi";
import { kpiDelta } from "@/lib/derive";
import { duration } from "@/lib/format";
import { useHydrated } from "@/lib/hooks";
import { useTimeFormat } from "@/lib/time-prefs";
import type { DeploymentStats } from "@/lib/pages/deployments";

type Bucket = NonNullable<DeploymentStats["buckets"]>[number];

/** Sparkline point labels: "14:05" in the user's clock. */
type HourLabel = (iso: string) => string;

function cells(s: DeploymentStats, hourLabel: HourLabel): KpiData[] {
  const building = s.inFlight - s.queued;
  const finished = s.succeeded24h + s.failed24h;
  const buckets = s.buckets ?? [];
  const points = (pick: (b: Bucket, i: number) => number): SparkPoint[] =>
    buckets.map((b, i, a) => ({ label: i === a.length - 1 ? "Now" : hourLabel(b.at), value: pick(b, i) }));
  const spark = (pick: (b: Bucket, i: number) => number, unit: string): KpiData["spark"] =>
    buckets.length > 1 ? { unit, format: "int", points: points(pick) } : undefined;
  // A two-hour slot with no successful build keeps the last median, so the line does not dip to zero.
  let carry = 0;
  const medians = buckets.map((b) => (carry = b.medianSeconds ?? carry));

  return [
    {
      label: "In flight",
      icon: "deploy",
      value: s.inFlight,
      tone: s.inFlight > 0 ? "live" : undefined,
      lead: s.inFlight ? `${building} building, ${s.queued} queued` : "Nothing building right now",
      // Builds started per two-hour slot, so the cell shows how busy the last day was.
      spark: spark((b) => b.ready + b.failed, "builds"),
    },
    {
      label: "Succeeded, 24 hours",
      icon: "checkCircle",
      value: s.succeeded24h,
      lead: s.succeededPrev24h === undefined ? "Last 24 hours" : `${s.succeededPrev24h} in the 24 hours before`,
      delta: kpiDelta(s.succeeded24h, s.succeededPrev24h, "ok", `${s.succeeded24h} now, ${s.succeededPrev24h ?? 0} the day before`),
      spark: spark((b) => b.ready, "succeeded"),
    },
    {
      label: "Failed, 24 hours",
      icon: "alert",
      value: s.failed24h,
      // A red dot when anything failed, as the alerts strip marks a firing rule.
      tone: s.failed24h ? "bad" : undefined,
      lead: finished ? `${Math.round((s.failed24h / finished) * 100)}% of finished builds` : "No finished builds",
      delta: kpiDelta(s.failed24h, s.failedPrev24h, "bad", `${s.failed24h} now, ${s.failedPrev24h ?? 0} the day before`),
      spark: spark((b) => b.failed, "failed"),
    },
    {
      label: "Build time",
      icon: "clock",
      value: s.medianSeconds === null ? "None" : duration(s.medianSeconds),
      lead: s.medianSeconds === null ? "No successful builds in 24 hours" : "Median, last 24 hours",
      delta:
        s.medianSeconds === null
          ? undefined
          : kpiDelta(s.medianSeconds, s.medianPrevSeconds, "bad", `${duration(s.medianSeconds)} now, ${s.medianPrevSeconds ? duration(s.medianPrevSeconds) : "none"} the day before`),
      spark: spark((_, i) => medians[i]!, "seconds"),
    },
  ];
}

export function DeployKpis({ stats }: { stats: DeploymentStats }) {
  // Browser-local hours wait for mount, so the server render agrees; a picked zone does not.
  const hydrated = useHydrated();
  const time = useTimeFormat();
  const utc = !hydrated && !time.prefs.timeZone;
  return <KpiStrip label="Deployment numbers" cells={cells(stats, (iso) => time.clock(iso, { utc }))} />;
}
