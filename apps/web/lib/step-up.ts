/*
 * The step-up contract shared by the server routes, the server actions and the browser. Pure, so the
 * browser, the server and the tests import the same values.
 *
 * An elevated API route (apps/api/src/policy.ts) answers 403 { error: "step_up_required" } when the
 * session has no fresh step-up. Every web route and server action turns that answer into one
 * refusal shape: `{ ok: false, error: STEP_UP_MESSAGE, code: STEP_UP_REQUIRED }`, so the raw code never
 * reaches a toast and the browser can ask for the password or code and send the write again
 * (components/step-up).
 */

/** The machine code of a refusal that needs a fresh step-up. Also the API's own error text. */
export const STEP_UP_REQUIRED = "step_up_required";

/** The machine code of a step-up the operator closed without confirming. */
export const STEP_UP_CANCELLED = "step_up_cancelled";

/** How long one step-up holds on the API (ELEVATION_MS in apps/api/src/actor.ts). */
export const STEP_UP_MINUTES = 5;

/** What a refusal says when nobody could ask, or the operator closed the question. */
export const STEP_UP_MESSAGE = "Confirm it is you to continue";

/** The refusal every web route and server action answers for an API step_up_required. */
export const stepUpRefusal = () => ({ ok: false as const, error: STEP_UP_MESSAGE, code: STEP_UP_REQUIRED });

const codeOf = (v: unknown) => (v && typeof v === "object" && "code" in v ? (v as { code?: unknown }).code : undefined);

/**
 * True for an answer that needs a fresh step-up: a result or an Error carrying the code, or, as a
 * safety net for a path that passed the API's answer through untouched, `{ ok: false, error: "step_up_required" }`.
 */
export function isStepUpRefusal(v: unknown): boolean {
  if (codeOf(v) === STEP_UP_REQUIRED) return true;
  if (!v || typeof v !== "object") return false;
  const o = v as { ok?: unknown; error?: unknown };
  return o.ok === false && o.error === STEP_UP_REQUIRED;
}

/** True for a refusal that only says the operator closed the step-up: nothing to report. */
export const isStepUpCancel = (v: unknown): boolean => codeOf(v) === STEP_UP_CANCELLED;
