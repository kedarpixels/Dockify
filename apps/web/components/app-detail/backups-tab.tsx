"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { RestoreDialog, testLine } from "@/components/server-backups/backup-dialogs";
import { History } from "@/components/server-backups/backup-runs";
import { STORAGE_HREF } from "@/components/server-backups/backup-schedules";
import { track } from "@/components/server-backups/live";
import { followRestore } from "@/components/server-backups/restore-follow";
import { readRestore, send } from "@/components/server-backups/use-poll";
import { cronText, dbLabel, offServer, placeName } from "@/components/server-backups/util";
import { Chip } from "@/components/ui/chip";
import { CopyButton } from "@/components/ui/copy-button";
import { Empty } from "@/components/ui/empty";
import { PendingButton } from "@/components/ui/pending";
import { Skel } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { When } from "@/components/ui/when";
import { describe, errText } from "@/lib/feedback";
import { plural } from "@/lib/format";
import { useUtcAt } from "@/lib/time-prefs";
import type { AppBackups, AppDetail } from "@/lib/pages/project-detail";
import type { BackupRun, RestoreAccepted, RestoreOutcome, RestoreRequest } from "@/lib/pages/server-backups";
import { useCan } from "@/lib/viewer";
import { TabCard, TabFailed } from "./states";
import { useAppTab } from "./use-tab";

/* Backups: this database's schedule, destination, encryption and restore tests, then its history.
   The rows, the restore dialog and the writes are the Backups page's own, so both pages always
   behave the same; only the summary on top is drawn here. */

const restorable = (r: BackupRun) => r.status === "ready" && !r.expired;

function Summary({ b, now }: { b: AppBackups; now: number }) {
  const utcAt = useUtcAt();
  const s = b.schedule;
  const newestTested = b.runs.find((r) => r.restoreTest.status === "passed" || r.restoreTest.status === "failed");
  const off = s ? offServer(s) : false;
  const sealed = s?.encryption.enabled ?? b.config?.encryption.enabled ?? false;
  const fingerprint = s?.encryption.fingerprint ?? b.config?.encryption.fingerprint ?? null;
  return (
    <dl className="at-facts">
      <div className="kv at-fact">
        <dt className="kv-label">Schedule</dt>
        <dd className="kv-value">
          {s ? (
            <span className="two">
              <span className="two-main">
                {cronText(s.cron)}
                {s.enabled ? null : (
                  <>
                    {" "}
                    <Chip size="xs" tone="warn">
                      Paused
                    </Chip>
                  </>
                )}
              </span>
              <span className="two-sub num">
                {s.enabled && s.nextRunAt ? `Next ${utcAt(s.nextRunAt)}, keeps ${plural(s.retentionDays, "day")}` : `Keeps ${plural(s.retentionDays, "day")}`}
              </span>
            </span>
          ) : (
            <span className="two">
              <span className="two-main none">No schedule</span>
              <span className="two-sub">
                Set one on <Link href="/backups">Backups</Link>
              </span>
            </span>
          )}
        </dd>
      </div>
      <div className="kv at-fact">
        <dt className="kv-label">Destination</dt>
        <dd className="kv-value">
          <span className="two">
            <span className="two-main">
              {s ? placeName(s.storage) : "Not set"}
              {s && !off ? (
                <>
                  {" "}
                  <Chip size="xs" tone="warn">
                    Not off-server
                  </Chip>
                </>
              ) : null}
            </span>
            <span className="two-sub num">
              {s?.storage ? `Bucket ${s.storage.bucket}` : (
                <>
                  Backups stay on this disk only. <Link href={STORAGE_HREF}>Add backup storage</Link>
                </>
              )}
            </span>
          </span>
        </dd>
      </div>
      <div className="kv at-fact">
        <dt className="kv-label">Encryption</dt>
        <dd className="kv-value">
          <span className="two">
            <span className="two-main">
              {sealed ? "Encrypted before upload" : (
                <Chip size="xs" tone="warn">
                  Not encrypted
                </Chip>
              )}
            </span>
            {fingerprint ? (
              <span className="two-sub num at-inline">
                Key {fingerprint}
                <CopyButton value={fingerprint} what="key fingerprint" />
              </span>
            ) : (
              <span className="two-sub">No key on this server</span>
            )}
          </span>
        </dd>
      </div>
      <div className="kv at-fact">
        <dt className="kv-label">Restore test</dt>
        <dd className="kv-value">
          {newestTested ? (
            <span className="two">
              <span className={newestTested.restoreTest.status === "passed" ? "two-main tone-ok" : "two-main tone-bad"}>{testLine(newestTested)}</span>
              <span className="two-sub num">
                {newestTested.restoreTest.testedAt ? <When iso={newestTested.restoreTest.testedAt} now={now} utc prefix="Tested" /> : null}
                {b.config?.restoreTests.nextRunAt ? `${newestTested.restoreTest.testedAt ? ", next" : "Next"} ${utcAt(b.config.restoreTests.nextRunAt)}` : null}
              </span>
            </span>
          ) : (
            <span className="two">
              <span className="two-main none">Not tested yet</span>
              <span className="two-sub">The scheduled test restores the newest backup into a temporary container</span>
            </span>
          )}
        </dd>
      </div>
    </dl>
  );
}

