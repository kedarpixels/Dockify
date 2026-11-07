"use client";

import { useCallback, useEffect, useState } from "react";
import { cronText } from "@/components/server-backups/util";
import { elevate, wasCancelled } from "@/components/step-up/step-up";
import { RowMenu } from "@/components/project-extras/row-menu";
import { StatusChip, type ChipTone } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { Field, TextInput } from "@/components/ui/field";
import { PendingButton, PendingLabel } from "@/components/ui/pending";
import { Segmented } from "@/components/ui/segmented";
import { Skel } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { When } from "@/components/ui/when";
import { Icon } from "@/components/icon";
import { callJson } from "@/lib/client-api";
import { useUtcAt } from "@/lib/time-prefs";
import { useCan } from "@/lib/viewer";
import { hasOutput, isActiveRun, jobErrors, RUN_LABEL, type AppJobs, type JobDraft, type JobErrors, type JobInput, type JobLimits, type JobRunDetail, type JobRunRow, type JobRunStatus, type ScheduledJobRow } from "./jobs-shared";
import { TabCard, TabFailed } from "./states";

/* Jobs: one row per scheduled job, the runs of the one picked below it, and a run's output in a
   dialog. Every run is a short-lived container from the app's current image. A Viewer sees all of it
   and changes none of it; the api decides, and the keys simply are not offered. */

const TONE: Record<JobRunStatus, ChipTone> = {
  queued: "pending",
  running: "live",
  succeeded: "ok",
  failed: "bad",
  timed_out: "bad",
  cancelled: "idle",
  skipped: "idle",
  missed: "warn",
};

const LIST_POLL_MS = 15_000;
const ACTIVE_POLL_MS = 3_000;

const base = (app: string) => `/api/apps/${encodeURIComponent(app)}/jobs`;

function RunChip({ status }: { status: JobRunStatus }) {
  return <StatusChip tone={TONE[status]}>{RUN_LABEL[status]}</StatusChip>;
}

const blank = (): JobDraft => ({
  name: "",
  schedule: "0 3 * * *",
  // The browser's zone is what someone setting 3am usually means by it.
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  command: "",
  timeout: "600",
  overlap: "skip",
  enabled: true,
});
const toDraft = (j: ScheduledJobRow): JobDraft => ({ name: j.name, schedule: j.schedule, timezone: j.timezone, command: j.command, timeout: String(j.timeoutSeconds), overlap: j.overlap, enabled: j.enabled });
const toInput = (d: JobDraft): JobInput => ({ name: d.name.trim(), schedule: d.schedule.trim(), timezone: d.timezone.trim(), command: d.command.trim(), timeoutSeconds: Number(d.timeout), overlap: d.overlap, enabled: d.enabled });

