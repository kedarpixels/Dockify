"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { changePassword, requestPasswordCode } from "@/app/(console)/settings/actions";
import { MatchHint, PasswordInput, StrengthMeter, useCooldown, waitLabel } from "@/components/auth/fields";
import { OtpInput, type OtpHandle } from "@/components/auth/otp-input";
import { settle as settleAuth } from "@/components/auth/util";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { toast } from "@/components/ui/toast";
import { errText, PREVIEW_NOTE, report } from "@/lib/feedback";
import { requestPasswordReset } from "@/lib/pages/auth";
import { MIN_PASSWORD, PASSWORD_MISMATCH, SHORT_PASSWORD } from "@/lib/password";
import { settle } from "./form";

/*
 * Change password, as a popup from the Security section, mounted only while open so every opening
 * starts clean. Without email it is one step: the three fields, then the change. With email on it
 * is two: the fields first ("Continue" checks the current password and mails a 6-digit code), then
 * "Check your email", where the code goes in and the passwords and code are sent together. The API
 * checks the code before it changes anything. With email on, "Forgot your current password?" turns
 * the popup into the emailed reset; without email it points at /recover, the SSH reset. Nothing
 * closes the popup while a request runs.
 */

const RESEND_SECONDS = 30;

type Errors = { current?: string; next?: string; confirm?: string };
type Step = { at: "fields" } | { at: "code"; email: string } | { at: "reset" } | { at: "sent" };

