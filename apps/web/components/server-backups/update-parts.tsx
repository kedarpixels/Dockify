"use client";

import { useState } from "react";
import { Icon } from "@/components/icon";
import { StatusIcon } from "@/components/overview/status-icon";
import { StatusChip } from "@/components/ui/chip";
import { Block } from "@/components/ui/markdown";
import { When } from "@/components/ui/when";
import { duration } from "@/lib/format";
import { parseMarkdown } from "@/lib/markdown";
import type { UpdateJob, UpdateStepId, UpdateStepRow } from "@/lib/pages/server-backups";
import type { RecentDeployment } from "@/lib/types";
import { v } from "./util";

const HISTORY_SHOWN = 3;

export const STEP: Record<UpdateStepId, string> = {
  preflight: "Preflight checks",
  pull: "Pull and verify the signed images",
  backup: "Back up the control-plane database",
  migrate: "Run migrations",
  swapApi: "Restart the API",
  swapWorker: "Restart the worker",
  swapWeb: "Restart the dashboard",
  health: "Health checks",
  rollback: "Roll back to the previous images",
};

/** In a rollback job the rollback step restores the dump taken before that update. */
const stepLabel = (job: UpdateJob, id: UpdateStepId) => (job.kind === "rollback" && id === "rollback" ? "Restore the database from before the update" : STEP[id]);

const STEP_MARK: Record<UpdateStepRow["status"], RecentDeployment["status"]> = {
  done: "ready",
  running: "building",
  failed: "failed",
  skipped: "cancelled",
  pending: "queued",
};
const STEP_SR: Record<UpdateStepRow["status"], string> = { done: "done", running: "in progress", failed: "failed", skipped: "skipped", pending: "waiting" };

/** "Step 3 of 8, run migrations", or the wait while a deploy or restore finishes. */
export function stepText(job: UpdateJob) {
  if (job.state === "waiting") return "Waiting for a deploy or restore to finish before it starts";
  const i = job.steps.findIndex((s) => s.status === "running");
  const at = i >= 0 ? i : Math.max(0, job.steps.findIndex((s) => s.id === job.phase));
  const step = job.steps[at];
  return `Step ${at + 1} of ${job.steps.length}, ${(step ? stepLabel(job, step.id) : STEP[job.phase]).toLowerCase()}`;
}

export function Steps({ job }: { job: UpdateJob }) {
  return (
    <ol className="srv-up-steps" aria-label={job.kind === "rollback" ? `Roll back to ${v(job.version)}` : `Update to ${v(job.version)}`}>
      {job.steps.map((s) => (
        <li key={s.id} className="srv-up-step" data-state={s.status}>
          <span aria-hidden="true">
            <StatusIcon status={STEP_MARK[s.status]} />
          </span>
          <span className="srv-up-step-text">
            <span>{job.state === "waiting" && s.id === "preflight" ? "Waiting for a deploy or restore to finish" : stepLabel(job, s.id)}</span>
            {s.detail && s.status !== "pending" ? <span className="srv-up-step-detail">{s.detail}</span> : null}
          </span>
          <span className="sr">{STEP_SR[s.status]}</span>
        </li>
      ))}
    </ol>
  );
}

const RESULT: Record<UpdateJob["state"], { label: string; tone: "ok" | "bad" | "warn" | "live" | "pending" }> = {
  done: { label: "Done", tone: "ok" },
  rolledBack: { label: "Rolled back", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  running: { label: "Running", tone: "live" },
  waiting: { label: "Waiting", tone: "pending" },
};

/** The rest of the notes folds behind "Show notes", so the card never grows an inner scroller. */
export function Notes({ source, label }: { source: string; label: string }) {
  const [open, setOpen] = useState(false);
  const blocks = parseMarkdown(source);
  const lead = blocks.findIndex((b) => b.t === "p");
  const summary = lead >= 0 ? blocks[lead]! : null;
  const rest = blocks.filter((b, i) => i !== lead && !(i < lead && b.t === "heading"));
  return (
    <div className="srv-up-notes" role="region" aria-label={label}>
      <div className="md">{summary ? <Block block={summary} /> : null}</div>
      {rest.length ? (
        <>
          {open ? (
            <div className="md" id="srv-up-notes-rest">
              {rest.map((b, i) => (
                <Block key={i} block={b} />
              ))}
            </div>
          ) : null}
          {/* aria-controls only while the notes are in the page, so it never names a missing id. */}
          <button type="button" className="btn btn-xs" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={open ? "srv-up-notes-rest" : undefined}>
            {open ? "Hide notes" : "Show notes"}
          </button>
        </>
      ) : null}
    </div>
  );
}

export function History({ jobs, now }: { jobs: UpdateJob[]; now: number }) {
  const [all, setAll] = useState(false);
  if (!jobs.length) return null;
  const shown = all ? jobs : jobs.slice(0, HISTORY_SHOWN);
  return (
    <div className="srv-up-hist">
      <p className="srv-up-sec" id="srv-up-hist-title">
        History
      </p>
      <ol className="srv-up-hist-list" aria-labelledby="srv-up-hist-title">
        {shown.map((j) => {
          const r = RESULT[j.state];
          return (
            <li key={j.id} className="srv-up-hist-row">
              <span className="two">
                <span className="two-main srv-up-hist-ver">
                  {j.kind === "rollback" ? <span className="srv-up-hist-kind">Rollback</span> : null}
                  <span className="num">{v(j.from)}</span>
                  <Icon name="arrowRight" size={14} />
                  <span className="num">{v(j.version)}</span>
                </span>
                <span className="two-sub">
                  <When iso={j.finishedAt ?? j.startedAt} now={now} />
                  {`, ${j.trigger === "auto" ? "automatic" : (j.actor ?? "manual")}`}
                  {j.durationMs !== null ? `, ${duration(j.durationMs / 1000)}` : null}
                </span>
                {/* Clamped to two lines; the title holds the full text behind the cut. */}
                {j.error && j.state !== "done" ? (
                  <span className="two-sub srv-up-hist-err" title={j.error}>
                    {j.error}
                  </span>
                ) : null}
              </span>
              <StatusChip tone={r.tone}>{r.label}</StatusChip>
            </li>
          );
        })}
      </ol>
      {jobs.length > HISTORY_SHOWN ? (
        <button type="button" className="btn btn-xs srv-up-more" onClick={() => setAll((a) => !a)} aria-expanded={all}>
          {all ? "Show fewer" : `Show all ${jobs.length}`}
        </button>
      ) : null}
    </div>
  );
}
