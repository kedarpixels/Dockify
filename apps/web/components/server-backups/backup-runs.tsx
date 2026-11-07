"use client";

import { useMemo, useState } from "react";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { StatusIcon } from "@/components/overview/status-icon";
import { ensureStepUp } from "@/components/step-up/step-up";
import { StatusChip } from "@/components/ui/chip";
import { Empty } from "@/components/ui/empty";
import { EnvTag } from "@/components/ui/env-tag";
import { GroupHead } from "@/components/ui/group-head";
import { PendingButton } from "@/components/ui/pending";
import { Rule } from "@/components/ui/rule";
import { Segmented, filterOptions } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { When } from "@/components/ui/when";
import { bytes, duration, plural } from "@/lib/format";
import { useDayHeading, useUtcAt } from "@/lib/time-prefs";
import type { BackupRun, BackupSchedule } from "@/lib/pages/server-backups";
import { useCan } from "@/lib/viewer";
import { testLine } from "./backup-dialogs";
import { KIND_LABEL, dbLabel, dbName, placeName } from "./util";

/** Starts a file download from a same-origin link without leaving the page. */
function saveFrom(href: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = "";
  a.click();
}

const PAGE = 20;
/** Rows each deleted database shows before "Show all". */
const ORPHAN_PEEK = 3;

const RUN_LABEL: Record<BackupRun["status"], string> = { ready: "Succeeded", failed: "Failed", running: "Running" };
const RUN_GLYPH = { ready: "ready", failed: "failed", running: "building" } as const;

const secs = (r: BackupRun) => (r.finishedAt ? (Date.parse(r.finishedAt) - Date.parse(r.createdAt)) / 1000 : null);

/** What every run row can do, and which rows are busy. */
export interface RunActions {
  onRestore: (r: BackupRun) => void;
  onTest: (r: BackupRun) => void;
  /** Database resource id to the run being restored into it. */
  restoring: Map<string, string>;
  /** Run ids whose restore test request is in flight. */
  testing: Set<string>;
}

/** The run's status mark: the shared deploy StatusIcon, announced in backup words. */
function RunMark({ status }: { status: BackupRun["status"] }) {
  return (
    <span className="sb-run-mark">
      <span aria-hidden="true">
        <StatusIcon status={RUN_GLYPH[status]} />
      </span>
      <span className="sr">{RUN_LABEL[status]}</span>
    </span>
  );
}

/** The restore test result as the one status chip, with what the test found in its tip. */
function TestCell({ r }: { r: BackupRun }) {
  const utcAt = useUtcAt();
  if (r.status !== "ready" || r.expired) return <span className="bk-test" />;
  const t = r.restoreTest;
  const when = t.testedAt ? `, ${utcAt(t.testedAt)}` : "";
  if (t.status === "passed")
    return (
      <span className="bk-test">
        <StatusChip tone="ok" tip={`${testLine(r)}${when}`}>
          Passed
        </StatusChip>
      </span>
    );
  if (t.status === "failed")
    return (
      <span className="bk-test">
        <StatusChip tone="bad" tip={`${testLine(r)}${when}`}>
          Failed
        </StatusChip>
      </span>
    );
  if (t.status === "running")
    return (
      <span className="bk-test" role="status">
        <StatusChip tone="live">Testing</StatusChip>
      </span>
    );
  return <span className="bk-test none">Not tested</span>;
}

/** Kind and place, then a lock that says whether the backup is encrypted with the instance key. */
function RunDetail({ r }: { r: BackupRun }) {
  // A failed run's reason wraps in full, so it needs no tip.
  if (r.status === "failed") return <span className="sb-run-detail tone-bad">{r.error ?? "Backup failed"}</span>;
  if (r.status === "running") return <span className="sb-run-detail ellipsis tone-live">Running, {KIND_LABEL[r.kind].toLowerCase()}</span>;
  const sealed = r.encryption.enabled;
  return (
    <span className="sb-run-detail bk-detail">
      <span className="bk-detail-text" title={`${KIND_LABEL[r.kind]}, ${placeName(r.storage)}`}>
        {KIND_LABEL[r.kind]}, {placeName(r.storage)}
      </span>
      <span
        className="bk-lock"
        data-plain={sealed ? undefined : true}
        data-tip={sealed ? `Encrypted, key ${r.encryption.fingerprint ?? "unknown"}` : "Not encrypted"}
        aria-label={sealed ? "Encrypted" : "Not encrypted"}
        role="img"
      >
        <Icon name={sealed ? "lock" : "lockOpen"} size={14} />
      </span>
    </span>
  );
}

