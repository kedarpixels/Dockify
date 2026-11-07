"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { Topbar } from "@/components/shell/topbar";
import { NoSource } from "@/components/ui/no-source";
import { UptimeChip } from "@/components/ui/uptime-chip";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Updating } from "@/components/ui/updating";
import { deriveNotices } from "@/lib/derive";
import { bytes, plural } from "@/lib/format";
import { useNow, useOverview } from "@/lib/hooks";
import type { DiskSlice, PruneResult, ServerResult, UpdateStatus } from "@/lib/pages/server-backups";
import type { OverviewResult } from "@/lib/types";
import { track } from "./live";
import { ContainersCard } from "./server-containers";
import { DiskCard, PruneDialog, SLICE } from "./server-disk";
import { ServicesCard, SystemCard } from "./server-health";
import { MaintenanceCard } from "./server-maintenance";
import { Metrics } from "./server-metrics";
import { UpdatesCard } from "./server-updates";
import { send, usePoll } from "./use-poll";

/**
 * A failed read keeps the last good snapshot. During a self-update the api is stopped and every read
 * fails, and swapping the page for its no-source state would unmount the card following the update.
 */
const hasServer = (r: ServerResult) => r.data !== null;

export function ServerView({ overview, initial, temporaryAddress = false }: { overview: OverviewResult; initial: ServerResult; temporaryAddress?: boolean }) {
  const { result: ov } = useOverview(overview);
  const { result, setResult, refreshing } = usePoll(initial, "/api/server", 15_000, hasServer);
  const now = useNow(10_000, initial.fetchedAt);
  // The slices the open prune dialog offers: all of them from the disk card, the cache alone from Maintenance.
  const [confirming, setConfirming] = useState<DiskSlice[] | null>(null);
  const [pruning, setPruning] = useState<"disk" | "cache" | null>(null);
  // Set synchronously, so a second confirm in the same frame cannot start a second prune.
  const pruneLock = useRef(false);
  const s = result.data;
  const preview = result.source === "preview";

  const notices = useMemo(() => (ov.data ? deriveNotices(ov.data, now) : null), [ov.data, now]);

  // A finished prune updates the breakdown and the host totals in place; the next poll confirms.
  const pruned = (r: PruneResult) =>
    setResult((prev) => {
      if (!prev.data) return prev;
      const host = prev.data.host;
      const janitor = prev.data.janitor;
      const cache = r.disk.find((d) => d.id === "buildCache");
      return {
        ...prev,
        data: {
          ...prev.data,
          disk: r.disk,
          janitor: janitor && cache ? { ...janitor, buildCache: { ...janitor.buildCache, bytes: cache.bytes } } : janitor,
          host: {
            ...host,
            disk: { ...host.disk, usedBytes: Math.max(0, host.disk.usedBytes - r.reclaimedBytes), reclaimableBytes: r.disk.reduce((n, d) => n + d.reclaimableBytes, 0) },
          },
        },
      };
    });

  // Confirming closes the dialog; the toast follows the prune and names the freed size.
  const prune = async (targets: DiskSlice[]) => {
    setConfirming(null);
    if (!s || pruneLock.current || !targets.length) return;
    pruneLock.current = true;
    setPruning(targets.length === 1 && targets[0]!.id === "buildCache" ? "cache" : "disk");
    const total = targets.reduce((n, d) => n + d.reclaimableBytes, 0);
    const { host } = s;
    await track(send<PruneResult>("/api/server/prune", "POST", { targets: targets.map((d) => d.id) }), {
      preview,
      loading: "Pruning disk",
      description: `${host.name}, up to ${bytes(total)} from ${targets.map((d) => SLICE[d.id].prune!.title.toLowerCase()).join(", ")}`,
      success: (r) => {
        pruned(r);
        const left = Math.max(0, host.disk.usedBytes - r.reclaimedBytes);
        return {
          title: r.reclaimedBytes > 0 ? `Freed ${bytes(r.reclaimedBytes)}` : "Nothing to free",
          description: `${host.name} disk is now at ${Math.round((left / host.disk.totalBytes) * 100)}%`,
        };
      },
      error: "Could not prune the disk",
    });
    pruneLock.current = false;
    setPruning(null);
  };

  const setUpdates = useCallback((updates: UpdateStatus) => setResult((prev) => ({ ...prev, updates })), [setResult]);

  // The lead names the host and says how it is doing; cores and memory sit on the cards below.
  // An empty name or region is left out rather than leaving a stray "in" or comma.
  const where = s ? [s.host.name, s.host.region ? `in ${s.host.region}` : ""].filter(Boolean).join(" ") : "";
  const running = s ? s.containers.filter((c) => c.state === "running").length : 0;
  const state = !s ? "" : s.containers.length ? `${running} of ${plural(s.containers.length, "container")} running` : "no containers yet";
  const lead = !s ? "The one server that runs every project." : where ? `${where}, ${state}.` : `${state.charAt(0).toUpperCase()}${state.slice(1)}.`;
  // When the API sends neither the cleanup status nor the control-plane backup, the card and its band stay out.
  const maintenance = Boolean(s && (s.janitor || s.controlPlaneBackup));

  return (
    <>
      <Topbar trail={["Server"]} notices={notices} now={now} />
      <main className="page" id="main" tabIndex={-1}>
        <SectionHead
          level={1}
          title="Server"
          lead={
            temporaryAddress ? (
              <>
                {lead}
                <span className="dd-temp">
                  <Link href="/settings?section=instance&tab=domain">Temporary address, use your own domain for real use</Link>
                </span>
              </>
            ) : (
              lead
            )
          }
          actions={
            refreshing || s ? (
              <>
                {refreshing ? <Updating /> : null}
                {s ? <UptimeChip seconds={s.host.uptimeSeconds + (now - Date.parse(result.fetchedAt)) / 1000} /> : null}
              </>
            ) : null
          }
        />
        <Rule />

        {!s ? (
          <>
            <NoSource error={result.error} polling={result.source === "api"} />
            <Spacer end />
          </>
        ) : (
          <>
            <Metrics host={s.host} initial={result.metrics} />
            <Spacer />
            <DiskCard host={s.host} disk={s.disk} onPrune={() => setConfirming(s.disk)} pruning={pruning === "disk"} />
            <Spacer />
            <div className="split" data-stretch="true">
              <ServicesCard services={s.services} checkedAt={result.fetchedAt} now={now} />
              <div className="col">
                <SystemCard s={s} />
              </div>
            </div>
            <Spacer />
            <ContainersCard containers={s.containers} now={now} host={s.host} />
            <Spacer />
            <UpdatesCard status={result.updates} now={now} preview={preview} onStatus={setUpdates} />
            {maintenance ? (
              <>
                <Spacer />
                <MaintenanceCard
                  janitor={s.janitor ?? null}
                  cpb={s.controlPlaneBackup ?? null}
                  now={now}
                  pruning={pruning === "cache"}
                  cacheReclaimable={s.disk.find((d) => d.id === "buildCache")?.reclaimableBytes ?? 0}
                  onPruneCache={() => setConfirming(s.disk.filter((d) => d.id === "buildCache"))}
                />
              </>
            ) : null}
            <Spacer end />
            <PruneDialog
              open={confirming !== null}
              onClose={() => setConfirming(null)}
              host={s.host}
              disk={confirming ?? s.disk}
              onConfirm={(t) => void prune(t)}
            />
          </>
        )}
      </main>
    </>
  );
}
