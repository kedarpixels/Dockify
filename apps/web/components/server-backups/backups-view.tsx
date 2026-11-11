"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Topbar } from "@/components/shell/topbar";
import { ensureStepUp, wasCancelled } from "@/components/step-up/step-up";
import { Empty } from "@/components/ui/empty";
import { KpiStrip, type KpiData } from "@/components/ui/kpi";
import { NoSource } from "@/components/ui/no-source";
import { PendingButton } from "@/components/ui/pending";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { toast } from "@/components/ui/toast";
import { Updating } from "@/components/ui/updating";
import { When } from "@/components/ui/when";
import { deriveNotices } from "@/lib/derive";
import { describe, errText } from "@/lib/feedback";
import { bytes, firstNames, plural } from "@/lib/format";
import { useTimeFormat, useUtcAt } from "@/lib/time-prefs";
import { useNow, useOverview } from "@/lib/hooks";
import type { BackupRun, BackupSchedule, BackupsResult, OrphanDeleteResult, RestoreAccepted, RestoreOutcome, RestoreRequest } from "@/lib/pages/server-backups";
import { isOrphan } from "@/lib/pages/server-backups-shared";
import type { OverviewResult } from "@/lib/types";
import { useCan } from "@/lib/viewer";
import { DeleteOrphansDialog, RestoreDialog, RunDialog, testLine } from "./backup-dialogs";
import { History, Orphans, type RunActions } from "./backup-runs";
import { inHistory, notStarted } from "./history";
import { Schedules, StorageCard } from "./backup-schedules";
import { track, useSecond, useTween } from "./live";
import { followRestore } from "./restore-follow";
import { readRestore, send, usePoll } from "./use-poll";
import { ScheduleDialog, TIER_LABEL, TIERS, tierWords } from "./tier-schedule";
import { dbLabel, dueIn, offServer } from "./util";

const DAY = 86_400_000;

// Backups run on UTC schedules, so every absolute time on this page reads in UTC.

function sized(n: number): Pick<KpiData, "value" | "unit"> {
  const [value = "0", unit] = bytes(n).split(" ");
  return { value, unit };
}

const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function Kpis({ runs, schedules, now }: { runs: BackupRun[]; schedules: BackupSchedule[]; now: number }) {
  const month = runs.filter((r) => now - Date.parse(r.createdAt) < 30 * DAY && r.status !== "running");
  const ok = month.filter((r) => r.status === "ready").length;
  const rate = month.length ? Math.floor((ok / month.length) * 100) : null;
  const last = runs.find((r) => r.status === "ready");
  const kept = runs.filter((r) => r.status === "ready" && !r.expired);
  const size = kept.reduce((n, r) => n + (r.sizeBytes ?? 0), 0);
  const off = kept.filter(offServer).length;
  const next = schedules
    .filter((s) => s.enabled && s.nextRunAt)
    .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))[0];
  const failed = month.length - ok;
  const rateShown = Math.floor(useTween(rate ?? 0));
  const sizeShown = useTween(size);
  const tick = useSecond(now);
  const time = useTimeFormat();
  const due = next ? dueIn(next.nextRunAt!, tick) : "";
  const tested = last?.restoreTest.status;
  const running = runs.some((r) => r.status === "running");
  const anyOn = schedules.some((s) => s.enabled);

  // A missing figure reads muted, and its lead adds a fact instead of saying "none" twice.
  const cells: KpiData[] = [
    {
      icon: "history",
      label: "Last backup",
      value: last ? <When iso={last.finishedAt ?? last.createdAt} now={now} utc /> : <span className="none">None yet</span>,
      lead: last
        ? `${dbLabel(last.database)}, ${bytes(last.sizeBytes ?? 0)}${tested === "passed" ? ", test passed" : tested === "failed" ? ", test failed" : ""}`
        : running
          ? "The first one is running"
          : "Nothing to restore yet",
      tone: running ? "live" : undefined,
    },
    {
      icon: "checkCircle",
      label: "Success rate, 30 days",
      value: rate === null ? <span className="none">None yet</span> : `${rateShown}%`,
      lead: month.length ? `${ok} of ${plural(month.length, "run")}${failed ? `, ${failed} failed` : ""}` : "Counts runs once they finish",
      tone: failed ? "bad" : undefined,
    },
    {
      icon: "archive",
      label: "Total size",
      ...sized(sizeShown),
      lead: kept.length ? `${plural(kept.length, "backup")} kept, ${off === kept.length ? "all" : off.toLocaleString("en-US")} off-server` : "Nothing kept yet",
      tone: off < kept.length ? "warn" : undefined,
    },
    {
      icon: "calendar",
      label: "Next scheduled",
      value: next ? due.charAt(0).toUpperCase() + due.slice(1) : <span className="none">{anyOn ? "Not planned" : "None"}</span>,
      lead: next ? `${dbLabel(next.database)} at ${time.clock(next.nextRunAt!, { utc: true })} UTC` : anyOn ? "Not scheduled yet" : "Every schedule is off",
    },
  ];

  return <KpiStrip label="Backup summary" cells={cells} />;
}

