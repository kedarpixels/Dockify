"use client";

import Link from "next/link";
import { useState } from "react";
import { wasCancelled } from "@/components/step-up/step-up";
import { Callout } from "@/components/ui/callout";
import { Dialog } from "@/components/ui/dialog";
import { Field, TextInput } from "@/components/ui/field";
import { PendingLabel } from "@/components/ui/pending";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errText } from "@/lib/feedback";
import { plural } from "@/lib/format";
import type { BackupRun, BackupSchedule, BackupStorage, BackupTier, BackupTierSchedule, TierPatch } from "@/lib/pages/server-backups";
import { send } from "./use-poll";
import { cronText, dbLabel, placeName } from "./util";

export const TIERS: BackupTier[] = ["local", "offsite"];
export const TIER_LABEL: Record<BackupTier, string> = { local: "On this server", offsite: "Offsite" };

const STORAGE_HREF = "/settings?section=integrations";

/** "Every 12 hours, keep 1": the schedule and what it keeps, in words. */
export function tierWords(t: Pick<BackupTierSchedule, "cron" | "keep" | "keepDays">): string {
  const words = cronText(t.cron);
  const when = words === t.cron ? "Custom schedule" : words;
  return `${when}, keep ${t.keep.toLocaleString("en-US")}${t.keepDays ? ` and ${plural(t.keepDays, "day")}` : ""}`;
}

export const tierPlace = (t: BackupTierSchedule) => (t.tier === "local" ? "To this server's disk" : t.storage ? `To ${t.storage.name}` : "No S3 destination yet");

export const lastOf = (runs: BackupRun[], resourceId: string, tier: BackupTier) => runs.find((r) => r.resourceId === resourceId && r.tier === tier && r.status !== "running") ?? null;

export const lastWord = (r: BackupRun | null) => (r ? (r.status === "failed" ? "Last run failed" : "Last good") : null);

/** Where Back up now sends a database's copies: every tier that is on, else where its schedule points. */
export function backUpPlaces(s: BackupSchedule): string {
  const on = TIERS.filter((k) => s.tiers[k].enabled && s.tiers[k].available);
  const places = (on.length ? on : [s.destination === "s3" ? "offsite" : "local"] as BackupTier[]).map((k) => (k === "local" ? "this server" : placeName(s.tiers[k].storage)));
  return places.join(" and ");
}

const PRESETS: Array<{ value: string; label: string }> = [
  { value: "0 * * * *", label: "Every hour" },
  { value: "0 */6 * * *", label: "Every 6 hours" },
  { value: "0 */12 * * *", label: "Every 12 hours" },
  { value: "0 3 * * *", label: "Every day at 03:00" },
  { value: "0 3 * * 0", label: "Every Sunday at 03:00" },
];
const CUSTOM = "custom";
const CRON = /^(\S+\s+){4}\S+$/;
const CRON_CHARS = /^[\d*/,\- ]+$/;
const DEFAULT_DEST = "s3";

interface Draft {
  enabled: boolean;
  preset: string;
  cron: string;
  keep: string;
  keepDays: string;
  destination: string;
}

const draftOf = (t: BackupTierSchedule): Draft => ({
  enabled: t.enabled,
  preset: PRESETS.some((p) => p.value === t.cron) ? t.cron : CUSTOM,
  cron: t.cron,
  keep: String(t.keep),
  keepDays: t.keepDays ? String(t.keepDays) : "",
  destination: t.storage?.id ?? DEFAULT_DEST,
});

const cronOf = (d: Draft) => (d.preset === CUSTOM ? d.cron.trim().replace(/\s+/g, " ") : d.preset);

function problems(d: Draft): Partial<Record<"cron" | "keep" | "keepDays", string>> {
  const out: Partial<Record<"cron" | "keep" | "keepDays", string>> = {};
  if (!d.enabled) return out;
  const cron = cronOf(d);
  if (!CRON.test(cron) || !CRON_CHARS.test(cron)) out.cron = "Use five fields, like 0 3 * * *";
  const keep = Number(d.keep);
  if (!/^\d+$/.test(d.keep) || keep < 1 || keep > 1000) out.keep = "Keep 1 to 1000";
  if (d.keepDays && (!/^\d+$/.test(d.keepDays) || Number(d.keepDays) < 1 || Number(d.keepDays) > 3650)) out.keepDays = "1 to 3650 days, or empty";
  return out;
}

/** Only what changed on one tier, or null when nothing did. */
function patchOf(t: BackupTierSchedule, d: Draft): TierPatch | null {
  const p: TierPatch = { tier: t.tier };
  if (d.enabled !== t.enabled) p.enabled = d.enabled;
  if (d.enabled) {
    const cron = cronOf(d);
    if (cron !== t.cron) p.cron = cron;
    if (Number(d.keep) !== t.keep) p.keep = Number(d.keep);
    const days = d.keepDays ? Number(d.keepDays) : null;
    if (days !== t.keepDays) p.keepDays = days;
    if (t.tier === "offsite" && d.destination !== (t.storage?.id ?? DEFAULT_DEST)) p.destination = d.destination;
  }
  return Object.keys(p).length > 1 ? p : null;
}

const SUB: Record<BackupTier, string> = {
  local: "Copies on this server's disk: quick to restore, lost with the disk.",
  offsite: "Copies in an S3 bucket off this server: what survives a lost server.",
};

