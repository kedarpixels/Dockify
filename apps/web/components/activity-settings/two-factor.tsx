"use client";

import { useEffect, useState } from "react";
import { disableTwoFactor, setupTwoFactor, verifyTwoFactor } from "@/app/(console)/settings/actions";
import { OtpInput } from "@/components/auth/otp-input";
import { PseudoQr } from "@/components/auth/pseudo-qr";
import { Icon } from "@/components/icon";
import { Callout } from "@/components/ui/callout";
import { CopyBox } from "@/components/ui/copy-box";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { IconTile } from "@/components/ui/icon-tile";
import { PendingButton } from "@/components/ui/pending";
import { Skel } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { describe } from "@/lib/feedback";
import type { TotpSetup } from "@/lib/pages/activity-settings";
import { Group, SettingRow, settle } from "./form";
import type { SectionProps } from "./settings-view";
import { ensureStepUp, type Elevate } from "@/components/step-up/step-up";

function QrArea({ setup, preview }: { setup: TotpSetup; preview: boolean }) {
  return (
    <figure className="as-qr" role="img" aria-label="QR code">
      {setup.qrDataUrl ? <img src={setup.qrDataUrl} alt="" width={168} height={168} /> : preview ? <PseudoQr secret={setup.secret} /> : <span className="as-qr-empty">QR code</span>}
      <figcaption className="sr">QR code</figcaption>
    </figure>
  );
}

/** The scan step's shape while the secret is fetched: the QR square, three lines and the code field. */
function SetupSkeleton() {
  return (
    <div className="as-tfa" role="status" aria-label="Loading" aria-busy="true">
      <Skel w={168} h={168} r={10} />
      <div className="as-tfa-steps">
        <Skel w="40%" h={14} />
        <Skel w="86%" h={14} />
        <Skel w="48%" h={14} />
        <Skel h={36} r={10} />
      </div>
    </div>
  );
}

/** The authenticator code, as every code field reads: six boxes, the standard label and hint. */
function CodeField({ code, setCode, error, onComplete, disabled }: { code: string; setCode: (c: string) => void; error: string | null; onComplete?: (c: string) => void; disabled?: boolean }) {
  return (
    <Field label="Authenticator code" hint="The 6-digit code from your authenticator app." error={error}>
      {(ids) => (
        <OtpInput
          id={ids.id}
          describedBy={ids.describedBy}
          invalid={ids.invalid}
          value={code}
          label="Authenticator code"
          onChange={setCode}
          onComplete={onComplete}
          disabled={disabled}
          autoFocus
        />
      )}
    </Field>
  );
}

type Step = "loading" | "scan" | "error";

/**
 * Turning two-factor on. Mounted only while open, so every opening (and every Try again, which
 * mounts it afresh) starts from a new secret; it only becomes active after a verified code, so
 * cancelling midway leaves two-factor off. Closing drops the secret from memory.
 */
function TwoFactorSetup({ onClose, onRetry, onEnabled, preview, elevate }: { onClose: () => void; onRetry: () => void; onEnabled: () => void; preview: boolean; elevate: Elevate }) {
  const [step, setStep] = useState<Step>("loading");
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void settle(elevate(() => setupTwoFactor(), { what: "Setting up two-factor" })).then((res) => {
      if (!alive) return;
      if (!res.ok) {
        setError(res.error);
        setStep("error");
        return;
      }
      setSetup(res.data);
      setStep("scan");
    });
    return () => {
      alive = false;
    };
  }, [elevate]);

  const verify = async (value = code) => {
    if (step !== "scan" || !setup || busy) return;
    if (!/^\d{6}$/.test(value)) return setError("Enter all 6 digits");
    setBusy(true);
    const res = await settle(elevate(() => verifyTwoFactor(value), { what: "Turning on two-factor" }));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setError(null);
    onEnabled();
    onClose();
  };

  const grouped = setup?.secret.match(/.{1,4}/g)?.join(" ") ?? "";

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      icon="shieldCheck"
      title="Set up two-factor authentication"
      onSubmit={() => void verify()}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {step === "error" ? (
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              Try again
            </button>
          ) : (
            <PendingButton type="submit" className="btn btn-primary" pending={busy} disabled={step !== "scan"} icon="shieldCheck">
              Turn on two-factor
            </PendingButton>
          )}
        </>
      }
    >
      {step === "loading" ? (
        <SetupSkeleton />
      ) : step === "error" ? (
        <Callout tone="warn" icon="alert" role="alert">
          {(error ?? "Two-factor setup did not start").replace(/\.$/, "")}.
        </Callout>
      ) : step === "scan" && setup ? (
        <div className="as-tfa">
          <QrArea setup={setup} preview={preview} />
          <ol className="as-tfa-steps">
            <li>
              <span className="step-n num" aria-hidden="true">
                1
              </span>
              <span className="two-main">Scan the code with an authenticator app such as 1Password, Google Authenticator or Authy.</span>
            </li>
            <li>
              <span className="step-n num" aria-hidden="true">
                2
              </span>
              <span className="as-step-body">
                <span className="two-main">Cannot scan it? Enter the setup key instead.</span>
                <CopyBox value={grouped} what="setup key" code />
              </span>
            </li>
            <li>
              <span className="step-n num" aria-hidden="true">
                3
              </span>
              <span className="as-step-body">
                <CodeField
                  code={code}
                  setCode={(c) => {
                    setCode(c);
                    setError(null);
                  }}
                  onComplete={(c) => void verify(c)}
                  disabled={busy}
                  error={error}
                />
              </span>
            </li>
          </ol>
        </div>
      ) : null}
    </Dialog>
  );
}

