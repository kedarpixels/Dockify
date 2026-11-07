"use client";

import { CardTitle } from "@/components/card-title";
import { ConfirmDialog } from "@/components/ui/dialog";
import { PendingButton } from "@/components/ui/pending";
import { Corners } from "@/components/ui/rule";
import { bytes, plural, sizePair } from "@/lib/format";
import { useCan } from "@/lib/viewer";
import type { DiskSlice, DiskSliceId } from "@/lib/pages/server-backups";
import type { HostSnapshot } from "@/lib/types";

/* The disk breakdown card on /server and the prune it confirms. */

export const SLICE: Record<DiskSliceId, { label: string; unit: string; spare: string; prune?: { title: string; body: string } }> = {
  images: {
    label: "Images",
    unit: "image",
    spare: "dangling",
    prune: { title: "Dangling images", body: "Untagged layers left behind by rebuilds. Tagged images used for rollback stay." },
  },
  buildCache: {
    label: "Build cache",
    unit: "entry",
    spare: "unused",
    prune: { title: "Unused build cache", body: "Layers no recent build has used. The next cold build of an app takes longer." },
  },
  volumes: { label: "Volumes", unit: "volume", spare: "" },
  logs: {
    label: "Logs",
    unit: "file",
    spare: "rotated",
    prune: { title: "Rotated logs", body: "Compressed log files already rotated out. Live container logs stay." },
  },
};

/** What a prune can free: the reclaimable part of every slice it may touch (never volumes). */
const pruneTargets = (disk: DiskSlice[]) => disk.filter((d) => SLICE[d.id].prune && d.reclaimableBytes > 0);
const prunable = (disk: DiskSlice[]) => pruneTargets(disk).reduce((n, d) => n + d.reclaimableBytes, 0);

const unitPlural = (n: number, unit: string) => (unit === "entry" ? plural(n, "entry", "entries") : plural(n, unit));

/**
 * Full width: the whole disk as one stacked bar with a sized legend, then one ruled cell per
 * slice. Each slice bar is drawn in that slice's own colour, its reclaimable part a soft tint of
 * the same colour, so the cells read straight off the legend. Whatever Docker does not account
 * for (the OS, other files) is its own grey slice, so a full disk never draws as an empty bar.
 * The used share itself is the Disk metric above, so it is not repeated here.
 */