const durationOf = (r: JobRunRow): string => {
  if (!r.startedAt || !r.finishedAt) return "";
  const s = Math.max(0, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/* -------------- Form -------------- */

function JobDialog({ app, job, limits, onClose, onSaved }: { app: string; job: ScheduledJobRow | null; limits: JobLimits; onClose: () => void; onSaved: (j: ScheduledJobRow) => void }) {
  const [draft, setDraft] = useState<JobDraft>(() => (job ? toDraft(job) : blank()));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<JobErrors & { form?: string }>({});
  const local = jobErrors(draft, limits);
  const err = (k: keyof JobErrors) => (tried ? local[k] : undefined) ?? refused[k];
  const set = <K extends keyof JobDraft>(k: K, v: JobDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setRefused({});
  };

  const save = async () => {
    setTried(true);
    if (Object.keys(local).length || busy) return;
    setBusy(true);
    const r = await elevate(
      () => callJson<ScheduledJobRow>(job ? `${base(app)}/${encodeURIComponent(job.id)}` : base(app), { method: job ? "PATCH" : "POST", body: toInput(draft) }),
      { what: job ? "Changing a scheduled job" : "Adding a scheduled job" },
    );
    setBusy(false);
    if (r.ok && r.data) return onSaved(r.data);
    if (r.ok || r.aborted) return;
    const field = typeof r.body?.field === "string" ? r.body.field : null;
    setRefused(field === "name" || field === "schedule" || field === "timezone" || field === "command" ? { [field]: r.error } : { form: r.error });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      icon="clock"
      title={job ? `Edit ${job.name}` : "New scheduled job"}
      sub="Runs in its own container from this app’s current image"
      onSubmit={() => void save()}
      footer={
        <>
          {refused.form ? <span className="dlg-note tone-bad">{refused.form}</span> : null}
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            <PendingLabel pending={busy}>{job ? "Save" : "Add job"}</PendingLabel>
          </button>
        </>
      }
    >
      <div className="na-stack">
        <div className="na-pair">
          <Field label="Name" error={err("name")}>
            {(ids) => <TextInput ids={ids} data-autofocus className="mono" autoComplete="off" spellCheck={false} placeholder="nightly-report" value={draft.name} onChange={(e) => set("name", e.target.value.toLowerCase())} />}
          </Field>
          <Field label="Time zone" error={err("timezone")}>
            {(ids) => <TextInput ids={ids} className="mono" autoComplete="off" spellCheck={false} placeholder="Europe/Berlin" value={draft.timezone} onChange={(e) => set("timezone", e.target.value)} />}
          </Field>
        </div>
        <Field label="Schedule" error={err("schedule")} hint={local.schedule ? `At least ${limits.minIntervalMinutes} minutes apart.` : `${cronText(draft.schedule)}. Cron, at least ${limits.minIntervalMinutes} minutes apart.`}>
          {(ids) => <TextInput ids={ids} className="mono" autoComplete="off" spellCheck={false} placeholder="0 3 * * *" value={draft.schedule} onChange={(e) => set("schedule", e.target.value)} />}
        </Field>
        <Field label="Command" error={err("command")} hint="Runs like a start command, with the app’s variables. Quotes, variables or && need a shell in the image.">
          {(ids) => <TextInput ids={ids} className="mono" autoComplete="off" spellCheck={false} placeholder="node scripts/report.js" value={draft.command} onChange={(e) => set("command", e.target.value)} />}
        </Field>
        <div className="na-pair">
          <Field label="Timeout, seconds" error={err("timeoutSeconds")}>
            {(ids) => <TextInput ids={ids} className="num" inputMode="numeric" autoComplete="off" value={draft.timeout} onChange={(e) => set("timeout", e.target.value.replace(/\D/g, "").slice(0, 5))} />}
          </Field>
          <Field label="If the last run is still going" hint={draft.overlap === "skip" ? "This run is skipped." : "The last run is stopped."}>
            {() => <Segmented label="If the last run is still going" value={draft.overlap} onChange={(v) => set("overlap", v)} options={[{ value: "skip", label: "Skip" }, { value: "replace", label: "Replace" }]} />}
          </Field>
        </div>
        <div className="jb-enabled">
          <span>
            <span className="jb-enabled-title">Runs on its schedule</span>
            <span className="jb-enabled-sub">Off keeps the job and Run now, and never fires on its own.</span>
          </span>
          <Switch checked={draft.enabled} onChange={(v) => set("enabled", v)} label="Runs on its schedule" />
        </div>
      </div>
    </Dialog>
  );
}

/* -------------- A run's output -------------- */

function RunDialog({ app, job, run, onClose }: { app: string; job: ScheduledJobRow; run: JobRunRow; onClose: () => void }) {
  const [state, setState] = useState<{ run: JobRunDetail } | { error: string } | null>(null);
  const url = `${base(app)}/${encodeURIComponent(job.id)}/runs/${encodeURIComponent(run.id)}`;
  const active = state && "run" in state ? isActiveRun(state.run.status) : isActiveRun(run.status);
  useEffect(() => {
    const ctl = new AbortController();
    const read = () =>
      void callJson<JobRunDetail>(url, { signal: ctl.signal }).then((r) => {
        if (r.ok && r.data) setState({ run: r.data });
        else if (!r.ok && !r.aborted) setState({ error: r.error });
      });
    read();
    const t = active ? setInterval(read, ACTIVE_POLL_MS) : null;
    return () => {
      ctl.abort();
      if (t) clearInterval(t);
    };
  }, [url, active]);
  const r = state && "run" in state ? state.run : null;
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      icon="terminal"
      title={`Run of ${job.name}`}
      sub={<When iso={run.createdAt} utc />}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="jb-run-head">
        <RunChip status={(r ?? run).status} />
        {(r ?? run).exitCode !== null ? <span className="num">Exit code {(r ?? run).exitCode}</span> : null}
        {durationOf(r ?? run) ? <span className="num">{durationOf(r ?? run)}</span> : null}
      </div>
      {(r ?? run).reason ? <p className="jb-run-reason">{(r ?? run).reason}</p> : null}
      {state && "error" in state ? (
        <p className="jb-run-reason tone-bad">{state.error}</p>
      ) : r ? (
        r.log ? (
          <pre className="jb-log" tabIndex={0}>
            {r.log}
          </pre>
        ) : (
          <p className="jb-none">{isActiveRun(r.status) ? "No output yet." : "It printed nothing."}</p>
        )
      ) : (
        <Skel w="100%" h={120} />
      )}
    </Dialog>
  );
}

/* -------------- History -------------- */

function Runs({ app, job, refreshKey }: { app: string; job: ScheduledJobRow; refreshKey: number }) {
  const [state, setState] = useState<{ for: string; runs: JobRunRow[] } | { for: string; error: string } | null>(null);
  const [open, setOpen] = useState<JobRunRow | null>(null);
  const url = `${base(app)}/${encodeURIComponent(job.id)}/runs`;
  const current = state?.for === job.id ? state : null;
  const active = !!current && "runs" in current && current.runs.some((r) => isActiveRun(r.status));
  useEffect(() => {
    const ctl = new AbortController();
    const read = () =>
      void callJson<{ runs: JobRunRow[] }>(url, { signal: ctl.signal }).then((r) => {
        if (r.ok && r.data) setState({ for: job.id, runs: r.data.runs });
        else if (!r.ok && !r.aborted) setState({ for: job.id, error: r.error });
      });
    read();
    const t = setInterval(read, active ? ACTIVE_POLL_MS : LIST_POLL_MS);
    return () => {
      ctl.abort();
      clearInterval(t);
    };
  }, [url, job.id, active, refreshKey]);

  return (
    <TabCard id="jb-runs-title" icon="history" title={`Runs of ${job.name}`} sub="Newest first, with exit code and output">
      {!current ? (
        <div className="jb-rows" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="soft-row jb-run">
              <Skel w={72} />
              <Skel w={96} />
              <Skel w={140} />
            </div>
          ))}
        </div>
      ) : "error" in current ? (
        <TabFailed what="The runs" error={current.error} onRetry={() => setState(null)} />
      ) : !current.runs.length ? (
        <Empty icon="history" title="No runs yet" body={job.nextRunAt ? "The first one comes at its next time, or use Run now." : "Use Run now, or turn its schedule on."} />
      ) : (
        <div className="jb-rows">
          {current.runs.map((r) => {
            const reads = hasOutput(r);
            const Row = reads ? "button" : "div";
            return (
              <Row key={r.id} {...(reads ? { type: "button" as const, onClick: () => setOpen(r), "data-hover": "true" } : {})} className="soft-row jb-run">
                <span className="jb-run-status">
                  <RunChip status={r.status} />
                </span>
                <When iso={r.createdAt} utc className="jb-run-time num" />
                <span className="jb-run-why ellipsis" title={r.reason ?? undefined}>
                  {r.reason ?? (r.trigger === "manual" ? "Run now" : "On schedule")}
                </span>
                <span className="jb-run-exit num">{r.exitCode !== null ? `Exit ${r.exitCode}` : ""}</span>
                <span className="jb-run-dur num">{durationOf(r)}</span>
                <span className="jb-run-more">{reads ? <Icon name="chevronRight" size={14} /> : null}</span>
              </Row>
            );
          })}
        </div>
      )}
      {open ? <RunDialog app={app} job={job} run={open} onClose={() => setOpen(null)} /> : null}
    </TabCard>
  );
}