export function PasswordDialog({
  onClose,
  emailEnabled,
  preview,
  email,
}: {
  onClose: () => void;
  emailEnabled: boolean;
  preview: boolean;
  /** The signed-in account's address, where a reset link goes. */
  email: string;
}) {
  const [step, setStep] = useState<Step>({ at: "fields" });
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [codeError, setCodeError] = useState<string | null>(null);
  // What is running: the code request, the change itself or the reset link, so each key shows its own spinner.
  const [pending, setPending] = useState<"send" | "change" | "reset" | null>(null);
  const busy = pending !== null;
  const [resendIn, startResend] = useCooldown();
  const otp = useRef<OtpHandle>(null);

  const edit = (key: keyof Errors, set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    set(e.target.value);
    if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
  };
  // The mismatch shows as soon as the confirm field disagrees, not only on submit.
  const mismatch = confirm && confirm !== next ? PASSWORD_MISMATCH : undefined;

  const validate = () => {
    const found: Errors = {};
    if (!current) found.current = "Enter your current password";
    if (next.length < MIN_PASSWORD) found.next = SHORT_PASSWORD;
    if (!confirm) found.confirm = "Confirm the new password";
    else if (confirm !== next) found.confirm = PASSWORD_MISMATCH;
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  const sendCode = async () => {
    setPending("send");
    const r = await settle(requestPasswordCode({ current }));
    setPending(null);
    if (!r.ok) {
      toast.error(step.at === "code" ? "Could not send a new code" : "Could not send the code", { description: errText(r.error) });
      return;
    }
    setCode("");
    setCodeError(null);
    setStep({ at: "code", email: r.data.email });
    startResend(RESEND_SECONDS);
  };

  const change = async (withCode?: string) => {
    setPending("change");
    const r = report(await settle(changePassword({ current, next, ...(withCode ? { code: withCode } : {}) })), {
      success: "Password changed",
      error: "Could not change password",
      what: "Every other session is signed out once it changes",
      preview,
    });
    setPending(null);
    if (r.ok) {
      onClose();
      return;
    }
    if (withCode) {
      setCodeError(r.error);
      setCode("");
      otp.current?.focus();
    }
  };

  const sendReset = async () => {
    setPending("reset");
    const r = await settleAuth(requestPasswordReset({ email }));
    setPending(null);
    if (!r.ok) {
      toast.error("Could not send the reset link", { description: errText(r.error) });
      return;
    }
    setStep({ at: "sent" });
  };

  const submit = () => {
    if (busy) return;
    if (step.at === "sent") return onClose();
    if (step.at === "reset") return void sendReset();
    if (step.at === "code") {
      if (code.length !== 6) return setCodeError("Enter all 6 digits");
      return void change(code);
    }
    if (!validate()) return;
    void (emailEnabled ? sendCode() : change());
  };

  const toCode = emailEnabled && step.at === "fields";
  const resending = pending === "send" && step.at === "code";
  const byEmail = step.at === "reset" || step.at === "sent";

  const head =
    step.at === "reset"
      ? { title: "Reset your password", sub: "No current password needed", icon: "mail" as const }
      : step.at === "sent"
        ? { title: "Reset link sent", sub: "It works once, for 30 minutes", icon: "mail" as const }
        : step.at === "code"
          ? { title: "Check your email", sub: "Every other session is signed out once it changes", icon: "mail" as const }
          : { title: "Change password", sub: "Every other session is signed out once it changes", icon: "lock" as const };

  const footer =
    step.at === "sent" ? (
      <button type="submit" className="btn btn-primary">
        Done
      </button>
    ) : step.at === "reset" ? (
      <>
        <button type="button" className="btn" onClick={() => setStep({ at: "fields" })} disabled={busy}>
          Back
        </button>
        <PendingButton type="submit" className="btn btn-primary" pending={busy} icon="mail">
          Send reset link
        </PendingButton>
      </>
    ) : (
      <>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        {toCode ? (
          <PendingButton type="submit" className="btn btn-primary" pending={busy && !resending} disabled={resending} trailing="arrowRight">
            Continue
          </PendingButton>
        ) : (
          <PendingButton type="submit" className="btn btn-primary" pending={busy && !resending} disabled={resending} icon="check">
            Change password
          </PendingButton>
        )}
      </>
    );

  return (
    <Dialog open onClose={onClose} title={head.title} sub={head.sub} icon={head.icon} size="sm" busy={busy} onSubmit={submit} footer={footer}>
      {byEmail ? (
        <p className="dlg-text">
          {step.at === "reset" ? (
            <>
              Dockify sends a link to <strong className="int-wrap">{email}</strong>. Open it to choose a new password. It works once, for 30 minutes, and signs you
              out everywhere, this browser included.
            </>
          ) : (
            <>
              A link is on its way to <strong className="int-wrap">{email}</strong>. Nothing after a few minutes? Check the spam folder.
              {preview ? ` ${PREVIEW_NOTE}.` : null}
            </>
          )}
        </p>
      ) : step.at === "fields" ? (
        <>
          <Field label="Current password" error={errors.current}>
            {(ids) => <PasswordInput ids={ids} autoComplete="current-password" value={current} onChange={edit("current", setCurrent)} data-autofocus />}
          </Field>
          {emailEnabled ? (
            <button type="button" className="as-forgot" onClick={() => setStep({ at: "reset" })}>
              Forgot your current password?
            </button>
          ) : (
            <p className="fld-note">
              <Link href="/recover" className="as-forgot">
                Forgot your current password?
              </Link>{" "}
              Whoever runs this server can reset it over SSH.
            </p>
          )}
          <Field label="New password" error={errors.next} hint={<StrengthMeter password={next} />}>
            {(ids) => <PasswordInput ids={ids} autoComplete="new-password" value={next} onChange={edit("next", setNext)} />}
          </Field>
          <Field label="Confirm new password" error={errors.confirm ?? mismatch} hint={confirm && confirm === next ? <MatchHint /> : undefined}>
            {(ids) => <PasswordInput ids={ids} autoComplete="new-password" value={confirm} onChange={edit("confirm", setConfirm)} />}
          </Field>
        </>
      ) : (
        <>
          <p className="dlg-text">
            Dockify sent a 6-digit code to <strong className="int-wrap">{step.email}</strong>. It works for 10 minutes.
          </p>
          <Field id="as-password-code" label="Code from the email" error={codeError} hint="Not there? Check the spam folder.">
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
                  if (codeError) setCodeError(null);
                }}
                onComplete={(v) => {
                  if (!busy) void change(v);
                }}
              />
            )}
          </Field>
          <PendingButton className="btn btn-sm as-code-resend" onClick={() => void sendCode()} pending={resending} disabled={(busy && !resending) || resendIn > 0}>
            {resendIn > 0 ? `Send a new code in ${waitLabel(resendIn)}` : "Send a new code"}
          </PendingButton>
        </>
      )}
    </Dialog>
  );
}
