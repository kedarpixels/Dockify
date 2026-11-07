"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { requestPasswordReset } from "@/lib/pages/auth";
import { AuthHead } from "./auth-head";
import { CooldownNotice, EmailField, Notice, SubmitButton, useCooldown } from "./fields";
import { settle } from "./util";

/**
 * /forgot: asks for a reset link by email. The answer is the same whether or not the address has
 * an account, so the sent state never says which. Only while email is set up (the page redirects
 * to /recover otherwise).
 */
export function ForgotView() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<{ field: boolean; text: string } | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [wait, startWait] = useCooldown();
  const [pending, startTransition] = useTransition();
  const emailRef = useRef<HTMLInputElement>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pending || wait) return;
    setError(null);
    startTransition(async () => {
      const r = await settle(requestPasswordReset({ email }));
      if (r.ok) {
        setSentTo(email.trim());
        return;
      }
      if (r.retryAfter) {
        startWait(r.retryAfter);
        return;
      }
      setError({ field: r.field === "email", text: r.error });
      emailRef.current?.focus();
    });
  };

  if (sentTo) {
    return (
      <section className="auth-block">
        <AuthHead
          icon="mail"
          title="Check your email"
          lead="If that address has an account, a link is on its way. It works once, for 30 minutes."
          announce
        />
        <dl className="auth-invite">
          <div>
            <dt>Sent to</dt>
            <dd className="auth-wrap">{sentTo}</dd>
          </div>
        </dl>
        <p className="auth-text auth-gap">Nothing after a few minutes? Check the spam folder, and check that this is the address you sign in with.</p>
        <div className="auth-alt">
          <button type="button" className="auth-link" onClick={() => setSentTo(null)}>
            Try another address
          </button>
          <Link href="/login" className="auth-link auth-back">
            Back to sign in
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="auth-block">
      <AuthHead icon="key" title="Forgot password" lead="Enter the email you sign in with. Dockify sends a link to choose a new password to that address." />

      <form className="auth-form" onSubmit={submit} noValidate>
        <EmailField id="forgot-email" error={error?.field ? error.text : undefined} inputRef={emailRef} value={email} onChange={setEmail} />

        <CooldownNotice seconds={wait} />
        {error && !error.field ? <Notice>{error.text}</Notice> : null}

        <SubmitButton icon="mail" label="Send reset link" pending={pending} disabled={wait > 0} />
      </form>

      <div className="auth-alt">
        <Link href="/login" className="auth-link auth-back">
          Back to sign in
        </Link>
      </div>
    </section>
  );
}