/** A failed read keeps the last good snapshot on screen, and any dialog open over it. */
const hasBackups = (r: BackupsResult) => r.data !== null;

export function BackupsView({ overview, initial }: { overview: OverviewResult; initial: BackupsResult }) {
  const utcAt = useUtcAt();
  const router = useRouter();
  const { result: ov } = useOverview(overview);
  const [fast, setFast] = useState(false);
  const { result, setResult, refreshing } = usePoll(initial, "/api/backups", fast ? 4_000 : 20_000, hasBackups);
  const now = useNow(30_000, initial.fetchedAt);
  const [restoring, setRestoring] = useState<BackupRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [removing, setRemoving] = useState<BackupRun[] | null>(null);
  const [restoringDbs, setRestoringDbs] = useState<Map<string, string>>(() => new Map());
  const [testing, setTesting] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState<Set<string>>(() => new Set());
  const [launching, setLaunching] = useState(false);
  // Refs are set synchronously, so a second confirm in the same frame cannot start the work twice.
  const launchLock = useRef(false);
  const restoreLock = useRef(new Set<string>());
  const testLock = useRef(new Set<string>());
  // Restore tests started here, so their result toasts when a poll (or the preview) lands it.
  const watched = useRef(new Set<string>());
  const [editing, setEditing] = useState<BackupSchedule | null>(null);
  const d = result.data;
  const preview = result.source === "preview";
  const can = useCan();

  const notices = useMemo(() => (ov.data ? deriveNotices(ov.data, now) : null), [ov.data, now]);
  const liveRuns = useMemo(() => d?.runs.filter((r) => !isOrphan(r)) ?? [], [d]);
  // The history is 30 days; the older rows the API adds feed the schedules and the totals only.
  const recentRuns = useMemo(() => liveRuns.filter((r) => inHistory(r, now)), [liveRuns, now]);
  const orphans = useMemo(() => d?.runs.filter(isOrphan) ?? [], [d]);
  const backingUp = d?.runs.some((r) => r.status === "running") ?? false;
  const testRunning = d?.runs.some((r) => r.restoreTest.status === "running") ?? false;

  // Poll faster while a backup or a restore test runs, so its row settles soon after it finishes.
  // Adjusted while rendering, as soon as the runs say so.
  if (fast !== (backingUp || testRunning)) setFast(backingUp || testRunning);

  const patchRuns = (fn: (r: BackupRun) => BackupRun) =>
    setResult((prev) => (prev.data ? { ...prev, data: { ...prev.data, runs: prev.data.runs.map(fn) } } : prev));

  // The design preview has no worker: a started backup finishes on its own after a few seconds,
  // sized like that database's last good dump.
  useEffect(() => {
    if (result.source !== "preview" || !backingUp) return;
    const t = setTimeout(() => {
      setResult((prev) => {
        if (!prev.data) return prev;
        const at = Date.now();
        const runs = prev.data.runs.map((r) => {
          if (r.status !== "running") return r;
          const ref = prev.data!.runs.find((x) => x.resourceId === r.resourceId && x.status === "ready");
          const size = ref?.sizeBytes ?? 64 * 1024 ** 2;
          return { ...r, status: "ready" as const, sizeBytes: size, finishedAt: new Date(Math.max(at, Date.parse(r.createdAt) + 4000)).toISOString() };
        });
        return { ...prev, data: { ...prev.data, runs } };
      });
    }, 4500);
    return () => clearTimeout(t);
  }, [result.source, backingUp, setResult]);

  // The preview's restore tests pass after a few seconds with the counts of that database's last passed test.
  useEffect(() => {
    if (result.source !== "preview" || !testRunning) return;
    const t = setTimeout(() => {
      setResult((prev) => {
        if (!prev.data) return prev;
        const runs = prev.data.runs.map((r) => {
          if (r.restoreTest.status !== "running") return r;
          const ref = prev.data!.runs.find((x) => x.resourceId === r.resourceId && x.restoreTest.status === "passed");
          return {
            ...r,
            restoreTest: { status: "passed" as const, testedAt: new Date().toISOString(), tables: ref?.restoreTest.tables ?? 12, rows: ref?.restoreTest.rows ?? 48_200, error: null },
          };
        });
        return { ...prev, data: { ...prev.data, runs } };
      });
    }, 5000);
    return () => clearTimeout(t);
  }, [result.source, testRunning, setResult]);

  useEffect(() => {
    if (!d) return;
    for (const r of d.runs) {
      if (!watched.current.has(r.id) || r.restoreTest.status === "running") continue;
      watched.current.delete(r.id);
      const what = `${dbLabel(r.database)}, from ${utcAt(r.createdAt)}`;
      if (r.restoreTest.status === "passed") toast.success("Restore test passed", { description: describe([what, testLine(r)], { preview }) });
      else toast.error("Restore test failed", { description: describe([what, r.restoreTest.error ?? "The restore did not match the backup"], { preview }) });
    }
  }, [d, preview, utcAt]);

  // "Confirm it is you" comes first, alone, so it never stacks on the schedule dialog.
  const edit = async (s: BackupSchedule) => {
    if (!preview && !(await ensureStepUp({ what: "Changing a backup schedule" }))) return;
    setEditing(s);
  };

  const saved = (next: BackupSchedule) => {
    setEditing(null);
    setResult((prev) => (prev.data ? { ...prev, data: { ...prev.data, schedules: prev.data.schedules.map((x) => (x.id === next.id ? next : x)) } } : prev));
    toast.success("Backup schedule saved", {
      description: describe([dbLabel(next.database), TIERS.map((k) => `${TIER_LABEL[k]}: ${next.tiers[k].enabled ? tierWords(next.tiers[k]).toLowerCase() : "off"}`).join(". ")], { preview }),
    });
  };

  const showHistory = () => document.getElementById("sb-hist")?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });

  const launch = async (pick: string) => {
    if (!d || launchLock.current) return;
    launchLock.current = true;
    setStarting(false);
    setLaunching(true);
    const one = d.schedules.find((s) => s.resourceId === pick);
    const asked = pick === "all" ? d.schedules.filter((s) => s.enabled) : [];
    const started = send<{ runs: BackupRun[] }>("/api/backups/run", "POST", pick === "all" ? {} : { resourceId: pick }).then((r) => {
      // Nothing started is a failure, whatever the status said.
      if (!r.runs.length) throw new Error("No backup was started");
      return r;
    });
    await track(started, {
      preview,
      loading: "Starting backup",
      description: one ? dbLabel(one.database) : "Every enabled database",
      success: (r) => {
        setResult((prev) => (prev.data ? { ...prev, data: { ...prev.data, runs: [...r.runs, ...prev.data.runs] } } : prev));
        const missed = notStarted(asked, r.runs);
        return {
          title: r.runs.length === 1 ? "Backup started" : `${r.runs.length.toLocaleString("en-US")} backups started`,
          description: [
            firstNames(r.runs.map((x) => dbLabel(x.database))),
            ...(missed.length ? [`Not started: ${firstNames(missed.map((s) => dbLabel(s.database)))}`] : []),
            "Each shows in the history as it runs",
          ],
          action: { label: "View", onClick: showHistory },
        };
      },
      error: "Could not start the backup",
    });
    launchLock.current = false;
    setLaunching(false);
  };

  // No other run of the same database can start a second restore meanwhile.
  const restore = async (run: BackupRun, req: RestoreRequest) => {
    setRestoring(null);
    if (restoreLock.current.has(run.resourceId)) return;
    restoreLock.current.add(run.resourceId);
    setRestoringDbs((m) => new Map(m).set(run.resourceId, run.id));
    const name = dbLabel(run.database);
    const stamp = utcAt(run.createdAt);
    await track(send<RestoreOutcome | RestoreAccepted>(`/api/backups/${encodeURIComponent(run.id)}/restore`, "POST", req).then((first) => followRestore(first, readRestore(run.id))), {
      preview,
      loading: req.mode === "new" ? "Restoring into a new database" : "Restoring database",
      description: req.mode === "new" ? `${run.database.projectSlug} / ${req.name}, from ${stamp}` : `${name}, from ${stamp}. Keep this page open`,
      success: (out) => {
        const target = dbLabel(out.database);
        return req.mode === "new"
          ? {
              title: "Database restored",
              description: `${target} created from the backup of ${name}, ${stamp}`,
              // The preview's new database is not a real app, so there is nowhere to go.
              action: preview ? undefined : { label: "View", onClick: () => router.push(`/apps/${encodeURIComponent(out.database.resourceId)}`) },
            }
          : { title: "Database restored", description: `${target} now matches the backup from ${stamp}` };
      },
      error: "Could not restore the backup",
    });
    restoreLock.current.delete(run.resourceId);
    setRestoringDbs((m) => {
      const next = new Map(m);
      next.delete(run.resourceId);
      return next;
    });
  };

  const test = async (run: BackupRun) => {
    if (testLock.current.has(run.id)) return;
    testLock.current.add(run.id);
    setTesting((s) => new Set(s).add(run.id));
    const what = `${dbLabel(run.database)}, from ${utcAt(run.createdAt)}`;
    try {
      const next = await send<BackupRun>(`/api/backups/${encodeURIComponent(run.id)}/test`, "POST", {});
      // Watched either way: a result that is already in toasts on this render, a running one when it lands.
      watched.current.add(run.id);
      patchRuns((r) => (r.id === run.id ? { ...r, restoreTest: next.restoreTest } : r));
      if (next.restoreTest.status === "running") {
        toast.info("Restore test started", { description: describe([what, "It restores into a throwaway container"], { preview }) });
      }
    } catch (e) {
      toast.error("Could not start the restore test", { description: describe([what, errText(e)], { preview }) });
    } finally {
      testLock.current.delete(run.id);
      setTesting((s) => {
        const next = new Set(s);
        next.delete(run.id);
        return next;
      });
    }
  };

  // ConfirmDialog stays open while this runs and closes when it resolves; a failure keeps it open.
  const removeOrphans = async (resourceId: string) => {
    const rows = orphans.filter((r) => r.resourceId === resourceId);
    const name = rows[0] ? dbLabel(rows[0].database) : "Deleted database";
    setDeleting((s) => new Set(s).add(resourceId));
    try {
      const out = await send<OrphanDeleteResult>(`/api/backups/orphans/${encodeURIComponent(resourceId)}`, "DELETE", {});
      setResult((prev) => (prev.data ? { ...prev, data: { ...prev.data, runs: prev.data.runs.filter((r) => r.resourceId !== resourceId) } } : prev));
      toast.success(`Deleted ${plural(out.deleted, "backup")}`, { description: describe([name, `${bytes(out.freedBytes)} freed`], { preview }) });
      setRemoving(null);
    } catch (e) {
      // A closed "Confirm it is you" is no failure: no toast, and the question stays open.
      if (!wasCancelled(e)) toast.error("Could not delete the backups", { description: describe([name, errText(e)], { preview }) });
      throw e;
    } finally {
      setDeleting((s) => {
        const next = new Set(s);
        next.delete(resourceId);
        return next;
      });
    }
  };

  const actions: RunActions = { onRestore: setRestoring, onTest: (r) => void test(r), restoring: restoringDbs, testing };

  const hasDbs = (d?.schedules.length ?? 0) > 0;
  const lead = d
    ? hasDbs
      ? `${plural(d.schedules.length, "database")}, ${d.schedules.filter((s) => s.enabled).length} on a schedule, ${plural(recentRuns.length, "run")} in 30 days.`
      : "No databases to back up yet."
    : "Encrypted database dumps on a schedule, kept off this server.";

  return (
    <>
      <Topbar trail={["Backups"]} notices={notices} now={now} />
      <main className="page" id="main" tabIndex={-1}>
        <SectionHead
          level={1}
          title="Backups"
          lead={lead}
          actions={
            refreshing || can.manage ? (
              <>
                {refreshing ? <Updating /> : null}
                {can.manage ? (
                  <PendingButton className="btn btn-primary" onClick={() => setStarting(true)} pending={launching} disabled={!hasDbs} icon="archive">
                    Back up now
                  </PendingButton>
                ) : null}
              </>
            ) : null
          }
        />
        <Rule />

        {!d ? (
          <>
            <NoSource error={result.error} polling={result.source === "api"} />
            <Spacer end />
          </>
        ) : !hasDbs && orphans.length === 0 ? (
          <>
            <div className="card">
              <Empty
                icon="box"
                title="No databases yet"
                body={
                  can.manage
                    ? "Add a Postgres service to a project. It gets a daily backup schedule here, and every run is listed with a restore."
                    : "Postgres services get a daily backup schedule here once an admin adds them to a project."
                }
              />
            </div>
            <Spacer end />
          </>
        ) : (
          <>
            {hasDbs ? (
              <>
                {/* The summary waits for something to sum up: a run, or a schedule that will make one. */}
                {liveRuns.length > 0 || d.schedules.some((s) => s.enabled) ? (
                  <>
                    <Kpis runs={liveRuns} schedules={d.schedules} now={now} />
                    <Spacer />
                  </>
                ) : null}
                <Schedules schedules={d.schedules} runs={liveRuns} now={now} hasStorage={(d.config?.destinations.length ?? 0) > 0 || d.schedules.some((s) => s.tiers.offsite.available)} onEdit={(s) => void edit(s)} />
                <Spacer />
              </>
            ) : null}
            {d.config ? (
              <>
                <StorageCard config={d.config} schedules={d.schedules} now={now} />
                <Spacer />
              </>
            ) : null}
            {hasDbs ? <History runs={recentRuns} schedules={d.schedules} now={now} actions={actions} /> : null}
            {orphans.length ? (
              <>
                {hasDbs ? <Spacer /> : null}
                <Orphans runs={orphans} now={now} actions={actions} onDelete={setRemoving} deleting={deleting} />
              </>
            ) : null}
            <Spacer end />
            {restoring ? <RestoreDialog key={restoring.id} run={restoring} onClose={() => setRestoring(null)} onConfirm={(r, req) => void restore(r, req)} /> : null}
            {starting ? <RunDialog onClose={() => setStarting(false)} schedules={d.schedules} onConfirm={(p) => void launch(p)} /> : null}
            {editing ? <ScheduleDialog key={editing.id} schedule={editing} destinations={d.config?.destinations ?? []} onClose={() => setEditing(null)} onSaved={saved} /> : null}
            {removing ? (
              <DeleteOrphansDialog
                key={removing[0]!.resourceId}
                runs={removing}
                onClose={() => setRemoving(null)}
                onConfirm={removeOrphans}
                // The deleted group took its key with it: the card's title, else the history's.
                returnFocus={() => document.getElementById("bk-orphans-title") ?? document.getElementById("sb-hist-title")}
              />
            ) : null}
          </>
        )}
      </main>
    </>
  );
}
