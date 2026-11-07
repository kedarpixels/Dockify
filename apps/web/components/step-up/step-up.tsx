"use client";

import { useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PasswordInput } from "@/components/auth/fields";
import { OtpInput } from "@/components/auth/otp-input";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { OFFLINE } from "@/lib/client-api";
import { endSession } from "@/lib/hooks";
import { isStepUpCancel, isStepUpRefusal, STEP_UP_CANCELLED, STEP_UP_MESSAGE, STEP_UP_MINUTES } from "@/lib/step-up";
import { confirmStepUp, stepUpMethod, type StepUpAnswer, type StepUpMethod } from "./actions";

/*
 * "Confirm it is you": the one step-up for every elevated write (apps/api/src/policy.ts).
 *
 *   const r = await elevate(() => mutate(m), { what: "Opening a terminal" });
 *
 * `elevate` runs the call. When the answer is the step-up refusal (lib/step-up.ts) it asks for the
 * authenticator code when two-factor is on, else the password, then runs the call once more. A
 * closed dialog resolves to the refusal marked cancelled, which `report` (lib/feedback.ts) leaves
 * without a toast. The API decides when a step-up is needed and how long it holds (5 minutes); the
 * page never guesses. Concurrent writes that hit the refusal share one question.
 *
 * The dialog lives in a small root of its own, made on first use, so any client code can ask,
 * a plain helper such as `mutate` included, on every page, with nothing to mount.
 */

export interface StepUpOptions {
  /** What needs the check, as the dialog says it: "Opening a terminal", "Changing variables". */
  what?: string;
}

const DEFAULT_WHAT = "This change";

interface Question {
  id: number;
  what: string;
  method: StepUpMethod | null;
  resolve: (ok: boolean) => void;
}

/* -------------- The question, shared by every caller on the page -------------- */

let question: Question | null = null;
let asking: Promise<boolean> | null = null;
let seq = 0;
/** Until when a step-up this page made still holds (with a margin), for `ensureStepUp`. */
let freshUntil = 0;
let host: Root | null = null;
const listeners = new Set<() => void>();

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/**
 * While the question is up it is the only popup on screen: `html.step-up-open` sets any dialog it
 * interrupted out of view (still mounted, so what was typed stays), and it returns once the check is
 * answered (foundation.css, "Step-up stands alone"). Owner rule: never two popups stacked.
 */
function setQuestion(next: Question | null) {
  question = next;
  if (typeof document !== "undefined") document.documentElement.classList.toggle("step-up-open", next !== null);
  for (const fn of listeners) fn();
}

function mountHost() {
  if (host) return;
  const el = document.createElement("div");
  el.setAttribute("data-step-up", "");
  document.body.appendChild(el);
  // Its own id prefix, so ids from this root never collide with the page's.
  host = createRoot(el, { identifierPrefix: "step-up-" });
  host.render(<StepUpHost />);
}

/** Asks once; a caller arriving while the question is open waits for the same answer. */
function ask(what: string): Promise<boolean> {
  if (asking) return asking;
  asking = (async () => {
    const method = await stepUpMethod().catch(() => null);
    mountHost();
    return new Promise<boolean>((resolve) => setQuestion({ id: ++seq, what, method, resolve }));
  })().finally(() => {
    asking = null;
  });
  return asking;
}

/** The refusal, marked as closed by the operator. */
function cancelled<R>(r: R): R {
  return r && typeof r === "object" ? { ...r, error: STEP_UP_MESSAGE, code: STEP_UP_CANCELLED } : r;
}

/* -------------- The API -------------- */

/**
 * Runs `call`; on a step-up refusal asks, then runs it once more. Resolves with the last answer, or
 * with the refusal marked cancelled when the dialog was closed.
 */
export async function elevate<R>(call: () => Promise<R>, opts: StepUpOptions = {}): Promise<R> {
  const first = await call();
  if (!isStepUpRefusal(first)) return first;
  if (!(await ask(opts.what ?? DEFAULT_WHAT))) return cancelled(first);
  return call();
}

/** `elevate` for a call that throws its failures: a closed dialog throws an error `wasCancelled` reads. */
export async function elevateThrowing<T>(call: () => Promise<T>, opts: StepUpOptions = {}): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (!isStepUpRefusal(e)) throw e;
    if (!(await ask(opts.what ?? DEFAULT_WHAT))) throw Object.assign(new Error(STEP_UP_MESSAGE), { code: STEP_UP_CANCELLED });
    return call();
  }
}

