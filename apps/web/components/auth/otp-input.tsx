"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

const LEN = 6;

export interface OtpHandle {
  focus: () => void;
}

/**
 * Six equal boxes for an authenticator code, backed by ONE real input laid over them. That one
 * input is what makes it dependable: typing, Backspace, paste, the phone number pad and the
 * one-time-code autofill all behave natively, and the boxes only draw its value. The caret is
 * pinned to the end, so digits always fill left to right with no gaps. `onComplete` fires once
 * per code, when the sixth digit lands.
 */
export const OtpInput = forwardRef<
  OtpHandle,
  {
    value: string;
    onChange: (value: string) => void;
    onComplete?: (value: string) => void;
    invalid?: boolean;
    disabled?: boolean;
    autoFocus?: boolean;
    describedBy?: string;
    id?: string;
    label?: string;
  }
>(function OtpInput({ value, onChange, onComplete, invalid, disabled, autoFocus, describedBy, id, label = "6-digit code" }, ref) {
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  // The code last handed to onComplete: a repeated input event for the same six digits (some
  // autofills send two) must not submit twice. Cleared once the value is no longer complete.
  const fired = useRef<string | null>(null);

  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  // autoFocus lands before hydration, so no focus event fires: read it once on mount.
  useEffect(() => {
    if (document.activeElement === input.current) setFocused(true);
  }, []);

  // Keep the caret after the last digit: clicks and arrow keys never open a gap in the middle.
  // Select all (Ctrl+A, a double click) is left alone, so a new code can replace the old one.
  const pinCaret = () => {
    const el = input.current;
    if (!el) return;
    const end = el.value.length;
    const all = el.selectionStart === 0 && el.selectionEnd === end && end > 0;
    if (!all && (el.selectionStart !== end || el.selectionEnd !== end)) el.setSelectionRange(end, end);
  };

  useEffect(() => {
    if (value.length < LEN) fired.current = null;
  }, [value]);

  // Digits only, at most six: a formatted code ("123 456", "123-456") pastes, autofills or drops in
  // whole, which is why the input carries no maxLength (it would cut such a code short).
  const set = (raw: string) => {
    if (disabled) return;
    const next = raw.replace(/\D/g, "").slice(0, LEN);
    if (next === value) return;
    onChange(next);
    if (next.length === LEN && fired.current !== next) {
      fired.current = next;
      onComplete?.(next);
    }
  };

  // The box that would take the next digit; all six done keeps the last one lit.
  const active = Math.min(value.length, LEN - 1);

  return (
    <div className="auth-otp" data-invalid={invalid || undefined} data-disabled={disabled || undefined}>
      <input
        ref={input}
        id={id}
        className="auth-otp-input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoFocus={autoFocus}
        // Read-only while a code is checked, never disabled: a disabled input drops the focus, so
        // after a wrong code the next digit would land nowhere.
        readOnly={disabled}
        aria-disabled={disabled || undefined}
        spellCheck={false}
        value={value}
        onChange={(e) => set(e.target.value)}
        onPaste={(e) => {
          // A pasted code replaces what was there, whatever spaces or dashes it carries.
          e.preventDefault();
          const digits = e.clipboardData.getData("text").replace(/\D/g, "");
          if (digits) set(digits);
        }}
        onFocus={() => {
          setFocused(true);
          requestAnimationFrame(pinCaret);
        }}
        onBlur={() => setFocused(false)}
        onSelect={pinCaret}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") e.preventDefault();
        }}
      />
      {Array.from({ length: LEN }, (_, i) => (
        <span
          key={i}
          className="auth-otp-box"
          aria-hidden="true"
          data-filled={value[i] ? "" : undefined}
          data-active={focused && i === active ? "" : undefined}
        >
          {value[i] ?? (focused && i === active ? <span className="auth-otp-caret" /> : null)}
        </span>
      ))}
    </div>
  );
});
