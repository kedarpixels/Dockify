"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { signIn, type AuthField } from "@/lib/pages/auth";
import { AuthHead } from "./auth-head";
import { Field } from "@/components/ui/field";
import { CooldownNotice, EmailField, Notice, PasswordInput, SubmitButton, useCooldown } from "./fields";
import { localDestination, settle, withNext } from "./util";

export type LoginReason = "expired" | "signed-out";

/** With email set up the foot link is Forgot password; without it, Lost access goes to /recover. */
export function LoginView({
  instanceName,
  next,
  notice,
  reason,
  emailEnabled = false,
}: {
  instanceName?: string;
  next: string;
  notice?: string;
  reason?: LoginReason;
  emailEnabled?: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<{ field?: AuthField; text: string } | null>(null);
  const [wait, startWait] = useCooldown();
  const [pending, startTransition] = useTransition();
  // Set once sign in succeeds: the CTA stays busy and Enter stays inert until the next page lands.
  const [leaving, setLeaving] = useState(false);
  // The arrival note (session ended, signed out) only stands until the first attempt.
  const [arrival, setArrival] = useState(reason);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const fieldError = (f: AuthField) => (error?.field === f ? error.text : undefined);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pending || leaving || wait) return;
    setError(null);
    setArrival(undefined);
    startTransition(async () => {
      const r = await settle(signIn({ email, password }));
      if (r.ok) {
        setLeaving(true);
        router.push(r.next === "verify" ? withNext("/login/verify", localDestination(next)) : localDestination(next));
        return;
      }
      if (r.retryAfter) {
        startWait(r.retryAfter);
        return;
      }
      setError({ field: r.field, text: r.error });
      const el = r.field === "email" ? emailRef.current : passwordRef.current;
      el?.focus();
      if (r.field === "password") el?.select();
    });
  };

  return (
    <section className="auth-block">
      <AuthHead icon="lock" title="Sign in" lead={instanceName ? `Welcome back to ${instanceName}.` : "Welcome back."} />

      <form className="auth-form" onSubmit={submit} noValidate>
        {notice ? <Notice tone="info">{notice}</Notice> : null}
        {!notice && arrival === "expired" ? (
          <Notice tone="info" icon="clock">
            Your session ended. Sign in again to pick up where you left off.
          </Notice>
        ) : null}
        {!notice && arrival === "signed-out" ? <Notice tone="ok">You are signed out.</Notice> : null}

        <EmailField id="login-email" error={fieldError("email")} inputRef={emailRef} value={email} onChange={setEmail} />

        <Field id="login-password" label="Password" error={fieldError("password")}>
          {(ids) => (
            <PasswordInput
              ids={ids}
              ref={passwordRef}
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>

        <CooldownNotice seconds={wait} />
        {error && !error.field ? <Notice>{error.text}</Notice> : null}

        <SubmitButton icon="lockOpen" label="Sign in" pending={pending || leaving} disabled={wait > 0} />
      </form>

      {/* The way back in sits under the form as its quiet foot line, after Sign in in the tab order. */}
      <p className="auth-foot">
        <Link href={emailEnabled ? "/forgot" : "/recover"} className="auth-link">
          {emailEnabled ? "Forgot password?" : "Lost access?"}
        </Link>
      </p>
    </section>
  );
}
