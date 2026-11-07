"use client";

import Link from "next/link";
import { CardTitle } from "@/components/card-title";
import { Icon, type IconName } from "@/components/icon";
import { IconTile } from "@/components/ui/icon-tile";
import { Meter } from "@/components/ui/meter";
import { PendingButton } from "@/components/ui/pending";
import { When } from "@/components/ui/when";
import { bytes, plural } from "@/lib/format";
import type { ControlPlaneBackup, JanitorStatus } from "@/lib/pages/server-backups";
import { useCan } from "@/lib/viewer";
import { Countdown } from "./live";

/** One row: a tile, a two-line label, then the reading at the right end. */
function Row({ icon, title, sub, subTone, children }: { icon: IconName; title: string; sub: React.ReactNode; subTone?: "bad" | "warn"; children: React.ReactNode }) {
  return (
    <li className="soft-row srv-mt-row">
      <IconTile>
        <Icon name={icon} />
      </IconTile>
      <span className="two srv-mt-id">
        <span className="two-main">{title}</span>
        <span className={subTone ? `two-sub tone-${subTone}` : "two-sub"}>{sub}</span>
      </span>
      <span className="srv-mt-end">{children}</span>
    </li>
  );
}

const CPB_STATUS = { ready: "Backed up", running: "Running", failed: "Failed", none: "Never run" } as const;

/**
 * What Dockify does to keep the disk from filling and to keep itself recoverable: the build cache
 * against its size cap (with a prune), the rollback images it pins, the next cleanup run, and the
 * backup of its own database. An API that reports neither gets no card at all, rather than a tall
 * empty one that says nothing about this server.
 */
export function MaintenanceCard({
  janitor,
  cpb,
  now,
  onPruneCache,
  pruning,
  cacheReclaimable,
}: {
  janitor: JanitorStatus | null;
  cpb: ControlPlaneBackup | null;
  now: number;
  onPruneCache: () => void;
  pruning: boolean;
  /** Unused cache the prune can free right now. */
  cacheReclaimable: number;
}) {
  const { manage } = useCan();
  if (!janitor && !cpb) return null;

  const cache = janitor?.buildCache;
  const cachePct = cache && cache.capBytes ? (cache.bytes / cache.capBytes) * 100 : 0;
  return (
    <section className="card srv-mt" aria-labelledby="srv-mt-title">
      <div className="card-hd">
        <CardTitle
          id="srv-mt-title"
          icon="refresh"
          title="Maintenance"
          sub={janitor?.lastRunAt ? <When iso={janitor.lastRunAt} now={now} prefix="Cleanup ran" /> : "Cleanup has not run yet"}
        />
      </div>
      <ul className="soft-list srv-mt-list">
        {janitor && cache ? (
          <Row
            icon="layers"
            title="Build cache"
            sub={`${cacheReclaimable ? `${bytes(cacheReclaimable)} unused` : "Nothing unused"}, trimmed by size, never on a timer`}
          >
            <Meter label="Build cache, share of its cap" pct={cachePct} text={`${bytes(cache.bytes)} of ${bytes(cache.capBytes)}`} width={64} />
            {manage ? (
              <PendingButton className="btn btn-xs" onClick={onPruneCache} pending={pruning} disabled={cacheReclaimable === 0}>
                Prune cache
              </PendingButton>
            ) : null}
          </Row>
        ) : null}
        {janitor ? (
          <Row
            icon="rollback"
            title="Pinned rollback images"
            sub={`Last ${plural(janitor.pinnedImages.perApp, "ready image")} per app, never pruned`}
          >
            <span className="two srv-mt-read">
              <span className="two-main num">{plural(janitor.pinnedImages.count, "image")}</span>
              <span className="two-sub num">
                {bytes(janitor.pinnedImages.bytes)}, {plural(janitor.pinnedImages.apps, "app")}
              </span>
            </span>
          </Row>
        ) : null}
        {janitor ? (
          <Row
            icon="clock"
            title="Next cleanup"
            sub={
              janitor.lastFreedBytes !== null && janitor.lastRunAt ? (
                <>Last run freed <span className="num">{bytes(janitor.lastFreedBytes)}</span></>
              ) : (
                "Prunes dangling images and trims the build cache"
              )
            }
          >
            {/* The relative time, with the exact UTC time in its tip, as every next run reads. */}
            <span className="two srv-mt-read">
              {janitor.nextRunAt ? (
                <Countdown at={janitor.nextRunAt} serverNow={now} className="two-main num" tipAlign="end" />
              ) : (
                <span className="two-main none">Not planned</span>
              )}
            </span>
          </Row>
        ) : null}
        {cpb ? (
          <Row
            icon="database"
            title="Control-plane backup"
            subTone={cpb.status === "failed" ? "bad" : !cpb.storage ? "warn" : undefined}
            sub={
              cpb.status === "failed"
                ? (cpb.error ?? "The last backup failed")
                : `${cpb.storage ? cpb.storage.name : "This server only, not off-server"}${cpb.encrypted ? ", encrypted" : ""}, before every update`
            }
          >
            <span className="two srv-mt-read">
              <span className={`two-main${cpb.status === "failed" ? " tone-bad" : cpb.status === "running" ? " tone-live" : ""}`}>
                {CPB_STATUS[cpb.status]}
                {cpb.sizeBytes && cpb.status === "ready" ? <span className="num">, {bytes(cpb.sizeBytes)}</span> : null}
              </span>
              <span className="two-sub">
                <When iso={cpb.lastAt} now={now} utc fallback="No backup yet" tipAlign="end" />
              </span>
            </span>
          </Row>
        ) : null}
      </ul>
      {cpb && !cpb.storage ? (
        <div className="card-foot srv-mt-foot">
          <span>Dockify’s own backup should leave this server too.</span>
          <Link href="/settings?section=integrations" className="btn btn-sm">
            Choose storage
          </Link>
        </div>
      ) : null}
    </section>
  );
}
