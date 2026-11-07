"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { Icon } from "@/components/icon";
import { elevate } from "@/components/step-up/step-up";
import { Rule } from "@/components/ui/rule";
import { enableTotp, startTotp, type TotpSecret } from "@/lib/pages/auth";
import { AuthHead } from "./auth-head";
import { CopyButton } from "@/components/ui/copy-button";
import { Field } from "@/components/ui/field";
import { CooldownNotice, Notice, SubmitButton, useCooldown } from "./fields";
import { OtpInput, type OtpHandle } from "./otp-input";
import { PseudoQr } from "./pseudo-qr";
import { settle } from "./util";

/* Base32 key in groups of four, the way authenticator apps show it. */
const groups = (secret: string) => secret.match(/.{1,4}/g) ?? [];

/**
 * Optional step after an account is made (setup and invites): add Dockify to an authenticator
 * app and confirm one code. Skipping is fine; Settings can do it later. Both calls are elevated:
 * the new session starts with a step-up (lib/pages/auth.ts), and once that has lapsed they ask
 * "Confirm it is you" (components/step-up).
 */
export function ProtectStep({ step, onEnabled, onSkip }: { step?: [number, number]; onEnabled: () => void; onSkip: () => void }) {
  const [key, setKey] = useState<TotpSecret | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [wait, startWait] = useCooldown();
  const [pending, startTransition] = useTransition();
  const otpRef = useRef<OtpHandle>(null);

  // One fresh secret per visit to this step (and per retry). Results land only in the callback.
  useEffect(() => {
    let live = true;
    void elevate(() => settle(startTotp()), { what: "Setting up two-factor" }).then((r) => {
      if (!live) return;
      if (r.ok) setKey({ secret: r.secret, uri: r.uri, qrDataUrl: r.qrDataUrl, preview: r.preview });
      else setLoadError(r.error);
    });
    return () => {
      live = false;
    };
  }, [attempt]);

  const confirm = (value: string) => {
    if (pending || wait || !key || value.length < 6) return;
    setError(null);
    startTransition(async () => {
      const r = await elevate(() => settle(enableTotp({ code: value })), { what: "Turning on two-factor" });
      if (r.ok) {
        onEnabled();
        return;
      }
      if (r.retryAfter) startWait(r.retryAfter);
      else setError(r.error);
      setCode("");
      otpRef.current?.focus();
    });
  };

  return (
    <>
      <section className="auth-block">
        <AuthHead
          icon="shield"
          step={step}
          title="Set up two-factor"
          lead="Optional, and worth the minute. Add Dockify to an authenticator app such as 1Password, Google Authenticator or Authy."
          announce
        />

        {loadError ? (
          <div className="auth-form">
            <Notice>{loadError}</Notice>
            <div className="auth-pair">
              <button type="button" className="btn" onClick={onSkip}>
                Skip for now
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setLoadError(null);
                  setAttempt((n) => n + 1);
                }}
              >
                <Icon name="refresh" />
                Try again
              </button>
            </div>
          </div>
        ) : (
          <div className="auth-enroll">
            <div className="auth-enroll-top">
              {/* A real QR when the API renders one; the stand-in grid in the design preview only. */}
              {key?.qrDataUrl ? (
                <img className="auth-qr-img" src={key.qrDataUrl} alt="QR code for your authenticator app" width={124} height={124} />
              ) : key?.preview ? (
                <PseudoQr secret={key.secret} />
              ) : (
                <div className="auth-qr auth-qr-empty" aria-hidden="true">
                  {key ? <Icon name="key" /> : <Icon name="loader" className="spin" />}
                </div>
              )}
              <ol className="auth-how">
                <li>
                  <span className="step-n num" aria-hidden="true">
                    1
                  </span>
                  <span>
                    <strong>Scan the code</strong> with an authenticator app.
                  </span>
                </li>
                <li>
                  <span className="step-n num" aria-hidden="true">
                    2
                  </span>
                  <span>
                    <strong>Cannot scan it?</strong> Enter the setup key instead.
                  </span>
                </li>
                <li>
                  <span className="step-n num" aria-hidden="true">
                    3
                  </span>
                  <span>
                    <strong>Enter the code</strong> the app shows to turn it on.
                  </span>
                </li>
              </ol>
            </div>

            <div className="auth-key">
              <div className="auth-label-row">
                <span className="fld-label" id="protect-key-label">
                  Setup key
                </span>
                {key ? (
                  <a href={key.uri} className="auth-link">
                    Open in app
                  </a>
                ) : null}
              </div>
              <div className="auth-key-box">
                {/* Named by the visible label above; a name on <code> would hide the key it holds. */}
                {key ? (
                  <code className="auth-key-text">
                    {groups(key.secret).map((g, i) => (
                      <span key={i}>{g}</span>
                    ))}
                  </code>
                ) : (
                  <span className="auth-key-wait" aria-live="polite">
                    Preparing a key…
                  </span>
                )}
                {key ? <CopyButton value={key.secret} what="setup key" align="end" /> : null}
              </div>
            </div>
          </div>
        )}
      </section>

      {loadError ? null : (
        <>
          <Rule />
          <section className="auth-block">
            <form
              className="auth-form auth-form-flush"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                confirm(code);
              }}
            >
              <Field id="protect-code" label="Authenticator code" hint="The 6-digit code from your authenticator app." error={error}>
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
                    disabled={wait > 0 || !key}
                    label="Authenticator code"
                  />
                )}
              </Field>

              <CooldownNotice seconds={wait} />

              <div className="auth-pair">
                {/* Not while a code is checked: a late success would turn two-factor on after the skip. */}
                <button type="button" className="btn" onClick={onSkip} disabled={pending}>
                  Skip for now
                </button>
                <SubmitButton
                  icon="shieldCheck"
                  label="Turn on two-factor"
                  pending={pending}
                  disabled={wait > 0 || !key || code.length < 6}
                />
              </div>
            </form>
          </section>
        </>
      )}
    </>
  );
}

/** Last card: the account is ready. */
export function DoneStep({ lead }: { lead: string }) {
  return (
    <section className="auth-block">
      <AuthHead icon="checkCircle" title="You are all set" lead={lead} announce />
      <Link href="/" className="btn btn-primary auth-submit auth-gap">
        <Icon name="overview" />
        Open dashboard
      </Link>
    </section>
  );
}
