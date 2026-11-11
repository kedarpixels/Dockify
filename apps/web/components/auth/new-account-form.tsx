"use client";

import { type ReactNode, useRef, useState, useTransition } from "react";
import type { IconName } from "@/components/icon";
import type { AuthField, AuthResult } from "@/lib/pages/auth";
import { Field, TextInput } from "@/components/ui/field";
import { MIN_PASSWORD, PASSWORD_MISMATCH, SHORT_PASSWORD } from "@/lib/password";
import { CooldownNotice, MatchHint, Notice, PasswordInput, StrengthMeter, SubmitButton, useCooldown } from "./fields";
import { settle } from "./util";

export interface NewAccountValues {
  instanceName: string;
  name: string;
  email: string;
  password: string;
}

/** Shared by /setup and /invite. Setup also names the instance; an invite fixes the email. */
export function NewAccountForm({
  idPrefix,
  askInstance,
  initialInstance,
  fixedEmail,
  topSlot,
  submitIcon,
  submitLabel,
  onSubmit,
  onDone,
}: {
  idPrefix: string;
  askInstance?: boolean;
  initialInstance?: string;
  fixedEmail?: string;
  /** Rendered at the top of the form, before the instance field (the setup token on first run). */
  topSlot?: ReactNode;
  submitIcon: IconName;
  submitLabel: string;
  onSubmit: (values: NewAccountValues) => Promise<AuthResult>;
  onDone: (values: Omit<NewAccountValues, "password">) => void;
}) {
  const [values, setValues] = useState<NewAccountValues>({ instanceName: initialInstance ?? "", name: "", email: fixedEmail ?? "", password: "" });
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<{ field?: AuthField | "confirm"; text: string } | null>(null);
  const [wait, startWait] = useCooldown();
  const [pending, startTransition] = useTransition();
  const form = useRef<HTMLFormElement>(null);

  const id = (f: string) => `${idPrefix}-${f}`;
  const fieldError = (f: AuthField | "confirm") => (error?.field === f ? error.text : undefined);
  const set = (k: keyof NewAccountValues) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [k]: e.target.value }));
  const focusField = (f: string) => form.current?.querySelector<HTMLInputElement>(`#${id(f)}`)?.focus();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pending || wait) return;
    if (values.password.length < MIN_PASSWORD) {
      setError({ field: "password", text: SHORT_PASSWORD });
      focusField("password");
      return;
    }
    if (confirm !== values.password) {
      setError({ field: "confirm", text: PASSWORD_MISMATCH });
      focusField("confirm");
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await settle(onSubmit(values));
      if (r.ok) {
        setValues((v) => ({ ...v, password: "" }));
        setConfirm("");
        onDone({ instanceName: values.instanceName, name: values.name, email: values.email });
        return;
      }
      if (r.retryAfter) {
        startWait(r.retryAfter);
        return;
      }
      setError({ field: r.field, text: r.error });
      if (r.field) focusField(r.field);
    });
  };

  return (
    <form ref={form} className="auth-form" onSubmit={submit} noValidate>
      {topSlot}
      {askInstance ? (
        <Field id={id("instanceName")} label="Instance name" error={fieldError("instanceName")} hint="Shown on the sign-in page, in invites and in emails, for example Acme Cloud.">
          {(ids) => <TextInput ids={ids} name="instance" autoComplete="off" autoFocus value={values.instanceName} onChange={set("instanceName")} />}
        </Field>
      ) : null}

      <Field id={id("name")} label="Your name" error={fieldError("name")}>
        {(ids) => <TextInput ids={ids} name="name" autoComplete="name" autoFocus={!askInstance} value={values.name} onChange={set("name")} />}
      </Field>

      <Field id={id("email")} label="Email" error={fieldError("email")} hint={fixedEmail ? "The invite is for this address, so it cannot be changed." : undefined}>
        {(ids) => (
          <TextInput
            ids={ids}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            readOnly={Boolean(fixedEmail)}
            value={values.email}
            onChange={set("email")}
          />
        )}
      </Field>

      <Field id={id("password")} label="Password" error={fieldError("password")} hint={<StrengthMeter password={values.password} />}>
        {(ids) => <PasswordInput ids={ids} name="new-password" autoComplete="new-password" value={values.password} onChange={set("password")} />}
      </Field>

      <Field
        id={id("confirm")}
        label="Confirm password"
        error={fieldError("confirm")}
        hint={confirm && confirm === values.password ? <MatchHint /> : undefined}
      >
        {(ids) => (
          <PasswordInput
            ids={ids}
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

      <SubmitButton icon={submitIcon} label={submitLabel} pending={pending} disabled={wait > 0} />
    </form>
  );
}
