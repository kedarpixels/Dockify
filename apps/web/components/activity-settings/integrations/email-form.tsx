"use client";

import { useId, useState } from "react";
import { useStepUp } from "@/components/step-up/step-up";
import { Field, TextInput } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { describe, errText, report } from "@/lib/feedback";
import type { EmailInput, EmailIntegration } from "@/lib/pages/integrations";
import { isStepUpCancel } from "@/lib/step-up";
import { intFetch } from "./client";
import { EMAIL_ERROR_FIELD, EMAIL_PORTS, EMAIL_PRESETS, emailFormErrors, keepsPassword, presetOfHost, tlsModeFor, type EmailFormField, type EmailTlsMode } from "./email-rules";

/* One form for the Settings dialog and first-run setup: the caller supplies the frame and the keys. */

const TLS_OPTIONS: { value: EmailTlsMode; label: string }[] = [
  { value: "implicit", label: "Implicit TLS" },
  { value: "starttls", label: "STARTTLS" },
];
const PORT_OPTIONS = EMAIL_PORTS.map((p) => ({ value: String(p), label: String(p) }));
const CUSTOM = "custom";
const PRESET_OPTIONS = [{ value: CUSTOM, label: "Another server" }, ...EMAIL_PRESETS.map((p) => ({ value: p.id, label: p.label }))];

type Elevate = ReturnType<typeof useStepUp>["elevate"];

/** With `body` the form places the failure on its field and the toast only says it failed; without, the toast says why. */
export async function sendTestEmail(elevate: Elevate, preview: boolean, body?: EmailInput): Promise<{ ok: boolean; code?: string; error?: string }> {
  const r = await elevate(() => intFetch<{ to: string }>("/email/test", { method: "POST", body: body ?? {} }), { what: "Sending a test email" });
  if (r.ok) {
    toast.success("Test email sent", { description: describe([`To ${r.data.to}`, "Check the inbox and the spam folder"], { preview }) });
    return { ok: true };
  }
  if (isStepUpCancel(r)) return { ok: false };
  const placed = body && r.code && EMAIL_ERROR_FIELD[r.code];
  toast.error("Test email failed", placed ? {} : { description: describe(errText(r.error)) });
  return { ok: false, ...(r.code ? { code: r.code } : {}), error: r.error };
}

