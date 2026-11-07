"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/icon";
import { Callout } from "@/components/ui/callout";
import { Field, TextInput, type FieldIds } from "@/components/ui/field";
import { PendingLabel } from "@/components/ui/pending";
import { MIN_PASSWORD, scorePassword } from "@/lib/password";

/*
 * Auth-only controls on top of the shared fields: the password input with its show key and Caps
 * Lock chip, the checkbox row, the full-width CTA, the strength meter and the rate-limit notices.
 * Labels, hints and inline errors come from the shared Field.
 */

/** The email an account signs in with, focused on arrival: the first field of the sign in and reset forms. */
export function EmailField({ id, error, inputRef, value, onChange }: { id: string; error?: string; inputRef: React.Ref<HTMLInputElement>; value: string; onChange: (v: string) => void }) {
  return (
    <Field id={id} label="Email" error={error}>
      {(ids) => (
        <TextInput
          ids={ids}
          ref={inputRef}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/**
 * Password input with a show and hide key, and a Caps Lock chip while Caps Lock is on (read from
 * each key event, since the browser offers no event of its own for it).
 */
export function PasswordInput({
  autoComplete,
  onKeyDown,
  onKeyUp,
  onBlur,
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & { autoComplete: "current-password" | "new-password"; ids?: FieldIds }) {
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const readCaps = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (typeof e.getModifierState === "function") setCaps(e.getModifierState("CapsLock"));
  };

  return (
    <div className="auth-pw" data-caps={caps || undefined}>
      <TextInput
        {...props}
        type={shown ? "text" : "password"}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={(e) => {
          readCaps(e);
          onKeyDown?.(e);
        }}
        onKeyUp={(e) => {
          readCaps(e);
          onKeyUp?.(e);
        }}
        onBlur={(e) => {
          setCaps(false);
          onBlur?.(e);
        }}
      />
      <span className="auth-pw-end">
        {caps ? (
          <span className="auth-caps" role="status">
            <Icon name="arrowUp" size={12} />
            Caps Lock
          </span>
        ) : null}
        {/* One name; the pressed state says whether the password shows. */}
        <button type="button" className="auth-pw-eye" aria-label="Show password" aria-pressed={shown} onClick={() => setShown((s) => !s)}>
          <Icon name={shown ? "eyeOff" : "eye"} />
        </button>
      </span>
    </div>
  );
}

/**
 * The full-width primary CTA of an auth card. It leads with the glyph that names the action, which
 * turns into the loader while the request runs; the label never changes, so the key keeps its width.
 * It is aria-disabled rather than disabled, so a focused key keeps focus through the request.
 */
export function SubmitButton({
  icon,
  label,
  pending,
  disabled,
}: {
  icon: IconName;
  label: string;
  pending: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      className="btn btn-primary auth-submit"
      aria-disabled={pending || disabled || undefined}
      aria-busy={pending || undefined}
      data-pending={pending || undefined}
    >
      <PendingLabel pending={pending} icon={icon}>
        {label}
      </PendingLabel>
    </button>
  );
}

/* -------------- Password strength -------------- */

/**
 * Four bars and a word under a new password, the one strength meter (setup, invite, reset and
 * Settings). The policy and the score are lib/password.ts. A span, since it sits in the Field's hint line.
 */
export function StrengthMeter({ password }: { password: string }) {
  const { score, label, tone } = scorePassword(password);
  return (
    <span className="auth-meter" data-tone={tone}>
      <span className="auth-meter-bars" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} data-on={n <= score ? "" : undefined} />
        ))}
      </span>
      <span className="auth-meter-label" aria-live="polite">
        {score ? label : `At least ${MIN_PASSWORD} characters`}
      </span>
    </span>
  );
}

/** Under a confirm field once both passwords agree. */
export function MatchHint() {
  return (
    <span className="auth-match">
      <Icon name="check" size={14} />
      Passwords match
    </span>
  );
}

/* -------------- Notices and cooldowns -------------- */

/**
 * A message for the whole form: rate limits, an unreachable API, a finished reset. It is the shared
 * callout (info is its neutral grey), written out here because an error has to stay an alert and
 * the rest a status, while the Callout component always says note.
 */
export function Notice({
  tone = "bad",
  icon,
  children,
}: {
  tone?: "bad" | "info" | "ok";
  icon?: IconName;
  children: React.ReactNode;
}) {
  return (
    <Callout tone={tone === "info" ? undefined : tone} icon={icon ?? (tone === "ok" ? "checkCircle" : tone === "info" ? "info" : "alert")} role={tone === "bad" ? "alert" : "status"}>
      {children}
    </Callout>
  );
}

/** Seconds as the rate-limit wait: "45s" under a minute, then a ticking "1:59". */
export function waitLabel(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Counts a rate-limit wait down to zero, one tick a second. */
export function useCooldown(): [number, (seconds: number) => void] {
  const [until, setUntil] = useState(0);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (!until) return;
    const tick = () => {
      const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setLeft(s);
      if (!s) setUntil(0);
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [until]);

  const start = useCallback((seconds: number) => setUntil(Date.now() + seconds * 1000), []);
  return [left, start];
}

/** The rate-limit notice, shown while a cooldown runs. */
export function CooldownNotice({ seconds }: { seconds: number }) {
  return seconds ? <CooldownLive seconds={seconds} /> : null;
}

/*
 * The notice is an alert, and an alert re-announces whenever its text changes, so the ticking
 * figure is hidden from screen readers and they hear the wait once, as it stood on arrival.
 */
function CooldownLive({ seconds }: { seconds: number }) {
  const [first] = useState(seconds);
  return (
    <Notice icon="clock">
      <span aria-hidden="true">
        Too many attempts. Try again in <span className="num">{waitLabel(seconds)}</span>.
      </span>
      <span className="sr">Too many attempts. Try again in {waitLabel(first)}.</span>
    </Notice>
  );
}
