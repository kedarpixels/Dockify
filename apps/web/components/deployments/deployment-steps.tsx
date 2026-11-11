import { CardTitle } from "@/components/card-title";
import { StatusIcon } from "@/components/overview/status-icon";
import { Callout } from "@/components/ui/callout";
import { Corners } from "@/components/ui/rule";
import { clock, duration } from "@/lib/format";
import type { DeploymentDetail, DeploymentStep } from "@/lib/pages/deployments";
import { STEP_LABEL } from "@/lib/pages/deployments-labels";
import type { DeploymentStatus } from "@/lib/types";

/** Seconds from `a` to `b`, where `b` is an ISO time or epoch milliseconds. */
export const secondsBetween = (a: string, b: string | number) => ((typeof b === "number" ? b : Date.parse(b)) - Date.parse(a)) / 1000;

const STEP_WORD: Record<DeploymentStep["status"], string> = {
  pending: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

function StepMark({ step }: { step: DeploymentStep }) {
  const as: Partial<Record<DeploymentStep["status"], DeploymentStatus>> = {
    done: "ready",
    failed: "failed",
    cancelled: "cancelled",
    running: step.id === "queued" ? "queued" : step.id === "build" ? "building" : "deploying",
  };
  const status = as[step.status];
  if (status) return <StatusIcon status={status} />;
  return (
    <span className="st-app" role="img" aria-label={step.status === "skipped" ? "Skipped" : "Waiting"}>
      <span className="dpd-wait-dot" />
    </span>
  );
}

export function DeploymentSteps({ d, now }: { d: DeploymentDetail; now: number }) {
  const failedAt = d.steps.find((s) => s.status === "failed" || s.status === "cancelled");
  const running = d.steps.find((s) => s.status === "running");
  const wall = secondsBetween(d.createdAt, d.finishedAt ?? now);
  const sub =
    d.status === "ready"
      ? `Ready in ${duration(wall)}`
      : failedAt && d.status === "failed"
        ? `Failed at ${STEP_LABEL[failedAt.id].toLowerCase()} after ${duration(wall)}`
        : d.status === "cancelled"
          ? `Cancelled after ${duration(wall)}`
          : running
            ? `${STEP_LABEL[running.id]} for ${clock(secondsBetween(running.startedAt ?? d.createdAt, now))}`
            : "Waiting for a build slot";
  return (
    <section className="card reveal dpd-steps-card" aria-labelledby="dpd-steps-title">
      <div className="card-hd">
        <CardTitle id="dpd-steps-title" icon="layers" title="Steps" sub={sub} />
      </div>
      {/* Why it failed, in the one boxed note, over the steps it explains. */}
      {d.error ? (
        <div className="dpd-note">
          <Callout tone="bad" icon="alert">
            {d.error}
          </Callout>
        </div>
      ) : null}
      <ol className="dpd-steps" style={{ "--steps": d.steps.length, "--steps-rest": d.steps.length - 1 } as React.CSSProperties}>
        {d.steps.map((s, i) => {
          const secs = s.startedAt ? secondsBetween(s.startedAt, s.finishedAt ?? now) : null;
          return (
            <li key={s.id} className="dpd-step" data-status={s.status}>
              <Corners />
              {/* Keyed on status, so a change swaps the mark with a short settle instead of a jump. */}
              <span key={s.status} className="dpd-step-mark">
                <StepMark step={s} />
              </span>
              <span className="two">
                <span className="two-main dpd-step-name">
                  <span className="dpd-step-no num">{i + 1}</span>
                  {STEP_LABEL[s.id]}
                </span>
                <span className={`two-sub dpd-step-meta num${s.status === "running" ? " tone-live" : s.status === "failed" ? " tone-bad" : ""}`}>
                  {secs === null ? STEP_WORD[s.status] : s.status === "running" ? clock(secs) : `${STEP_WORD[s.status]}, ${duration(Math.max(secs, 0.5))}`}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