function TierFields({ t, d, set, errs, destinations }: { t: BackupTierSchedule; d: Draft; set: (patch: Partial<Draft>) => void; errs: ReturnType<typeof problems>; destinations: BackupStorage[] }) {
  const offsite = t.tier === "offsite";
  const blocked = offsite && destinations.length === 0;
  const cron = cronOf(d);
  return (
    <fieldset className="bk-tier" data-off={!d.enabled || undefined}>
      <legend className="sr">{TIER_LABEL[t.tier]}</legend>
      <div className="bk-tier-head">
        <span className="two">
          <span className="two-main">{TIER_LABEL[t.tier]}</span>
          <span className="two-sub">{SUB[t.tier]}</span>
        </span>
        <Switch checked={d.enabled} disabled={blocked || (!t.available && !d.enabled)} onChange={(v) => set({ enabled: v })} label={`Back up ${TIER_LABEL[t.tier].toLowerCase()} on a schedule`} />
      </div>
      {blocked ? (
        <Callout tone="warn" icon="alert" action={<Link href={STORAGE_HREF} className="btn btn-sm">Add storage</Link>}>
          Add an S3 destination, such as Backblaze B2 or Cloudflare R2, to keep copies off this server.
        </Callout>
      ) : d.enabled ? (
        <div className="na-stack">
          <div className="na-pair">
            <Field label="How often" hint={d.preset === CUSTOM ? (cronText(cron) === cron ? "Five field cron, in UTC" : `${cronText(cron)}, UTC`) : "Times in UTC"}>
              {(ids) => (
                <Select ids={ids} label="How often" value={d.preset} onChange={(v) => set({ preset: v, ...(v !== CUSTOM ? { cron: v } : {}) })} options={[...PRESETS, { value: CUSTOM, label: "Custom cron" }]} />
              )}
            </Field>
            <Field label="Keep" error={errs.keep} hint="The newest backups that stay. Manual ones are never removed.">
              {(ids) => <TextInput ids={ids} className="num" inputMode="numeric" autoComplete="off" value={d.keep} onChange={(e) => set({ keep: e.target.value.replace(/\D/g, "").slice(0, 4) })} />}
            </Field>
          </div>
          {d.preset === CUSTOM ? (
            <Field label="Cron" error={errs.cron}>
              {(ids) => <TextInput ids={ids} className="mono" autoComplete="off" spellCheck={false} placeholder="0 3 * * *" value={d.cron} onChange={(e) => set({ cron: e.target.value })} />}
            </Field>
          ) : null}
          {offsite ? (
            <Field label="Destination">
              {(ids) => (
                <Select
                  ids={ids}
                  label="Destination"
                  icon="cloud"
                  value={d.destination}
                  onChange={(v) => set({ destination: v })}
                  options={[
                    { value: DEFAULT_DEST, label: `Default, ${destinations.find((x) => x.isDefault)?.name ?? destinations[0]!.name}` },
                    ...destinations.map((x) => ({ value: x.id, label: x.name, hint: x.bucket })),
                  ]}
                />
              )}
            </Field>
          ) : null}
          {t.keepDays !== null ? (
            <Field label="Also keep every backup from the last" error={errs.keepDays} hint="Days, set before tiers. Leave empty to keep by count alone.">
              {(ids) => <TextInput ids={ids} className="num" inputMode="numeric" autoComplete="off" placeholder="None" value={d.keepDays} onChange={(e) => set({ keepDays: e.target.value.replace(/\D/g, "").slice(0, 4) })} />}
            </Field>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

/** Opened after "Confirm it is you" (the caller runs ensureStepUp first), so the check never stacks on it. Saves only the tiers that changed. */
export function ScheduleDialog({
  schedule,
  destinations,
  onClose,
  onSaved,
}: {
  schedule: BackupSchedule;
  destinations: BackupStorage[];
  onClose: () => void;
  onSaved: (next: BackupSchedule) => void;
}) {
  const [drafts, setDrafts] = useState<Record<BackupTier, Draft>>(() => ({ local: draftOf(schedule.tiers.local), offsite: draftOf(schedule.tiers.offsite) }));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const errs = { local: problems(drafts.local), offsite: problems(drafts.offsite) };
  const shown = (k: BackupTier) => (tried ? errs[k] : { keep: errs[k].keep, keepDays: errs[k].keepDays });

  const save = async () => {
    setTried(true);
    if (TIERS.some((k) => Object.keys(errs[k]).length)) return;
    const patches = TIERS.map((k) => patchOf(schedule.tiers[k], drafts[k])).filter((p): p is TierPatch => p !== null);
    if (!patches.length) return onClose();
    setBusy(true);
    setFailed(null);
    let last = schedule;
    try {
      for (const p of patches) last = await send<BackupSchedule>(`/api/backups/schedules/${encodeURIComponent(schedule.id)}`, "PATCH", p);
      onSaved(last);
    } catch (e) {
      if (last !== schedule) onSaved(last);
      if (!wasCancelled(e)) setFailed(errText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      icon="calendar"
      title="Backup schedule"
      sub={dbLabel(schedule.database)}
      onSubmit={() => void save()}
      footer={
        <>
          {failed ? <span className="dlg-note tone-bad">{failed}</span> : null}
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            <PendingLabel pending={busy}>Save</PendingLabel>
          </button>
        </>
      }
    >
      <div className="bk-tiers-form">
        {TIERS.map((k) => (
          <TierFields key={k} t={schedule.tiers[k]} d={drafts[k]} errs={shown(k)} destinations={destinations} set={(patch) => setDrafts((all) => ({ ...all, [k]: { ...all[k], ...patch } }))} />
        ))}
      </div>
    </Dialog>
  );
}
