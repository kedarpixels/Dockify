"use client";

import { useState } from "react";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { PendingButton } from "@/components/ui/pending";
import { When } from "@/components/ui/when";
import { report } from "@/lib/feedback";
import type { EmailIntegration } from "@/lib/pages/integrations";
import { Facts, FormKeys, IntegrationCard } from "./card";
import { intFetch, type Setter } from "./client";
import { sendTestEmail, useEmailForm } from "./email-form";
import { useStepUp } from "@/components/step-up/step-up";
import { clause } from "@/lib/format";

/* Optional, one per install. The password is write-only: nothing of it comes back. */

function EmailForm({ editing, onDone, onCancel, preview }: { editing: EmailIntegration | null; onDone: (v: EmailIntegration) => void; onCancel: () => void; preview: boolean }) {
  const { fields, submit, busy } = useEmailForm({ editing, onDone, preview });

  return (
    <Dialog
      open
      onClose={onCancel}
      title={editing ? "Edit email" : "Connect email"}
      sub="Sent through your own mail server"
      icon="mail"
      size="lg"
      busy={busy}
      onSubmit={() => void submit()}
      footer={
        <FormKeys onCancel={onCancel} busy={busy} icon={editing ? "check" : "link"}>
          {editing ? "Save" : "Connect"}
        </FormKeys>
      }
    >
      {fields}
    </Dialog>
  );
}

export function EmailCard({ value, onChange, now, preview }: { value: EmailIntegration | null; onChange: Setter<EmailIntegration | null>; now: number; preview: boolean }) {
  const { elevate } = useStepUp();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const test = async () => {
    if (testing || !value) return;
    setTesting(true);
    if ((await sendTestEmail(elevate, preview)).ok) onChange((v) => v && { ...v, error: null });
    setTesting(false);
  };

  const disconnect = async () => {
    const r = await elevate(() => intFetch<{ ok: true }>("/email", { method: "DELETE" }), { what: "Disconnecting email" });
    report(r, { success: "Email disconnected", error: "Could not disconnect email", what: value?.fromAddress, preview });
    if (!r.ok) throw new Error(r.error);
    onChange(null);
    setOpen(false);
  };

  const status = !value ? "disconnected" : value.error ? "error" : "connected";

  return (
    <>
      <IntegrationCard
        id="int-email"
        icon="mail"
        name="Email"
        purpose="Invites, resets, codes and alerts, through your own mail server."
        status={status}
        meta={value ? (value.error ?? value.fromAddress) : null}
      >
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
          {value ? "Manage" : "Connect"}
        </button>
      </IntegrationCard>

      {open && (!value || editing) ? (
        <EmailForm
          editing={value}
          preview={preview}
          onCancel={() => (value ? setEditing(false) : setOpen(false))}
          onDone={(v) => {
            onChange(v);
            setEditing(false);
          }}
        />
      ) : null}

      <Dialog
        open={open && value !== null && !editing}
        onClose={() => setOpen(false)}
        title="Email"
        sub={value ? `${value.fromName}, ${value.fromAddress}` : undefined}
        icon="mail"
        size="lg"
        footer={
          <>
            <button type="button" className="btn int-ft-start" onClick={() => setLeaving(true)}>
              Disconnect
            </button>
            <button type="button" className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Done
            </button>
          </>
        }
      >
        {value ? (
          <>
            {value.error ? (
              <Callout tone="warn" icon="alert">
                {clause(value.error)}. Edit the settings to fix it.
              </Callout>
            ) : null}
            <Facts
              items={[
                { label: "Server", value: <span className="int-wrap">{`${value.host}, port ${value.port}`}</span> },
                { label: "TLS", value: value.tlsMode === "implicit" ? "Implicit TLS" : "STARTTLS" },
                { label: "Username", value: <span className="int-wrap">{value.username}</span> },
                { label: "Password", value: value.hasPassword ? "Stored, sealed" : <span className="none">Missing</span> },
                { label: "From", value: <span className="int-wrap">{`${value.fromName}, ${value.fromAddress}`}</span> },
                { label: "Reply-to", value: value.replyTo ? <span className="int-wrap">{value.replyTo}</span> : <span className="none">Same as from</span> },
                { label: "Connected", value: <When iso={value.connectedAt} now={now} /> },
              ]}
            />
            <div className="int-mail-keys">
              <PendingButton className="btn" onClick={() => void test()} pending={testing}>
                Send test email
              </PendingButton>
              <span className="fld-note">The test goes to your own address.</span>
            </div>
          </>
        ) : null}
      </Dialog>

      {/* Connecting again undoes it, so the default key, with no glyph: nothing is deleted. */}
      <ConfirmDialog
        open={leaving}
        onClose={() => setLeaving(false)}
        title="Disconnect email"
        body="Dockify forgets the password and stops sending email. Invites go back to copy links, and Forgot password leaves the sign-in page."
        confirmLabel="Disconnect email"
        onConfirm={disconnect}
      />
    </>
  );
}
