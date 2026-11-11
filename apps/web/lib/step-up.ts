// An elevated API route answers 403 "step_up_required". Every web route and action turns that into
// one refusal shape, so the raw code never reaches a toast and the browser can ask and resend.

/** The machine code of a refusal that needs a fresh step-up. Also the API's own error text. */
export const STEP_UP_REQUIRED = "step_up_required";

/** The machine code of a step-up the operator closed without confirming. */
export const STEP_UP_CANCELLED = "step_up_cancelled";

/** How long one step-up holds on the API (ELEVATION_MS in apps/api/src/actor.ts). */
export const STEP_UP_MINUTES = 5;

/** What a refusal says when nobody could ask, or the operator closed the question. */
export const STEP_UP_MESSAGE = "Confirm it is you to continue";

export const stepUpRefusal = () => ({ ok: false as const, error: STEP_UP_MESSAGE, code: STEP_UP_REQUIRED });

const codeOf = (v: unknown) => (v && typeof v === "object" && "code" in v ? (v as { code?: unknown }).code : undefined);

/** Also true for `{ ok: false, error: "step_up_required" }`, from a path that passed the API's answer through untouched. */
export function isStepUpRefusal(v: unknown): boolean {
  if (codeOf(v) === STEP_UP_REQUIRED) return true;
  if (!v || typeof v !== "object") return false;
  const o = v as { ok?: unknown; error?: unknown };
  return o.ok === false && o.error === STEP_UP_REQUIRED;
}

/** True for a refusal that only says the operator closed the step-up: nothing to report. */
export const isStepUpCancel = (v: unknown): boolean => codeOf(v) === STEP_UP_CANCELLED;