export function DiskCard({ host, disk, onPrune, pruning }: { host: HostSnapshot; disk: DiskSlice[]; onPrune: () => void; pruning: boolean }) {
  const { manage } = useCan();
  const used = disk.reduce((n, d) => n + d.bytes, 0);
  const other = Math.max(0, host.disk.usedBytes - used);
  const spare = prunable(disk);
  const free = Math.max(0, host.disk.totalBytes - host.disk.usedBytes);
  const share = (n: number) => `round(${host.disk.totalBytes ? (n / host.disk.totalBytes) * 100 : 0}%, 1px)`;
  return (
    <section className="card sb-disk" aria-labelledby="sb-disk-title">
      <div className="card-hd">
        <CardTitle
          id="sb-disk-title"
          icon="pie"
          title="Disk breakdown"
          sub={!disk.length ? "Docker’s share is not reported yet" : spare ? `${bytes(spare)} reclaimable` : "Nothing to reclaim"}
        />
        {manage ? (
          <PendingButton className="btn btn-sm" onClick={onPrune} pending={pruning} disabled={spare === 0}>
            Prune
          </PendingButton>
        ) : null}
      </div>

      <div className="sb-disk-total">
        <div className="sb-stack" role="img" aria-label={`${sizePair(host.disk.usedBytes, host.disk.totalBytes)} used, ${bytes(used)} of it in Docker`}>
          {/* Empty slices are left out, so the 2px gaps never leave a notch before the first real one. */}
          {disk
            .filter((d) => d.bytes > 0)
            .map((d) => (
              <span key={d.id} data-slice={d.id} style={{ width: share(d.bytes) }} />
            ))}
          {/* With Docker's slices reported, the rest is "other"; without them it is all simply used. */}
          {other > 0 ? <span data-slice={disk.length ? "other" : "used"} style={{ width: share(other) }} /> : null}
        </div>
        <ul className="sb-legend">
          {disk.map((d) => (
            <li key={d.id}>
              <i data-slice={d.id} aria-hidden="true" />
              {SLICE[d.id].label}
              <span className="sb-legend-val num">{bytes(d.bytes)}</span>
            </li>
          ))}
          <li>
            <i data-slice={disk.length ? "other" : "used"} aria-hidden="true" />
            {/* With no Docker slices reported, this is simply everything in use, not a remainder. */}
            {disk.length ? "System and other" : "Used"}
            <span className="sb-legend-val num">{bytes(other)}</span>
          </li>
          <li>
            <i data-slice="free" aria-hidden="true" />
            Free
            <span className="sb-legend-val num">{bytes(free)}</span>
          </li>
        </ul>
      </div>

      <ul className="sb-slices">
        {disk.map((d) => {
          const s = SLICE[d.id];
          const keptPct = d.bytes ? ((d.bytes - d.reclaimableBytes) / d.bytes) * 100 : 0;
          return (
            <li key={d.id} className="sb-slice" data-slice-id={d.id}>
              <Corners />
              <div className="sb-slice-hd">
                <i className="sb-slice-key" data-slice={d.id} aria-hidden="true" />
                <span className="sb-slice-name">{s.label}</span>
                {d.count !== undefined ? <span className="sb-slice-count num">{unitPlural(d.count, s.unit)}</span> : null}
              </div>
              <span className="sb-slice-val num">{bytes(d.bytes)}</span>
              <div className="sb-hbar" data-slice={d.id} role="img" aria-label={`${s.label} ${bytes(d.bytes)}, ${bytes(d.reclaimableBytes)} reclaimable`}>
                <span className="sb-hbar-kept" style={{ width: `round(${keptPct}%, 1px)` }} />
                <span className="sb-hbar-spare" style={{ width: `round(${100 - keptPct}%, 1px)` }} />
              </div>
              <span className="sb-slice-note num">
                {d.id === "volumes" ? (
                  "Never pruned here"
                ) : d.reclaimableBytes ? (
                  <>
                    <i className="sb-spare-key" data-slice={d.id} aria-hidden="true" />
                    {bytes(d.reclaimableBytes)} {s.spare}
                  </>
                ) : (
                  "Nothing to reclaim"
                )}
              </span>
            </li>
          );
        })}
        {/* Fills the grid when Docker reports an odd number of slices, so no cell is left empty. */}
        {disk.length % 2 === 1 ? (
          <li className="sb-slice" data-slice-id="free">
            <Corners />
            <div className="sb-slice-hd">
              <i className="sb-slice-key" data-slice="free" aria-hidden="true" />
              <span className="sb-slice-name">Free</span>
              <span className="sb-slice-count num">of {bytes(host.disk.totalBytes)}</span>
            </div>
            <span className="sb-slice-val num">{bytes(free)}</span>
            <div className="sb-hbar" data-slice="used" role="img" aria-label={`${bytes(free)} free of ${bytes(host.disk.totalBytes)}`}>
              <span className="sb-hbar-kept" style={{ width: share(free) }} />
            </div>
            <span className="sb-slice-note num">{bytes(host.disk.usedBytes)} used</span>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/**
 * Confirms what a prune removes. Confirming closes the dialog at once; the toast then tracks the
 * prune (it can take a minute) and reports the freed size when it lands.
 */
export function PruneDialog({
  open,
  onClose,
  host,
  disk,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  host: HostSnapshot;
  disk: DiskSlice[];
  onConfirm: (targets: DiskSlice[]) => void;
}) {
  const targets = pruneTargets(disk);
  const total = prunable(disk);
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      tone="danger"
      title="Prune disk"
      sub={`${host.name}, ${bytes(total)} reclaimable`}
      confirmLabel={`Prune ${bytes(total)}`}
      confirmIcon="trash"
      onConfirm={() => onConfirm(targets)}
      body={
        <>
          <p className="dlg-text">This removes:</p>
          <ul className="sb-dlg-list">
            {targets.map((d) => (
              <li key={d.id}>
                <span className="sb-dlg-li-hd">
                  <span className="sb-dlg-li-name">
                    <i className="sb-slice-key" data-slice={d.id} aria-hidden="true" />
                    {SLICE[d.id].prune!.title}
                  </span>
                  <span className="num">{bytes(d.reclaimableBytes)}</span>
                </span>
                <span className="sb-dlg-li-body">{SLICE[d.id].prune!.body}</span>
              </li>
            ))}
          </ul>
          <p className="sb-dlg-note">Volumes and running containers are never touched.</p>
        </>
      }
    />
  );
}
