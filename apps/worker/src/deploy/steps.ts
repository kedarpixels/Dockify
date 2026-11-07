/**
 * The step timeline stored in Deployment.steps. "release" is an internal step (the run-once
 * marker for the release command); the api only shows the ids the contract knows.
 */
export const STEP_IDS = ["queued", "clone", "build", "push", "release", "deploy", "health"] as const;
export type StepId = (typeof STEP_IDS)[number];
export type StepStatus = "pending" | "running" | "done" | "failed" | "cancelled" | "skipped";

export interface Step {
  id: StepId;
  status: StepStatus;
  startedAt: string | null;
  finishedAt: string | null;
}

export function initialSteps(now: string): Step[] {
  return STEP_IDS.map((id) => (id === "queued" ? { id, status: "done", startedAt: now, finishedAt: now } : { id, status: "pending", startedAt: null, finishedAt: null }));
}

/** Reads whatever is stored, filling in any step a row predates. */
export function parseSteps(raw: unknown, now: string): Step[] {
  const base = initialSteps(now);
  if (!Array.isArray(raw)) return base;
  const byId = new Map<string, Step>();
  for (const s of raw as Step[]) if (s && typeof s === "object" && STEP_IDS.includes(s.id)) byId.set(s.id, s);
  return base.map((s) => byId.get(s.id) ?? s);
}

export function setStep(steps: Step[], id: StepId, status: StepStatus, now: string): Step[] {
  return steps.map((s) => {
    if (s.id !== id) return s;
    const startedAt = s.startedAt ?? (status === "skipped" ? null : now);
    const finishedAt = status === "running" || status === "pending" ? null : now;
    return { ...s, status, startedAt, finishedAt };
  });
}

/** On a terminal failure or cancel, the running step takes that status and pending ones are skipped. */
export function closeSteps(steps: Step[], outcome: "failed" | "cancelled", now: string): Step[] {
  return steps.map((s) => {
    if (s.status === "running") return { ...s, status: outcome, finishedAt: now };
    if (s.status === "pending") return { ...s, status: "skipped" };
    return s;
  });
}

export const stepDone = (steps: Step[], id: StepId) => steps.some((s) => s.id === id && s.status === "done");
