"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createAdmin } from "@/lib/pages/auth";
import { Field, TextInput } from "@/components/ui/field";
import type { EmailIntegration } from "@/lib/pages/integrations";
import { AuthHead } from "./auth-head";
import { EmailSetupStep } from "./email-setup-step";
import { NewAccountForm } from "./new-account-form";
import { doneLead, nextStep, setupPlan, stepCount, type SetupStep } from "./setup-steps";
import { DomainSetupStep } from "./domain-setup-step";
import { DoneStep, ProtectStep } from "./totp-enroll";
import { VerifyEmailStep } from "./verify-email-step";

/**
 * /setup: first run. The first admin account, then email: connected here unless the installer did it
 * (or set up later), with a code to the admin's address once it is on. Then an optional
 * authenticator, an optional domain of its own on an install still on its sslip.io name, then the console. Email and two-factor both call the API on the new session, which
 * starts with a step-up made from the password just chosen (lib/pages/auth.ts), so neither asks for
 * it again inside that window.
 *
 * `finished` as it first mounts: an admin already existed, so this is a later visit with a session.
 * It turning true mid-flow is this browser's own new account, and the steps go on.
 */
export function SetupView({ finished = false, suggestedName, emailEnabled = false, offerDomain = false, preview = false }: { finished?: boolean; suggestedName?: string; emailEnabled?: boolean; offerDomain?: boolean; preview?: boolean }) {
  const router = useRouter();
  const [arrivedFinished] = useState(finished);
  useEffect(() => {
    if (arrivedFinished) router.replace("/");
  }, [arrivedFinished, router]);
  const [step, setStep] = useState<SetupStep | "done">("account");
  const [instance, setInstance] = useState(suggestedName ?? "");
  const [token, setToken] = useState("");
  const [mfa, setMfa] = useState(false);
  const [skippedEmail, setSkippedEmail] = useState(false);
  const [connected, setConnected] = useState<EmailIntegration | null>(null);
  const plan = setupPlan(emailEnabled, skippedEmail, offerDomain);
  // What follows the authenticator: the offer of a domain on an sslip.io install, else the end.
  const afterProtect = nextStep(plan, "protect");

  if (arrivedFinished) return null;
  if (step === "connect") {
    return (
      <EmailSetupStep
        step={stepCount(plan, "connect")}
        connected={connected}
        onConnected={setConnected}
        onContinue={() => setStep("verify")}
        onSkip={() => {
          setSkippedEmail(true);
          setStep("protect");
        }}
        preview={preview}
      />
    );
  }

  if (step === "verify") {
    return (
      <VerifyEmailStep
        step={stepCount(plan, "verify")}
        onDone={() => setStep("protect")}
        onSkip={() => setStep("protect")}
        onBack={emailEnabled ? undefined : () => setStep("connect")}
      />
    );
  }

  if (step === "protect") {
    return (
      <ProtectStep
        step={stepCount(plan, "protect")}
        onEnabled={() => {
          setMfa(true);
          setStep(afterProtect);
        }}
        onSkip={() => setStep(afterProtect)}
      />
    );
  }
  if (step === "domain") {
    return <DomainSetupStep step={stepCount(plan, "domain")} onSkip={() => setStep("done")} preview={preview} />;
  }
  if (step === "done") {
    return <DoneStep lead={doneLead(instance, mfa, skippedEmail)} />;
  }

  return (
    <section className="auth-block">
      <AuthHead
        icon="server"
        step={stepCount(plan, "account")}
        title="Set up Dockify"
        lead="Create the first admin account for this server. Admins can invite the rest of the team later."
      />
      <NewAccountForm
        idPrefix="setup"
        askInstance
        initialInstance={suggestedName}
        topSlot={
          <Field id="setup-token" label="Setup token" hint="Printed by the installer when the server started.">
            {(ids) => (
              <TextInput ids={ids} name="setup-token" autoComplete="off" autoCapitalize="none" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
            )}
          </Field>
        }
        submitIcon="userPlus"
        submitLabel="Create admin account"
        onSubmit={(v) => createAdmin({ ...v, setupToken: token })}
        onDone={(v) => {
          setInstance(v.instanceName.trim());
          setStep(nextStep(plan, "account"));
        }}
      />
    </section>
  );
}