function SummarySkeleton() {
  return (
    <div className="at-facts" role="status" aria-busy="true" aria-label="Loading backups">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="kv at-fact">
          <Skel w={72} />
          <Skel w="70%" h={10} />
          <Skel w="50%" />
        </div>
      ))}
    </div>
  );
}

export function BackupsTab({ app, now }: { app: AppDetail; now: number }) {
  const utcAt = useUtcAt();
  const router = useRouter();
  const can = useCan();
  const q = useAppTab<AppBackups>(app.id, "backups");
  const { reload, patch } = q;
  const b = q.data;
  const preview = q.source === "preview";
  const [starting, setStarting] = useState(false);
  const [restoreRun, setRestoreRun] = useState<BackupRun | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [testing, setTesting] = useState<Set<string>>(() => new Set());
  const lock = useRef(false);
  const running = b?.runs.some((r) => r.status === "running") ?? false;
  const testRunning = b?.runs.some((r) => r.restoreTest.status === "running") ?? false;
  const newest = b?.runs.find(restorable) ?? null;
  const what = dbLabel({ projectSlug: app.projectSlug, name: app.name, environment: app.environment });

  // A live run or test is read again 5s after every answer until it settles; the preview has no
  // worker, so it settles here.
  useEffect(() => {
    if ((!running && !testRunning) || q.loading) return;
    const t = setTimeout(() => {
      if (!preview) return reload();
      patch((d) => {
        const good = d.runs.find((r) => r.status === "ready" && r.sizeBytes);
        const passed = d.runs.find((r) => r.restoreTest.status === "passed");
        return {
          ...d,
          runs: d.runs.map((r) => ({
            ...r,
            ...(r.status === "running" ? { status: "ready" as const, sizeBytes: good?.sizeBytes ?? 64 * 1024 ** 2, finishedAt: new Date().toISOString() } : null),
            restoreTest:
              r.restoreTest.status === "running"
                ? { status: "passed" as const, testedAt: new Date().toISOString(), tables: passed?.restoreTest.tables ?? 12, rows: passed?.restoreTest.rows ?? 48_200, error: null }
                : r.restoreTest,
          })),
        };
      });
    }, preview ? 4500 : 5000);
    return () => clearTimeout(t);
    // q.loading too: a read that fails leaves `b` as it was, and the timer must still come back.
  }, [b, running, testRunning, q.loading, preview, reload, patch]);

  const backUp = async () => {
    if (lock.current) return;
    lock.current = true;
    setStarting(true);
    await track(send<{ runs: BackupRun[] }>("/api/backups/run", "POST", { resourceId: app.id }), {
      preview,
      loading: "Starting backup",
      description: what,
      success: (r) => {
        q.patch((d) => ({ ...d, runs: [...r.runs, ...d.runs] }));
        return { title: "Backup started", description: [what, "It shows in the history as it runs"] };
      },
      error: "Could not start the backup",
    });
    lock.current = false;
    setStarting(false);
  };

  const restore = async (run: BackupRun, req: RestoreRequest) => {
    setRestoreRun(null);
    setRestoringId(run.id);
    const stamp = utcAt(run.createdAt);
    await track(send<RestoreOutcome | RestoreAccepted>(`/api/backups/${encodeURIComponent(run.id)}/restore`, "POST", req).then((first) => followRestore(first, readRestore(run.id))), {
      preview,
      loading: req.mode === "new" ? "Restoring into a new database" : "Restoring database",
      description: req.mode === "new" ? `${app.projectSlug} / ${req.name}, from ${stamp}` : `${what}, from ${stamp}. Keep this page open`,
      success: (out) => {
        const target = `${out.database.projectSlug} / ${out.database.name}`;
        return req.mode === "new"
          ? {
              title: "Database restored",
              description: `${target} created from the backup of ${stamp}`,
              action: preview ? undefined : { label: "View", onClick: () => router.push(`/apps/${encodeURIComponent(out.database.resourceId)}`) },
            }
          : { title: "Database restored", description: `${target} now matches the backup from ${stamp}` };
      },
      error: "Could not restore the backup",
    });
    setRestoringId(null);
  };

  const test = async (run: BackupRun) => {
    if (testing.has(run.id)) return;
    setTesting((s) => new Set(s).add(run.id));
    const label = `${what}, from ${utcAt(run.createdAt)}`;
    try {
      const next = await send<BackupRun>(`/api/backups/${encodeURIComponent(run.id)}/test`, "POST", {});
      q.patch((d) => ({ ...d, runs: d.runs.map((r) => (r.id === run.id ? { ...r, restoreTest: next.restoreTest } : r)) }));
      toast.info("Restore test started", { description: describe([label, "It restores into a throwaway container"], { preview }) });
    } catch (e) {
      toast.error("Could not start the restore test", { description: describe([label, errText(e)], { preview }) });
    } finally {
      setTesting((s) => {
        const next = new Set(s);
        next.delete(run.id);
        return next;
      });
    }
  };

  // Busy keys keep the focus (PendingButton); a key with nothing to act on yet is disabled. A
  // Viewer gets neither: labelled write keys are not rendered for a Viewer.
  const actions = can.manage ? (
    <>
      <PendingButton className="btn btn-sm" pending={restoringId !== null} disabled={!newest} onClick={() => newest && setRestoreRun(newest)}>
        Restore into new database
      </PendingButton>
      <PendingButton className="btn btn-sm btn-primary" pending={starting || running} disabled={!b} icon="archive" onClick={() => void backUp()}>
        Back up now
      </PendingButton>
    </>
  ) : undefined;

  return (
    <div className="pd-stack">
      <TabCard
        id="at-bk-title"
        icon="archive"
        title="Backups"
        sub={newest ? <When iso={newest.createdAt} now={now} utc prefix="Newest good backup" /> : "Backups of this database"}
        actions={actions}
      >
        {!b && q.loading ? <SummarySkeleton /> : !b ? <TabFailed error={q.error} onRetry={q.reload} what="Backups for this database" /> : <Summary b={b} now={now} />}
      </TabCard>
      {b ? (
        b.runs.length ? (
          <History
            runs={b.runs}
            schedules={b.schedule ? [b.schedule] : []}
            now={now}
            actions={{
              onRestore: setRestoreRun,
              onTest: (r) => void test(r),
              restoring: restoringId ? new Map([[app.id, restoringId]]) : new Map(),
              testing,
            }}
          />
        ) : (
          <div className="card">
            <Empty
              icon="archive"
              title="No backups yet"
              body={
                can.manage
                  ? `Press Back up now for a first backup of ${app.name}, or set a schedule on the Backups page.`
                  : `Backups of ${app.name} show up here once an admin runs one or sets a schedule.`
              }
              action={
                <Link href="/backups" className="btn btn-sm">
                  Open backups
                </Link>
              }
            />
          </div>
        )
      ) : null}
      {restoreRun ? <RestoreDialog run={restoreRun} onClose={() => setRestoreRun(null)} onConfirm={(r, req) => void restore(r, req)} /> : null}
    </div>
  );
}
