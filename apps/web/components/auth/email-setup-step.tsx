"use client";

import { useState } from "react";
import { sendTestEmail, useEmailForm } from "@/components/activity-settings/integrations/email-form";
import { useStepUp } from "@/components/step-up/step-up";
import { Icon } from "@/components/icon";
import { PendingButton } from "@/components/ui/pending";
import type { EmailIntegration } from "@/lib/pages/integrations";
import { AuthHead } from "./auth-head";
import { Command } from "./recover-view";

const RESET_PASSWORD = "sudo dockify admin reset-password <email>";

/** Each view remounts its head, so the title takes the focus. */
export function EmailSetupStep({
  step,
  connected,
  onConnected,
  onContinue,
  onSkip,
  preview,
}: {
  step: [number, number];
  /** What this setup has connected so far, when the code step sent the admin back to change it. */
  connected: EmailIntegration | null;
  onConnected: (v: EmailIntegration) => void;
  onContinue: () => void;
  onSkip: () => void;
  preview: boolean;
}) {
  const [view, setView] = useState<"form" | "later" | "connected">("form");
  const [testing, setTesting] = useState(false);
  const { elevate } = useStepUp();
  const form = useEmailForm({
    editing: connected,
    preview,
    autoFocus: true,
    onDone: (v) => {
      onConnected(v);
      setView("connected");
    },
  });

  if (view === "later") {
    return (
      <section key="later" className="auth-block">
        <AuthHead icon="mail" step={step} title="Set up later?" lead="Dockify works without email. Until you connect it in Settings, Integrations:" announce />
        <div className="auth-form">
          <ul className="auth-later">
            <li>No password reset by email. A lost password needs SSH on this server.</li>
            <li>No alerts by email. The in-app bell and webhooks still work.</li>
            <li>No invites by email. You copy and share each invite link.</li>
          </ul>
          <Command command={RESET_PASSWORD} what="password reset command" />
          <div className="auth-pair">
            <button type="button" className="btn" onClick={() => setView("form")}>
              Back
            </button>
            <button type="button" className="btn btn-primary" onClick={onSkip}>
              Set up later
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (view === "connected" && connected) {
    return (
      <section key="connected" className="auth-block">
        <AuthHead
          icon="checkCircle"
          step={step}
          title="Email connected"
          lead={
            <>
              Sending as {connected.fromName}, <span className="auth-wrap">{connected.fromAddress}</span>. Next, a code goes to your own address.
            </>
          }
          announce
        />
        <div className="auth-form">
          <div className="auth-pair">
            <PendingButton
              className="btn"
              pending={testing}
              onClick={() => {
                setTesting(true);
                void sendTestEmail(elevate, preview).finally(() => setTesting(false));
              }}
            >
              Send test email
            </PendingButton>
            <button type="button" className="btn btn-primary" onClick={onContinue}>
              Continue
              <Icon name="arrowRight" size={16} className="ic-trail" />
            </button>
          </div>
        </div>
        <div className="auth-alt">
          <button type="button" className="auth-link auth-back" onClick={() => setView("form")}>
            Change email settings
          </button>
        </div>
      </section>
    );
  }

  return (
    <section key="form" className="auth-block">
      <AuthHead
        icon="mail"
        step={step}
        title={connected ? "Change email" : "Connect email"}
        lead="Password resets, invites, alerts and sign-in codes go out through your own mail server."
        announce
      />
      <form
        className="auth-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void form.submit();
        }}
      >
        {form.fields}
        <div className="auth-pair">
          {connected ? (
            <button type="button" className="btn" onClick={() => setView("connected")} disabled={form.busy}>
              Back
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => setView("later")} disabled={form.busy}>
              Set up later
            </button>
          )}
          <PendingButton type="submit" className="btn btn-primary" pending={form.busy} icon={connected ? "check" : "link"}>
            {connected ? "Save" : "Connect"}
          </PendingButton>
        </div>
      </form>
    </section>
  );
}
