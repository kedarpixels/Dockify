"use client";

import { useState, type ReactNode } from "react";
import { Icon } from "@/components/icon";
import { Chip } from "@/components/ui/chip";
import { useTimeFormat } from "@/lib/time-prefs";
import { useHydrated } from "@/lib/hooks";
import { acceptInvite, type Invite } from "@/lib/pages/auth";
import { AuthHead } from "./auth-head";
import { NewAccountForm } from "./new-account-form";
import { DoneStep, ProtectStep } from "./totp-enroll";

type Step = "account" | "protect" | "done";

/**
 * /invite/[token]: a teammate sets a name and password, then may add an authenticator. Signing in
 * sets a cookie, so Next refreshes this route the moment the account exists, and its loader then
 * reads the invite as used. The flow runs on the invite this visit opened with; `gone` only shows to
 * a visitor who arrived with a link that was already dead.
 */
export function InviteView({ token, invite: loaded, expires: loadedExpires, gone }: { token: string; invite: Invite | null; expires: string; gone: ReactNode }) {
  const [opened] = useState(() => (loaded ? { invite: loaded, expires: loadedExpires } : null));
  return opened ? <InviteFlow token={token} invite={opened.invite} expires={opened.expires} /> : gone;
}

function InviteFlow({ token, invite, expires }: { token: string; invite: Invite; expires: string }) {
  const time = useTimeFormat();
  const [step, setStep] = useState<Step>("account");
  const [mfa, setMfa] = useState(false);
  // Local time differs between the server and the browser: the tip reads UTC until hydrated.
  const hydrated = useHydrated();

  if (step === "protect") {
    return (
      <ProtectStep
        step={[2, 2]}
        onEnabled={() => {
          setMfa(true);
          setStep("done");
        }}
        onSkip={() => setStep("done")}
      />
    );
  }
  if (step === "done") {
    return (
      <DoneStep
        lead={
          mfa
            ? `You are in ${invite.instanceName}, and two-factor is on. If you ever lose your authenticator, whoever runs the server can turn it off.`
            : `You are in ${invite.instanceName}. Two-factor is off; turn it on any time in Settings.`
        }
      />
    );
  }

  return (
    <section className="auth-block">
      <AuthHead icon="users" step={[1, 2]} title="Accept invite" lead={`${invite.invitedBy} invited you to join ${invite.instanceName}.`} />

      {/* Who, as what and until when, grouped so it reads at a glance before the form. */}
      <dl className="auth-invite">
        <div>
          <dt>Server</dt>
          <dd>{invite.instanceName}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>
            <Chip size="xs">{invite.role}</Chip>
          </dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>
            <time
              dateTime={invite.expiresAt}
              className="auth-invite-time"
              data-tip={time.abs(invite.expiresAt, { utc: !hydrated && !time.prefs.timeZone })}
              data-tip-align="end"
              suppressHydrationWarning
            >
              <Icon name="clock" size={14} />
              {expires.charAt(0).toUpperCase() + expires.slice(1)}
            </time>
          </dd>
        </div>
      </dl>

      <NewAccountForm
        idPrefix="invite"
        fixedEmail={invite.email}
        submitIcon="userPlus"
        submitLabel="Create account"
        onSubmit={(v) => acceptInvite({ token, name: v.name, password: v.password })}
        onDone={() => setStep("protect")}
      />
    </section>
  );
}
