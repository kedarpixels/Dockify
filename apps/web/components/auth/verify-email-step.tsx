"use client";

import { useEffect, useEffectEvent, useRef, useState, useTransition } from "react";
import { Icon } from "@/components/icon";
import { Field } from "@/components/ui/field";
import { confirmVerifyCode, sendVerifyCode } from "@/lib/pages/auth";
import { AuthHead } from "./auth-head";
import { CooldownNotice, Notice, SubmitButton, useCooldown, waitLabel } from "./fields";
import { OtpInput, type OtpHandle } from "./otp-input";
import { settle } from "./util";

const RESEND_SECONDS = 30;

/**
 * Setup, when email is on: a 6-digit code to the admin's address proves the mail arrives and the
 * address is theirs. Optional; skipping leaves it unverified and Settings, Profile can verify later.
 */
export function VerifyEmailStep({ step, onDone, onSkip, onBack }: { step: [number, number]; onDone: () => void; onSkip: () => void; /** Back to the email settings, when this setup connected them: a code that never comes is often the from domain. */ onBack?: () => void }) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [wait, startWait] = useCooldown();
  const [resendIn, startResend] = useCooldown();
  const [pending, startTransition] = useTransition();
  // The first code goes out as the step opens.
  const [sending, setSending] = useState(true);
  const otpRef = useRef<OtpHandle>(null);
  const live = useRef(true);
  const started = useRef(false);

  // Results land only in the promise callback.
  const request = () =>
    settle(sendVerifyCode()).then((r) => {
      if (!live.current) return;
      setSending(false);
      if (r.ok) {
        setSentTo(r.email);
        startResend(RESEND_SECONDS);
        otpRef.current?.focus();
      } else if (r.retryAfter) startWait(r.retryAfter);
      else setSendError(r.error);
    });

  const send = () => {
    setSending(true);
    setSendError(null);
    void request();
  };
  const resendOff = sending || resendIn > 0 || wait > 0;

  const sendFirst = useEffectEvent(() => void request());

  // One code per visit to this step, even when a dev remount runs the effect twice.
  useEffect(() => {
    live.current = true;
    if (!started.current) {
      started.current = true;
      sendFirst();
    }
    return () => {
      live.current = false;
    };
  }, []);

  const confirm = (value: string) => {
    if (pending || wait || value.length !== 6) return;
    setError(null);
    startTransition(async () => {
      const r = await settle(confirmVerifyCode({ code: value }));
      if (r.ok) return onDone();
      if (r.retryAfter) startWait(r.retryAfter);
      else setError(r.error);
      setCode("");
      otpRef.current?.focus();
    });
  };

  return (
    <section className="auth-block">
      <AuthHead
        icon="mail"
        step={step}
        title="Verify your email"
        lead={sentTo ? <>Dockify sent a 6-digit code to <span className="auth-wrap">{sentTo}</span>. It works for 10 minutes.</> : "Optional. A code to your address proves that email from this server arrives."}
        announce
      />

      <form
        className="auth-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          confirm(code);
        }}
      >
        {sendError ? <Notice>{sendError}</Notice> : null}
        <Field id="setup-email-code" label="Code from the email" error={error} hint="Not there? Check the spam folder.">
          {(ids) => (
            <OtpInput
              ref={otpRef}
              id={ids.id}
              describedBy={ids.describedBy}
              invalid={ids.invalid}
              value={code}
              onChange={(v) => {
                setCode(v);
                if (error) setError(null);
              }}
              onComplete={confirm}
              disabled={wait > 0 || !sentTo}
              autoFocus
              label="Code from the email"
            />
          )}
        </Field>

        <CooldownNotice seconds={wait} />

        <div className="auth-pair">
          <button type="button" className="btn" onClick={onSkip} disabled={pending}>
            Skip for now
          </button>
          <SubmitButton icon="check" label="Verify" pending={pending} disabled={wait > 0 || !sentTo || code.length < 6} />
        </div>
      </form>

      <div className="auth-alt">
        {/* Off (not disabled) while sending or waiting, so a focused key keeps the focus. */}
        <button type="button" className="auth-link auth-back" aria-disabled={resendOff || undefined} onClick={() => !resendOff && send()}>
          <Icon name="refresh" size={14} />
          {sendError ? "Try again" : resendIn > 0 ? `Send a new code in ${waitLabel(resendIn)}` : "Send a new code"}
        </button>
        {onBack ? (
          <button type="button" className="auth-link auth-back" onClick={onBack} disabled={pending}>
            Change email settings
          </button>
        ) : null}
      </div>
    </section>
  );
}