function RunRow({ r, now, actions }: { r: BackupRun; now: number; actions: RunActions }) {
  const utcAt = useUtcAt();
  const { manage } = useCan();
  const s = secs(r);
  const restoring = actions.restoring.get(r.resourceId) === r.id;
  const locked = actions.restoring.has(r.resourceId);
  const testing = actions.testing.has(r.id) || r.restoreTest.status === "running";
  const what = `${dbLabel(r.database)} from ${utcAt(r.createdAt)}`;
  return (
    <div className="soft-row sb-run bk-run" data-hover="true" data-status={r.status}>
      <RunMark status={r.status} />
      {/* Relative, with the exact UTC time in its tip, like every time in a day-grouped list. */}
      <When iso={r.createdAt} now={now} utc className="sb-run-time num" />
      <span className="sb-run-db">
        <span className="ellipsis" title={dbLabel(r.database)}>
          <span className="sb-muted">{r.database.projectSlug} /</span> {dbName(r.database)}
        </span>
        <EnvTag env={r.database.environment} compact quiet />
      </span>
      <RunDetail r={r} />
      <TestCell r={r} />
      <span className="sb-run-size num">{r.sizeBytes ? bytes(r.sizeBytes) : ""}</span>
      <span className="sb-run-dur num">{s === null ? "" : duration(s)}</span>
      <span className="sb-run-end">
        {r.status !== "ready" ? null : r.expired ? (
          <span className="sb-muted sb-run-expired" data-tip="Retention removed the file" data-tip-align="end">
            Expired
          </span>
        ) : manage ? (
          <>
            <a
              className="btn btn-xs btn-icon"
              href={`/api/backups/${encodeURIComponent(r.id)}/download`}
              download
              aria-label={`Download backup of ${what}`}
              // A download is elevated on the API and cannot be retried from here, so it confirms it is you first.
              onClick={(e) => {
                e.preventDefault();
                const link = e.currentTarget;
                void ensureStepUp({ what: "Downloading a backup" }).then((ok) => {
                  if (ok) saveFrom(link.href);
                });
              }}
            >
              <Icon name="download" />
            </a>
            <PendingButton
              className="btn btn-xs btn-icon"
              onClick={() => actions.onTest(r)}
              pending={actions.testing.has(r.id)}
              disabled={(testing && !actions.testing.has(r.id)) || locked}
              aria-label={`Run restore test on ${what}`}
              data-tip="Run restore test"
              icon="shieldCheck"
            />
            <PendingButton className="btn btn-xs" onClick={() => actions.onRestore(r)} pending={restoring} disabled={locked && !restoring}>
              Restore
            </PendingButton>
          </>
        ) : null}
      </span>
    </div>
  );
}

