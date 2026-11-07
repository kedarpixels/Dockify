"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { Icon } from "@/components/icon";
import { Field } from "@/components/ui/field";
import { resetPassword, type AuthField, type ResetPreview } from "@/lib/pages/auth";
import { AuthHead } from "./auth-head";
import { PASSWORD_MISMATCH } from "@/lib/password";
import { CooldownNotice, MatchHint, Notice, PasswordInput, StrengthMeter, SubmitButton, useCooldown } from "./fields";
import { settle } from "./util";

/**
 * /reset/[token]: a new password from an emailed link. The link works once; setting the password
 * ends every session, so the visitor signs in fresh (and still meets two-factor, when it is on).
 */
export function ResetView({ token, reset }: { token: string; reset: ResetPreview }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<{ field?: AuthField | "confirm"; text: string } | null>(null);
  const [done, setDone] = useState(false);
  const [wait, startWait] = useCooldown();
  const [pending, startTransition] = useTransition();
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const fieldError = (f: AuthField | "confirm") => (error?.field === f ? error.text : undefined);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pending || wait) return;
    if (confirm !== password) {
      setError({ field: "confirm", text: PASSWORD_MISMATCH });
      confirmRef.current?.focus();
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await settle(resetPassword({ token, password }));
      if (r.ok) {
        setPassword("");
        setConfirm("");
        setDone(true);
        return;
      }
      if (r.retryAfter) {
        startWait(r.retryAfter);
        return;
      }
      setError({ field: r.field === "password" ? "password" : undefined, text: r.error });
      if (r.field === "password") passwordRef.current?.focus();
    });
  };

  if (done) {
    return (
      <section className="auth-block">
        <AuthHead icon="checkCircle" title="Password changed" lead="The reset link is used up and every signed-in session was ended. Sign in with your new password." announce />
        <Link href="/login" className="btn btn-primary auth-submit auth-gap">
          <Icon name="lockOpen" />
          Go to sign in
        </Link>
      </section>
    );
  }

  return (
    <section className="auth-block">
      <AuthHead icon="key" title="New password" lead={<>For <span className="auth-wrap">{reset.email}</span>. Every other session ends once it is set.</>} />

      <form className="auth-form" onSubmit={submit} noValidate>
        <Field id="reset-password" label="New password" error={fieldError("password")} hint={<StrengthMeter password={password} />}>
          {(ids) => (
            <PasswordInput ids={ids} ref={passwordRef} name="new-password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          )}
        </Field>

        <Field id="reset-confirm" label="Confirm new password" error={fieldError("confirm")} hint={confirm && confirm === password ? <MatchHint /> : undefined}>
          {(ids) => (
            <PasswordInput
              ids={ids}
              ref={confirmRef}
              name="confirm-password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                if (error?.field === "confirm") setError(null);
              }}
            />
          )}
        </Field>

        <CooldownNotice seconds={wait} />
        {error && !error.field ? <Notice>{error.text}</Notice> : null}

        <SubmitButton icon="key" label="Set new password" pending={pending} disabled={wait > 0} />
      </form>

      <div className="auth-alt">
        <Link href="/login" className="auth-link auth-back">
          Back to sign in
        </Link>
      </div>
    </section>
  );
}