/**
 * Asks before an elevated action that cannot be retried from here, such as a file download: true
 * at once inside a window this page opened, else after a confirmed check.
 */
export function ensureStepUp(opts: StepUpOptions = {}): Promise<boolean> {
  return Date.now() < freshUntil ? Promise.resolve(true) : ask(opts.what ?? DEFAULT_WHAT);
}

/** True for a failure that only says the operator closed the step-up: nothing to report. */
export const wasCancelled = (e: unknown) => isStepUpCancel(e);

export type Elevate = typeof elevate;

const STEP_UP = { elevate, elevateThrowing, ensure: ensureStepUp } as const;

/** The step-up for a component: `elevate`, `elevateThrowing` and `ensure`, stable across renders. */
export function useStepUp() {
  return STEP_UP;
}

/* -------------- The dialog -------------- */

function StepUpHost() {
  const q = useSyncExternalStore(subscribe, () => question, () => null);
  if (!q) return null;
  const done = (ok: boolean) => {
    if (question?.id === q.id) setQuestion(null);
    q.resolve(ok);
  };
  return <StepUpDialog key={q.id} what={q.what} method={q.method} onDone={done} />;
}

/**
 * The question itself. With two-factor on it takes the 6-digit authenticator code, else the
 * password; when the account could not be read it takes either, and 6 digits reads as a code.
 */
function StepUpDialog({ what, method: known, onDone }: { what: string; method: StepUpMethod | null; onDone: (ok: boolean) => void }) {
  const [method, setMethod] = useState(known);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (value = secret) => {
    if (busy || !value) return;
    if (method === "code" && value.length !== 6) {
      setError("Enter all 6 digits");
      return;
    }
    const asCode = method === "code" || (method === null && /^\d{6}$/.test(value));
    setBusy(true);
    const r = await confirmStepUp(asCode ? { code: value } : { password: value }).catch((): StepUpAnswer => ({ ok: false, error: OFFLINE }));
    setBusy(false);
    if (r.ok) {
      const end = Date.parse(r.expiresAt);
      freshUntil = Number.isNaN(end) ? 0 : end - 15_000;
      onDone(true);
      return;
    }
    if (r.expired) {
      onDone(false);
      endSession();
      return;
    }
    if (r.method) setMethod(r.method);
    setError(r.error);
    setSecret("");
    // Back in the field for the next try, wherever the focus was (Confirm, or a code that just
    // switched the field from password to code).
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".dlg-stepup .dlg-body input")?.focus({ preventScroll: true }));
  };

  const change = (v: string) => {
    setSecret(v);
    if (error) setError(null);
  };

  return (
    <Dialog
      open
      onClose={() => onDone(false)}
      busy={busy}
      size="sm"
      className="dlg-stepup"
      icon="shieldCheck"
      title="Confirm it is you"
      sub={`${what} needs a fresh check. It holds for ${STEP_UP_MINUTES} minutes.`}
      onSubmit={() => void submit()}
      footer={
        <>
          <button type="button" className="btn" onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </button>
          <PendingButton type="submit" className="btn btn-primary" pending={busy} disabled={!secret || (method === "code" && secret.length !== 6)} icon="shieldCheck">
            Confirm
          </PendingButton>
        </>
      }
    >
      {method === "code" ? (
        <Field label="Authenticator code" hint="The 6-digit code from your authenticator app." error={error}>
          {(ids) => (
            <OtpInput
              id={ids.id}
              describedBy={ids.describedBy}
              invalid={ids.invalid}
              value={secret}
              autoFocus
              disabled={busy}
              label="Authenticator code"
              onChange={change}
              onComplete={(v) => void submit(v)}
            />
          )}
        </Field>
      ) : (
        <Field
          label={method === "password" ? "Password" : "Password or authenticator code"}
          hint={method === "password" ? undefined : "With two-factor on, enter the 6-digit code from your authenticator app."}
          error={error}
        >
          {(ids) => (
            <PasswordInput
              ids={ids}
              autoComplete="current-password"
              maxLength={256}
              value={secret}
              readOnly={busy}
              onChange={(e) => change(e.target.value)}
              data-autofocus
            />
          )}
        </Field>
      )}
    </Dialog>
  );
}