/** Runs of live databases, grouped by UTC day, filterable by database. */
export function History({ runs, schedules, now, actions }: { runs: BackupRun[]; schedules: BackupSchedule[]; now: number; actions: RunActions }) {
  const heading = useDayHeading();
  const [pickedDb, setDb] = useState("all");
  // A database that left the list since it was picked falls back to all.
  const db = pickedDb === "all" || schedules.some((s) => s.resourceId === pickedDb) ? pickedDb : "all";
  const [shown, setShown] = useState(PAGE);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of runs) m.set(r.resourceId, (m.get(r.resourceId) ?? 0) + 1);
    return m;
  }, [runs]);
  // Each segment names its database; the project joins in only where two databases share a name.
  const segName = (s: BackupSchedule) => (schedules.some((x) => x !== s && dbName(x.database) === dbName(s.database)) ? dbLabel(s.database) : dbName(s.database));
  // Databases are not states, so the filter counts without dots.
  const options = filterOptions([
    { value: "all", label: "All", count: runs.length },
    ...schedules.map((s) => ({ value: s.resourceId, label: segName(s), count: counts.get(s.resourceId) ?? 0 })),
  ]);
  const choices = [
    { value: "all", label: "All databases", hint: String(runs.length) },
    ...schedules.map((s) => ({ value: s.resourceId, label: dbLabel(s.database), hint: String(counts.get(s.resourceId) ?? 0) })),
  ];
  const pickDb = (v: string) => {
    setDb(v);
    setShown(PAGE);
  };
  const picked = db === "all" ? runs : runs.filter((r) => r.resourceId === db);
  const visible = picked.slice(0, shown);

  const groups: Array<{ label: string; rows: BackupRun[] }> = [];
  for (const r of visible) {
    const label = heading(r.createdAt, now);
    if (groups.at(-1)?.label === label) groups.at(-1)!.rows.push(r);
    else groups.push({ label, rows: [r] });
  }

  return (
    <section id="sb-hist" className="card sb-hist" aria-labelledby="sb-hist-title">
      <div className="card-hd">
        <CardTitle id="sb-hist-title" icon="history" title="Backup history" sub="Last 30 days, newest first, times in UTC" />
      </div>
      {schedules.length > 1 ? (
        <>
          <div className="toolbar">
            <span className="sb-tools-wide">
              <Segmented label="Filter by database" value={db} onChange={pickDb} options={options} />
            </span>
            {/* Five segments do not fit a phone, so narrow widths get the same filter as a dropdown. */}
            <span className="sb-tools-narrow">
              <Select label="Filter by database" icon="database" value={db} onChange={pickDb} options={choices} />
            </span>
          </div>
          <Rule />
        </>
      ) : null}
      {picked.length === 0 ? (
        db === "all" ? (
          <Empty icon="box" title="No backups yet" body="Runs appear here as soon as a schedule fires or someone presses Back up now." />
        ) : (
          <Empty
            icon="box"
            title="No backups match"
            body={`Nothing for ${choices.find((c) => c.value === db)?.label ?? "this database"} in 30 days.`}
            action={
              <button type="button" className="btn btn-sm" onClick={() => pickDb("all")}>
                Clear filters
              </button>
            }
          />
        )
      ) : (
        <div className="sb-hist-list">
          {groups.map((g, i) => (
            <section key={`${i}-${g.label}`} aria-label={g.label}>
              <GroupHead label={g.label} count={g.rows.length} noun="backup" />
              <ul className="soft-list">
                {g.rows.map((r) => (
                  <li key={r.id}>
                    <RunRow r={r} now={now} actions={actions} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {picked.length > 0 ? (
        <div className="card-foot sb-hist-foot">
          <span className="num">
            Showing {visible.length.toLocaleString("en-US")} of {plural(picked.length, "backup")}
          </span>
          {visible.length < picked.length ? (
            <button type="button" className="btn btn-sm" onClick={() => setShown((n) => n + PAGE)}>
              Load more
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Backups whose database was deleted, one group per database, newest first. They stay until deleted
 * here, so the last copy of a removed database's data is never lost by accident.
 */
export function Orphans({
  runs,
  now,
  actions,
  onDelete,
  deleting,
}: {
  runs: BackupRun[];
  now: number;
  actions: RunActions;
  onDelete: (rows: BackupRun[]) => void;
  /** Resource ids whose delete is in flight. */
  deleting: Set<string>;
}) {
  const { manage } = useCan();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => {
    const m = new Map<string, BackupRun[]>();
    for (const r of runs) m.set(r.resourceId, [...(m.get(r.resourceId) ?? []), r]);
    return [...m.values()];
  }, [runs]);
  const total = runs.filter((r) => !r.expired).reduce((n, r) => n + (r.sizeBytes ?? 0), 0);

  return (
    <section className="card sb-hist" aria-labelledby="bk-orphans-title">
      <div className="card-hd">
        <CardTitle
          id="bk-orphans-title"
          icon="archive"
          title="Backups of deleted databases"
          sub={`${plural(groups.length, "database")}, ${bytes(total)}, kept until you delete them`}
        />
      </div>
      <div className="sb-hist-list">
        {groups.map((rows) => {
          const first = rows[0]!;
          const all = open.has(first.resourceId);
          const shown = all ? rows : rows.slice(0, ORPHAN_PEEK);
          const busy = deleting.has(first.resourceId);
          return (
            <section key={first.resourceId} aria-label={dbLabel(first.database)}>
              <GroupHead
                label={dbLabel(first.database)}
                icon="database"
                count={rows.length}
                noun="backup"
                actions={
                  <>
                    <span className="bk-orphan-when">
                      <When iso={first.database.deletedAt} now={now} prefix="Deleted" tipAlign="end" />
                    </span>
                    {manage ? (
                      <PendingButton className="btn btn-xs" aria-label={`Delete the backups of ${dbLabel(first.database)}`} onClick={() => onDelete(rows)} pending={busy}>
                        Delete
                      </PendingButton>
                    ) : null}
                  </>
                }
              />
              <ul className="soft-list">
                {shown.map((r) => (
                  <li key={r.id}>
                    <RunRow r={r} now={now} actions={actions} />
                  </li>
                ))}
              </ul>
              {rows.length > ORPHAN_PEEK ? (
                <div className="bk-orphan-more">
                  <button
                    type="button"
                    className="btn btn-xs"
                    aria-expanded={all}
                    onClick={() =>
                      setOpen((s) => {
                        const next = new Set(s);
                        if (all) next.delete(first.resourceId);
                        else next.add(first.resourceId);
                        return next;
                      })
                    }
                  >
                    {all ? "Show fewer" : `Show all ${rows.length}`}
                  </button>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </section>
  );
}
