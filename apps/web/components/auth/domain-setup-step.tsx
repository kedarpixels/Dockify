"use client";

import { DomainFlow, useDashboardDomain } from "@/components/dashboard-domain/flow";
import { Callout } from "@/components/ui/callout";
import { AuthHead } from "./auth-head";

/**
 * Setup's last, optional step on an install that started on its sslip.io name: use your own domain. The
 * same flow as Settings, Instance. Skipping loses nothing: the address the server started on keeps
 * working, and the domain can be set later in Settings.
 */
export function DomainSetupStep({ step, onSkip, preview }: { step: [number, number]; onSkip: () => void; preview: boolean }) {
  const { state, setState, error } = useDashboardDomain();
  return (
    <section className="auth-block">
      <AuthHead
        icon="globe"
        step={step}
        title="Use your domain?"
        lead={state ? `The dashboard works on ${state.host} with a real certificate. Move it to a domain of yours now, or any time in Settings, Instance.` : "Move the dashboard to a domain of yours now, or any time in Settings, Instance."}
        announce
      />
      <div className="auth-form">
        {error && !state ? <Callout icon="info">{error}</Callout> : null}
        {state ? <DomainFlow state={state} setState={setState} preview={preview} footerClass="dd-foot dd-foot-auth" /> : null}
        <button type="button" className="btn auth-submit" onClick={onSkip}>
          {state?.pending ? "Finish on this address for now" : "Skip for now"}
        </button>
      </div>
    </section>
  );
}
