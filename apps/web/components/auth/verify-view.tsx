"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { verifySecondFactor } from "@/lib/pages/auth";
import { AuthHead } from "./auth-head";
import { Field } from "@/components/ui/field";
import { CooldownNotice, Notice, SubmitButton, useCooldown } from "./fields";
import { OtpInput, type OtpHandle } from "./otp-input";
import { localDestination, settle, withNext } from "./util";

/**
 * /login/verify: the second factor after a correct password. Six boxes for the authenticator code,
 * sent as soon as the sixth digit lands. A lost authenticator is reset by whoever runs the server;
 * Reset two-factor shows the command (/recover).
 */
export function VerifyView({ next }: { next: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<{ field: boolean; text: string } | null>(null);
  const [wait, startWait] = useCooldown();
  const [pending, startTransition] = useTransition();
  // Set once the code passes: nothing can send it again while the console loads.
  const [leaving, setLeaving] = useState(false);
  const otpRef = useRef<OtpHandle>(null);

  const send = (value: string) => {
    if (pending || leaving || wait || value.length !== 6) return;
    setError(null);
    startTransition(async () => {
      const r = await settle(verifySecondFactor({ code: value }));
      if (r.ok) {
        setLeaving(true);
        router.replace(localDestination(next));
        return;
      }
      if (r.retryAfter) startWait(r.retryAfter);
      else setError({ field: Boolean(r.field), text: r.error });
      // A wrong code clears so the next one goes straight in.
      setCode("");
      otpRef.current?.focus();
    });
  };

  const fieldError = error?.field ? error.text : undefined;

  return (
    <section className="auth-block">
      <AuthHead icon="shieldCheck" title="Two-factor check" lead="Enter the 6-digit code from your authenticator app." />

      <form
        className="auth-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          send(code);
        }}
      >
        <Field id="verify-code" label="Authenticator code" error={fieldError} hint="The 6-digit code from your authenticator app.">
          {(ids) => (
            <OtpInput
              ref={otpRef}
              id={ids.id}
              describedBy={ids.describedBy}
              invalid={ids.invalid}
              value={code}
              onChange={(v) => {
                setCode(v);
                if (error?.field) setError(null);
              }}
              onComplete={send}
              disabled={wait > 0}
              autoFocus
              label="Authenticator code"
            />
          )}
        </Field>

        <CooldownNotice seconds={wait} />
        {error && !error.field ? <Notice>{error.text}</Notice> : null}

        <SubmitButton icon="shieldCheck" label="Verify" pending={pending || leaving} disabled={wait > 0 || code.length !== 6} />
      </form>

      <div className="auth-alt">
        <Link href="/recover" className="auth-link">
          Reset two-factor
        </Link>
        <Link href={withNext("/login", next)} className="auth-link auth-back">
          Back to sign in
        </Link>
      </div>
    </section>
  );
}