/* -------------- The tab -------------- */

export function JobsTab({ appId }: { appId: string }) {
  const { manage } = useCan();
  const utcAt = useUtcAt();
  const [state, setState] = useState<{ data: AppJobs } | { error: string } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [editing, setEditing] = useState<ScheduledJobRow | "new" | null>(null);
  const [removing, setRemoving] = useState<ScheduledJobRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const r = await callJson<AppJobs>(base(appId), { signal });
      if (r.ok && r.data) setState({ data: r.data });
      else if (!r.ok && !r.aborted) setState((s) => (s && "data" in s ? s : { error: r.error }));
    },
    [appId],
  );
  useEffect(() => {
    const ctl = new AbortController();
    const first = setTimeout(() => void load(ctl.signal), 0);
    const t = setInterval(() => void load(ctl.signal), LIST_POLL_MS);
    return () => {
      ctl.abort();
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const data = state && "data" in state ? state.data : null;
  const jobs = data?.jobs ?? [];
  const current = jobs.find((j) => j.id === picked) ?? jobs[0] ?? null;
  const full = !!data && jobs.length >= data.limits.maxJobs;

  const runNow = async (j: ScheduledJobRow) => {
    setBusy(j.id);
    const r = await elevate(() => callJson<{ runId: string }>(`${base(appId)}/${encodeURIComponent(j.id)}/run`, { body: {} }), { what: "Running a job" });
    setBusy(null);
    if (r.ok) {
      toast.success(`${j.name} queued`);
      setPicked(j.id);
      setRefreshKey((k) => k + 1);
      void load();
    } else if (!r.aborted && !wasCancelled(r)) toast.error("Could not run the job", { description: r.error });
  };
  const toggle = async (j: ScheduledJobRow, enabled: boolean) => {
    setBusy(j.id);
    const r = await elevate(() => callJson<ScheduledJobRow>(`${base(appId)}/${encodeURIComponent(j.id)}`, { method: "PATCH", body: { enabled } }), { what: "Changing a scheduled job" });
    setBusy(null);
    if (r.ok) void load();
    else if (!r.aborted && !wasCancelled(r)) toast.error("Could not change the job", { description: r.error });
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(removing.id);
    const r = await elevate(() => callJson<null>(`${base(appId)}/${encodeURIComponent(removing.id)}`, { method: "DELETE" }), { what: "Removing a scheduled job" });
    setBusy(null);
    if (r.ok) {
      toast.success(`${removing.name} removed`);
      setRemoving(null);
      void load();
    } else if (!r.aborted && !wasCancelled(r)) toast.error("Could not remove the job", { description: r.error });
  };

  const add = manage ? (
    <span {...(full ? { "data-tip": `An app can have ${data?.limits.maxJobs} jobs`, "data-tip-align": "end" } : {})}>
      <button type="button" className="btn btn-sm" disabled={full || !data} onClick={() => setEditing("new")}>
        <Icon name="plus" size={14} />
        New job
      </button>
    </span>
  ) : null;

  return (
    <div className="jb-stack">
      <TabCard id="jb-title" icon="clock" title="Scheduled jobs" sub={data ? `Keeps the last ${data.limits.keepRuns} runs of each, for ${data.limits.keepDays} days` : "Commands on a schedule, from this app’s image"} actions={add}>
        {state === null ? (
          <div className="jb-rows" aria-busy="true">
            {[0, 1].map((i) => (
              <div key={i} className="soft-row jb-row">
                <Skel w={140} />
                <Skel w={160} />
                <Skel w={72} />
              </div>
            ))}
          </div>
        ) : "error" in state ? (
          <TabFailed what="The jobs" error={state.error} onRetry={() => void load()} />
        ) : !jobs.length ? (
          <Empty icon="clock" title="No scheduled jobs" body={manage ? "Run a command on a schedule, in its own container, with this app’s variables." : "An admin can add one."} />
        ) : (
          <div className="jb-rows">
            {jobs.map((j) => (
              <div key={j.id} className="soft-row jb-row" data-hover="true" aria-current={current?.id === j.id ? "true" : undefined}>
                <button type="button" className="jb-row-main" onClick={() => setPicked(j.id)} aria-label={`Show the runs of ${j.name}`}>
                  <span className="jb-name ellipsis mono" title={j.name}>
                    {j.name}
                  </span>
                  {/* An admin's to read: a command can hold a token, so the API sends a Viewer none. */}
                  <span className="jb-cmd ellipsis mono" title={j.command || undefined}>
                    {j.command || "Hidden"}
                  </span>
                </button>
                <span className="jb-sched">
                  <span className="ellipsis" title={`${j.schedule}, ${j.timezone}`}>
                    {cronText(j.schedule)}
                  </span>
                  <span className="jb-sub ellipsis">{j.enabled ? (j.nextRunAt ? `Next ${utcAt(j.nextRunAt)}` : "Waiting") : "Off"}</span>
                </span>
                <span className="jb-last">{j.lastRun ? <RunChip status={j.lastRun.status} /> : <span className="jb-sub">No runs</span>}</span>
                <span className="jb-acts">
                  {manage ? (
                    <>
                      <PendingButton className="btn btn-xs" pending={busy === j.id} disabled={!!busy} onClick={() => void runNow(j)}>
                        Run now
                      </PendingButton>
                      <RowMenu
                        label={`More for ${j.name}`}
                        items={[
                          { label: "Edit", onSelect: () => setEditing(j) },
                          { label: j.enabled ? "Turn off" : "Turn on", onSelect: () => void toggle(j, !j.enabled) },
                          { label: "Remove", bad: true, onSelect: () => setRemoving(j) },
                        ]}
                      />
                    </>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </TabCard>
      {current ? <Runs app={appId} job={current} refreshKey={refreshKey} /> : null}
      {editing && data ? (
        <JobDialog
          app={appId}
          job={editing === "new" ? null : editing}
          limits={data.limits}
          onClose={() => setEditing(null)}
          onSaved={(j) => {
            setEditing(null);
            setPicked(j.id);
            toast.success(`${j.name} saved`);
            void load();
          }}
        />
      ) : null}
      <Dialog
        open={!!removing}
        size="sm"
        icon="trash"
        tone="bad"
        busy={busy === removing?.id}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name ?? ""}`}
        sub="Its schedule and its run history go too"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setRemoving(null)} disabled={busy === removing?.id}>
              Cancel
            </button>
            <PendingButton className="btn btn-danger" pending={busy === removing?.id} onClick={() => void remove()}>
              Remove
            </PendingButton>
          </>
        }
      />
    </div>
  );
}
