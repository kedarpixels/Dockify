"use client";

import { useEffect, useRef, useState } from "react";
import { confirmEmailCode, sendEmailCode } from "@/app/(console)/settings/actions";
import { useCooldown, waitLabel } from "@/components/auth/fields";
import { OtpInput, type OtpHandle } from "@/components/auth/otp-input";
import { Callout } from "@/components/ui/callout";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { Skel } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { elevate } from "@/components/step-up/step-up";
import { describe } from "@/lib/feedback";
import type { Me, Outcome } from "@/lib/pages/activity-settings";
import { isStepUpCancel } from "@/lib/step-up";
import { settle } from "./form";

// Mounted only while open, so every opening sends a fresh code. With `target` the account moves
// there; without, the current address is verified.

const RESEND_SECONDS = 30;

type Step = { at: "sending" } | { at: "code"; email: string } | { at: "failed"; error: string };

export function EmailCodeDialog({
  onClose,
  onDone,
  me,
  target,
  preview,
}: {
  onClose: () => void;
  onDone: (me: Me) => void;
  me: Me;
  target?: string;
  preview: boolean;
}) {
  const [step, setStep] = useState<Step>({ at: "sending" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendIn, startResend] = useCooldown();
  const otp = useRef<OtpHandle>(null);
  // The newest send: an older answer that lands after a newer request is dropped.
  const seq = useRef(0);
  const change = target !== undefined;

  const request = () => elevate(() => settle(sendEmailCode(change ? { email: target } : {})), { what: "Moving your sign-in email" });

  const landed = (mine: number, r: Outcome<{ email: string }>) => {
    if (mine !== seq.current) return;
    if (r.ok) {
      setStep({ at: "code", email: r.data.email });
      startResend(RESEND_SECONDS);
      return;
    }
    if (isStepUpCancel(r)) onClose();
    else setStep({ at: "failed", error: r.error });
  };

  useEffect(() => {
    const mine = ++seq.current;
    let alive = true;
    void request().then((r) => {
      if (alive) landed(mine, r);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one send per mount; `request` and `landed` read the props they need at call time.
  }, []);

  const resend = () => {
    const mine = ++seq.current;
    setStep({ at: "sending" });
    setError(null);
    setCode("");
    void request().then((r) => landed(mine, r));
  };

  const verify = async (value: string) => {
    if (busy || step.at !== "code") return;
    if (value.length !== 6) return setError("Enter all 6 digits");
    setBusy(true);
    setError(null);
    const r = await settle(confirmEmailCode(value, target));
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      setCode("");
      otp.current?.focus();
      return;
    }
    toast.success(change ? "Email changed" : "Email verified", {
      description: describe(change ? [`Now ${r.data.email}`, "A notice went to the old address"] : r.data.email, { preview }),
    });
    onDone(r.data);
  };

  const title = change ? "Confirm your new email" : "Verify your email";

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      sub={change ? target : me.email}
      icon="mail"
      size="sm"
      busy={busy}
      onSubmit={() => void verify(code)}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {step.at === "failed" ? (
            <button type="button" className="btn btn-primary" onClick={resend}>
              Try again
            </button>
          ) : (
            <PendingButton type="submit" className="btn btn-primary" pending={busy} disabled={step.at !== "code"} icon="check">
              {change ? "Change email" : "Verify"}
            </PendingButton>
          )}
        </>
      }
    >
      {step.at === "sending" ? (
        <div className="as-code-wait" role="status" aria-busy="true">
          <Skel w="80%" h={10} />
          <Skel w={264} h={48} r={10} />
          <span className="sr">Sending the code</span>
        </div>
      ) : step.at === "failed" ? (
        <Callout tone="warn" icon="alert" role="alert">
          {step.error}
        </Callout>
      ) : (
        <>
          <p className="dlg-text">
            Dockify sent a 6-digit code to <strong className="int-wrap">{step.email}</strong>. It works for 10 minutes.
          </p>
          <Field id="as-email-code" label="Code from the email" error={error} hint="Not there? Check the spam folder.">
            {(ids) => (
              <OtpInput
                ref={otp}
                id={ids.id}
                describedBy={ids.describedBy}
                invalid={ids.invalid}
                value={code}
                autoFocus
                disabled={busy}
                label="Code from the email"
                onChange={(v) => {
                  setCode(v);
                  if (error) setError(null);
                }}
                onComplete={(v) => void verify(v)}
              />
            )}
          </Field>
          {/* Off (not disabled) while a code is checked or the wait runs, so a focused key keeps the focus. */}
          <PendingButton className="btn btn-sm as-code-resend" pending={false} disabled={busy || resendIn > 0} onClick={resend}>
            {resendIn > 0 ? `Send a new code in ${waitLabel(resendIn)}` : "Send a new code"}
          </PendingButton>
        </>
      )}
    </Dialog>
  );
}
