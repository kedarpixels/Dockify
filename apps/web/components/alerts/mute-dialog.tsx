"use client";

import { useState } from "react";
import { Callout } from "@/components/ui/callout";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { Segmented } from "@/components/ui/segmented";
import { plural } from "@/lib/format";
import { useTimeFormat } from "@/lib/time-prefs";
import { isMuteHours, MUTE_HOURS, type AlertApp, type MuteHours } from "@/lib/pages/alerts-shared";
import { appName } from "./labels";

/** Rules keep evaluating and the history keeps recording; only the channels stay quiet. */
export function MuteDialog({
  app,
  rules,
  now,
  onClose,
  onMute,
}: {
  app: AlertApp;
  rules: number;
  now: number;
  onClose: () => void;
  onMute: (hours: MuteHours) => Promise<boolean>;
}) {
  const time = useTimeFormat();
  const [hours, setHours] = useState<MuteHours>(1);
  const [busy, setBusy] = useState(false);
  const ends = time.abs(new Date(now + hours * 3_600_000).toISOString());

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await onMute(hours);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open
      size="sm"
      onClose={onClose}
      title="Mute alerts"
      sub={appName(app)}
      icon="bell"
      busy={busy}
      onSubmit={() => void submit()}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <PendingButton type="submit" className="btn btn-primary" pending={busy} icon="pause">
            Mute for {plural(hours, "hour")}
          </PendingButton>
        </>
      }
    >
      <div className="al-form">
        <Field label="Mute for" hint={<span className="num">Ends {ends}</span>}>
          {(ids) => (
            <Segmented
              ids={ids}
              label="Mute for"
              value={String(hours)}
              onChange={(v) => {
                const h = Number(v);
                if (isMuteHours(h)) setHours(h);
              }}
              options={MUTE_HOURS.map((h) => ({ value: String(h), label: plural(h, "hour") }))}
            />
          )}
        </Field>
        <Callout>
          {rules === 1 ? "Its rule keeps" : `Its ${rules} rules keep`} watching and every event still lands in the history. Webhooks, email and the bell stay quiet until the mute ends.
        </Callout>
      </div>
    </Dialog>
  );
}