/** An empty password keeps the stored one for the same host and username. `autoFocus` is for a form outside a dialog. */
export function useEmailForm({ editing, onDone, preview, autoFocus = false }: { editing: EmailIntegration | null; onDone: (v: EmailIntegration) => void; preview: boolean; autoFocus?: boolean }) {
  const { elevate } = useStepUp();
  const [host, setHost] = useState(editing?.host ?? "");
  const [port, setPort] = useState(editing?.port ?? 587);
  const [tlsMode, setTlsMode] = useState<EmailTlsMode>(editing?.tlsMode ?? tlsModeFor(587));
  const [username, setUsername] = useState(editing?.username ?? "");
  const [password, setPassword] = useState("");
  const [fromName, setFromName] = useState(editing?.fromName ?? "Dockify");
  const [fromAddress, setFromAddress] = useState(editing?.fromAddress ?? "");
  const [replyTo, setReplyTo] = useState(editing?.replyTo ?? "");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tried, setTried] = useState(false);
  /** What the API last said about one field, until that field changes. */
  const [refused, setRefused] = useState<{ field: EmailFormField; message: string } | null>(null);

  const stored = editing ? { host: editing.host, username: editing.username, hasPassword: editing.hasPassword } : null;
  const values = { host, port, tlsMode, username, password, fromName, fromAddress, replyTo };
  const errors = emailFormErrors(values, stored);
  const valid = Object.values(errors).every((e) => !e);
  const shown = (field: EmailFormField) => (tried ? errors[field] : null) ?? (refused?.field === field ? refused.message : null);
  const changed = (field: EmailFormField) => setRefused((r) => (r?.field === field ? null : r));
  const preset = presetOfHost(host);
  const portNote = useId();

  const pickPreset = (id: string) => {
    const p = EMAIL_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setHost(p.host);
    setPort(p.port);
    setTlsMode(tlsModeFor(p.port));
    // A fixed username is filled in; one that is the owner's own stays theirs to type.
    setUsername(p.username);
    setRefused(null);
  };
  const pickPort = (next: number) => {
    setPort(next);
    setTlsMode(tlsModeFor(next));
    setRefused(null);
  };

  const body = (): EmailInput => ({
    host: host.trim().toLowerCase(),
    port,
    tlsMode,
    username: username.trim(),
    ...(password ? { password } : {}),
    fromName: fromName.trim(),
    fromAddress: fromAddress.trim(),
    replyTo: replyTo.trim() || null,
  });
  const place = (code: string | undefined, message: string | undefined): boolean => {
    const field = code ? EMAIL_ERROR_FIELD[code] : undefined;
    if (field && message) setRefused({ field, message });
    return !!(field && message);
  };

  const submit = async () => {
    setTried(true);
    if (!valid || busy) return;
    setBusy(true);
    setRefused(null);
    const r = await elevate(() => intFetch<EmailIntegration>("/email", { method: "PUT", body: body() }), { what: "Changing how email is sent" });
    setBusy(false);
    if (!r.ok && !isStepUpCancel(r) && place(r.code, r.error)) {
      toast.error(editing ? "Could not save email settings" : "Could not connect email");
      return;
    }
    report(r, {
      success: editing ? "Email settings saved" : "Email connected",
      error: editing ? "Could not save email settings" : "Could not connect email",
      what: r.ok ? r.data.fromAddress : undefined,
      preview,
    });
    if (!r.ok) return;
    // Stored now, so a form still on screen must not hold on to the secret.
    setPassword("");
    setTried(false);
    onDone(r.data);
  };

  const test = async () => {
    setTried(true);
    if (!valid || testing) return;
    setTesting(true);
    setRefused(null);
    const r = await sendTestEmail(elevate, preview, body());
    setTesting(false);
    if (!r.ok) place(r.code, r.error);
  };

  const fields = (
    <>
      <Field label="Provider" hint="Fills in the server settings below. Nothing else depends on it.">
        {(ids) => <Select ids={ids} label="Provider" value={preset?.id ?? CUSTOM} options={PRESET_OPTIONS} onChange={pickPreset} />}
      </Field>
      <div className="int-form-grid int-mail-server">
        <Field label="Host" error={shown("host")}>
          {(ids) => (
            <TextInput
              ids={ids}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              placeholder="smtp.example.com"
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
                changed("host");
              }}
              data-autofocus
              autoFocus={autoFocus}
            />
          )}
        </Field>
        {/* The port's error is a long sentence: it runs under the whole row, not down this narrow column. */}
        <Field label="Port">
          {(ids) => <Select ids={{ ...ids, invalid: Boolean(shown("port")), describedBy: shown("port") ? portNote : ids.describedBy }} label="Port" value={String(port)} options={PORT_OPTIONS} onChange={(v) => pickPort(Number(v))} />}
        </Field>
        {shown("port") ? (
          <p id={portNote} className="fld-note fld-error int-mail-port-error" role="alert">
            {shown("port")}
          </p>
        ) : null}
      </div>
      <Field label="TLS" hint="Always on. Mail and passwords never cross an unencrypted connection." error={shown("tlsMode")}>
        {(ids) => (
          <Select
            ids={ids}
            label="TLS"
            value={tlsMode}
            options={TLS_OPTIONS}
            onChange={(v) => {
              setTlsMode(v);
              changed("tlsMode");
            }}
          />
        )}
      </Field>
      <div className="int-form-grid">
        <Field label="Username" hint={preset?.usernameHint} error={shown("username")}>
          {(ids) => (
            <TextInput
              ids={ids}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                changed("username");
                changed("password");
              }}
            />
          )}
        </Field>
        <Field label="Password" hint={keepsPassword(values, stored) ? "Leave empty to keep the stored one." : preset?.passwordHint} error={shown("password")}>
          {(ids) => (
            <TextInput
              ids={ids}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                changed("password");
              }}
            />
          )}
        </Field>
      </div>
      <div className="int-form-grid">
        <Field label="From name" hint="Shown as the sender in inboxes." error={shown("fromName")}>
          {(ids) => <TextInput ids={ids} maxLength={60} value={fromName} onChange={(e) => setFromName(e.target.value)} />}
        </Field>
        <Field label="From address" hint="One your provider lets you send from." error={shown("fromAddress")}>
          {(ids) => (
            <TextInput
              ids={ids}
              type="email"
              inputMode="email"
              spellCheck={false}
              autoCapitalize="none"
              placeholder="dockify@example.com"
              value={fromAddress}
              onChange={(e) => {
                setFromAddress(e.target.value);
                changed("fromAddress");
              }}
            />
          )}
        </Field>
      </div>
      <Field label="Reply-to address" hint="Optional. Where replies go; empty sends them to the from address." error={shown("replyTo")}>
        {(ids) => (
          <TextInput ids={ids} type="email" inputMode="email" spellCheck={false} autoCapitalize="none" placeholder="ops@example.com" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} />
        )}
      </Field>
      <div className="int-mail-keys">
        <PendingButton className="btn" onClick={() => void test()} pending={testing} disabled={busy}>
          Send test email
        </PendingButton>
        <span className="fld-note">Tries these settings without saving. The test goes to your own address.</span>
      </div>
    </>
  );

  return { fields, submit, busy: busy || testing };
}
