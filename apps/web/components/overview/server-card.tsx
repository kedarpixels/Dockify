"use client";

import Link from "next/link";
import { useLayoutEffect, useState } from "react";
import { CardTitle } from "@/components/card-title";
import { cores } from "@/components/project-detail/shared";
import { SparkArea } from "@/components/spark-area";
import { Empty } from "@/components/ui/empty";
import { Node } from "@/components/ui/rule";
import { UptimeChip } from "@/components/ui/uptime-chip";
import { plural, sizePair } from "@/lib/format";
import { useHydrated } from "@/lib/hooks";
import { useTimeFormat } from "@/lib/time-prefs";
import type { HostSnapshot } from "@/lib/types";

// The first render uses the server's stamp so it matches the HTML; then each snapshot is anchored
// on the local clock, so a browser clock that is off by minutes never shifts the uptime.
function useReceivedAt(fetchedAt: string) {
  const [at, setAt] = useState(() => Date.parse(fetchedAt));
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the local clock is read once per snapshot, after hydration and before paint; reading it during render would make the server and client renders disagree.
  useLayoutEffect(() => setAt(Date.now()), [fetchedAt]);
  return at;
}

export function ServerCard({ host, now, fetchedAt }: { host?: HostSnapshot; now: number; fetchedAt: string }) {
  const receivedAt = useReceivedAt(fetchedAt);
  // Sample times read local, but the server cannot know the browser's zone: UTC until hydrated
  // unless a zone was picked, so both renders print the same labels.
  const time = useTimeFormat();
  const utc = !useHydrated() && !time.prefs.timeZone;
  const exit = (
    <Link href="/server" className="btn btn-sm">
      View server
    </Link>
  );
  if (!host) {
    return (
      <section className="card reveal srv-card" aria-labelledby="srv-title" style={{ animationDelay: "160ms" }}>
        <div className="card-hd">
          <CardTitle id="srv-title" icon="server" title="Server" sub="Host resources" />
          {exit}
        </div>
        <Empty icon="server" title="No host metrics yet" body="CPU, memory and disk appear here once the metrics sampler is running on this server." />
      </section>
    );
  }
  const up = host.uptimeSeconds + Math.max(0, now - receivedAt) / 1000;
  const series = (key: "cpu" | "memory" | "disk" | "network", scale = 1) =>
    host.history?.map((h, i, a) => ({ label: i === a.length - 1 ? "Now" : time.clock(h.at, { utc }), value: h[key] * scale }));
  // With the link speed the installer recorded, network reads as a share of the link like the other
  // meters; without it (null) the meter shows the Mbps themselves.
  const link = host.network.capacityMbps;
  const meters: Array<{ name: string; detail: string; pct: number | null; value?: string; history?: Array<{ label: string; value: number }> }> = [
    { name: "CPU", detail: cores(host.cpu.cores), pct: host.cpu.usedPct, history: series("cpu") },
    { name: "Memory", detail: sizePair(host.memory.usedBytes, host.memory.totalBytes), pct: (host.memory.usedBytes / host.memory.totalBytes) * 100, history: series("memory") },
    { name: "Disk", detail: sizePair(host.disk.usedBytes, host.disk.totalBytes), pct: (host.disk.usedBytes / host.disk.totalBytes) * 100, history: series("disk") },
    link
      ? { name: "Network", detail: `${host.network.outMbps} Mbps out`, pct: (host.network.outMbps / link) * 100, history: series("network", 100 / link) }
      : { name: "Network", detail: "Outbound", pct: null, value: `${Math.round(host.network.outMbps)} Mbps`, history: series("network") },
  ];
  return (
    <section className="card reveal srv-card" aria-labelledby="srv-title" style={{ animationDelay: "160ms" }}>
      <div className="card-hd">
        <CardTitle id="srv-title" icon="server" title="Server" sub={host.history ? "Last 24 hours" : "Current usage"} />
        {exit}
      </div>
      <div className="meters">
        {meters.map((m, i) => {
          const tone = m.pct === null ? undefined : m.pct > 85 ? "bad" : m.pct > 70 ? "warn" : undefined;
          const peak = Math.max(...(m.history ?? []).map((p) => p.value));
          return (
            <div key={m.name} className="meter" data-tone={tone}>
              {i ? (
                <>
                  <Node pos="tl" />
                  <Node pos="tr" />
                </>
              ) : null}
              <div className="meter-head">
                <span className="meter-name">{m.name}</span>
                <span className="meter-detail num">{m.detail}</span>
                <span className="meter-val num">{m.pct === null ? m.value : `${Math.round(m.pct)}%`}</span>
              </div>
              {m.history && m.history.length > 1 ? (
                <SparkArea
                  fluid
                  points={m.history}
                  unit={m.pct === null ? "Mbps out" : m.name}
                  format={m.pct === null ? "int" : "pct"}
                  domain={[0, m.pct === null ? Math.max(1, peak) * 1.5 : Math.min(100, Math.max(10, peak) * 1.5)]}
                  tone={tone ? `var(--${tone})` : "var(--chart)"}
                />
              ) : m.pct !== null ? (
                <div className="bar" data-tone={tone} role="img" aria-label={`${m.name} ${Math.round(m.pct)} percent`}>
                  <span style={{ width: `round(${Math.max(m.pct, 1.5)}%, 1px)` }} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {/* The host facts under the meters; the uptime ends the line, where the side column has room. */}
      <div className="card-foot srv-foot">
        <Node pos="tl" />
        <Node pos="tr" />
        <span className="num">
          {plural(host.containers, "container")}, load {host.load1.toFixed(2)}
        </span>
        <UptimeChip seconds={up} />
      </div>
    </section>
  );
}