/** Turning two-factor off, mounted only while open, so every opening starts with an empty code. */
function TwoFactorOff({ onClose, onDisabled }: { onClose: () => void; onDisabled: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (value = code) => {
    if (busy) return;
    if (value.length !== 6) return setError("Enter all 6 digits");
    setBusy(true);
    const res = await settle(disableTwoFactor(value));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onDisabled();
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      size="sm"
      icon="shield"
      title="Turn off two-factor authentication"
      onSubmit={() => void submit()}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <PendingButton type="submit" className="btn btn-primary" pending={busy} icon="shield">
            Turn off
          </PendingButton>
        </>
      }
    >
      <p className="dlg-text">Your account will be protected by its password alone.</p>
      <CodeField
        code={code}
        setCode={(c) => {
          setCode(c);
          setError(null);
        }}
        onComplete={(c) => void submit(c)}
        disabled={busy}
        error={error}
      />
    </Dialog>
  );
}

/** Two-factor on or off, with its setup and turn-off dialogs. */
export function TwoFactorGroup({ data, update, preview, elevate }: Pick<SectionProps, "data" | "update" | "preview" | "elevate">) {
  const on = data.me.twoFactor.enabled;
  const [dialog, setDialog] = useState<"setup" | "off" | null>(null);
  // Each Try again mounts the setup afresh, with a new secret.
  const [attempt, setAttempt] = useState(0);
  const setTwoFactor = (enabled: boolean) => update({ me: { ...data.me, twoFactor: { enabled } } });
  return (
    <Group id="set-2fa" icon="shieldCheck" title="Two-factor authentication" sub="A 6-digit code from an authenticator app at every sign-in">
      <SettingRow
        lead={
          <IconTile size="md" tone={on ? "ok" : undefined}>
            <Icon name="mobile" />
          </IconTile>
        }
        label="Authenticator app"
        desc={on ? "On. Every sign-in asks for a code from your app." : "Off. Anyone with your password can sign in."}
      >
        {on ? (
          <button type="button" className="btn btn-sm" onClick={() => setDialog("off")}>
            Turn off
          </button>
        ) : (
          // "Confirm it is you" comes first and alone; the setup opens only once it is answered, so
          // the two never show stacked.
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => void ensureStepUp({ what: "Setting up two-factor" }).then((ok) => ok && setDialog("setup"))}
          >
            <Icon name="shieldCheck" />
            Set up
          </button>
        )}
      </SettingRow>
      {dialog === "setup" ? (
        <TwoFactorSetup
          key={attempt}
          onClose={() => setDialog(null)}
          onRetry={() => setAttempt((n) => n + 1)}
          onEnabled={() => {
            setTwoFactor(true);
            toast.success("Two-factor turned on", { description: describe("Signing in now also asks for a code from your app", { preview }) });
          }}
          preview={preview}
          elevate={elevate}
        />
      ) : null}
      {dialog === "off" ? (
        <TwoFactorOff
          onClose={() => setDialog(null)}
          onDisabled={() => {
            setTwoFactor(false);
            toast.success("Two-factor turned off", { description: describe("Your password alone now signs you in", { preview }) });
          }}
        />
      ) : null}
    </Group>
  );
}
