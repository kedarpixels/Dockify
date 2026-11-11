"use client";

import { useEffect, useState } from "react";
import { updatePreferences, type PreferencesPatch } from "@/app/(console)/settings/actions";
import { Segmented } from "@/components/ui/segmented";
import { Select, type SelectOption } from "@/components/ui/select";
import { useSingleKeyShortcuts } from "@/components/ui/shortcuts";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { describe } from "@/lib/feedback";
import { absTime } from "@/lib/format";
import { useHydrated } from "@/lib/hooks";
import type { Me, Role } from "@/lib/pages/activity-settings";
import { useApplyTimePrefs } from "@/lib/time-prefs";
import { useZoneList } from "@/lib/use-zone-list";
import type { TimePrefs } from "@/lib/types";
import { Group, isUtc, SaveBar, settle, SettingRow, zoneLabel } from "./form";
import { Segment, SectionTabs } from "./section-tabs";
import type { SectionProps } from "./settings-view";

interface PrefsDraft extends TimePrefs {
  deployFailed: boolean;
  security: boolean;
}

const prefsOf = (me: Me): PrefsDraft => ({ timeZone: me.timeZone, hour12: me.hour12, deployFailed: me.notify.deployFailed, security: me.notify.security });

function prefsPatch(from: PrefsDraft, to: PrefsDraft): PreferencesPatch | null {
  const patch: PreferencesPatch = {};
  if (to.timeZone !== from.timeZone) patch.timeZone = to.timeZone;
  if (to.hour12 !== from.hour12) patch.hour12 = to.hour12;
  const notify: NonNullable<PreferencesPatch["notify"]> = {};
  if (to.deployFailed !== from.deployFailed) notify.deployFailed = to.deployFailed;
  if (to.security !== from.security) notify.security = to.security;
  if (Object.keys(notify).length) patch.notify = notify;
  return Object.keys(patch).length ? patch : null;
}

const BROWSER = "browser";
const UTC = "UTC";
type Clock = "24" | "12";

/** The saved zone stays listed even when the browser does not know it. */
function zoneOptions(list: ReturnType<typeof useZoneList>, current: string | null): SelectOption<string>[] {
  const zones = list.at === "ready" ? list.zones.filter((z) => !isUtc(z)) : [];
  if (current && current !== UTC && !zones.includes(current)) zones.unshift(current);
  const browser = list.at === "loading" || !list.browser ? undefined : zoneLabel(list.browser);
  return [{ value: BROWSER, label: "Browser default", hint: browser }, { value: UTC, label: UTC }, ...zones.map((z) => ({ value: z, label: zoneLabel(z) }))];
}

function TimeGroup({ draft, onChange, now }: { draft: PrefsDraft; onChange: (next: Partial<PrefsDraft>) => void; now: number }) {
  const list = useZoneList();
  const hydrated = useHydrated();
  // A browser-default sample differs between the server and the browser, so it waits for mount.
  const sample = hydrated || draft.timeZone ? absTime(new Date(now).toISOString(), { prefs: draft }) : null;
  const zoneDesc =
    list.at === "error"
      ? "This browser cannot list time zones. Browser default and UTC still work."
      : "Deploys, logs, sessions and activity. Schedules and backups stay in UTC.";
  return (
    <Group id="set-time" icon="clock" title="Time and date" sub="How times read for you on this dashboard">
      <SettingRow label="Time zone" desc={zoneDesc}>
        {(ids) => (
          <Select
            ids={ids}
            label="Time zone"
            align="end"
            search="Search time zones"
            value={draft.timeZone ?? BROWSER}
            options={zoneOptions(list, draft.timeZone)}
            onChange={(v) => onChange({ timeZone: v === BROWSER ? null : v })}
          />
        )}
      </SettingRow>
      <SettingRow label="Clock" desc={sample ? `Times read like ${sample}` : "24-hour or 12-hour times"}>
        <Segmented<Clock>
          label="Clock"
          value={draft.hour12 ? "12" : "24"}
          onChange={(v) => onChange({ hour12: v === "12" })}
          options={[
            { value: "24", label: "24-hour" },
            { value: "12", label: "12-hour" },
          ]}
        />
      </SettingRow>
    </Group>
  );
}

function MailRow({ label, desc, checked, disabled, onChange }: { label: string; desc: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <SettingRow
      label={label}
      desc={desc}
      className="set-row-toggle"
      onClick={(e) => {
        if (disabled || (e.target instanceof Element && e.target.closest("button, label"))) return;
        onChange(!checked);
      }}
    >
      {(ids) => <Switch ids={ids} checked={checked} disabled={disabled} onChange={onChange} />}
    </SettingRow>
  );
}

function MailGroup({
  draft,
  onChange,
  role,
  emailEnabled,
  onSetUp,
}: {
  draft: PrefsDraft;
  onChange: (next: Partial<PrefsDraft>) => void;
  role: Role;
  emailEnabled: boolean;
  onSetUp: () => void;
}) {
  const admin = role === "admin";
  return (
    <Group
      id="set-mail"
      icon="mail"
      title="Email me about"
      sub={emailEnabled ? "Sent to your sign-in address" : "Email is not set up on this server yet"}
      actions={
        emailEnabled ? null : (
          <button type="button" className="btn btn-sm" onClick={onSetUp}>
            Set up email
          </button>
        )
      }
    >
      <MailRow
        label="Deploys I started that fail"
        desc="A deploy you clicked, or pushed from your linked GitHub account, did not go live."
        checked={draft.deployFailed}
        disabled={!emailEnabled}
        onChange={(deployFailed) => onChange({ deployFailed })}
      />
      <MailRow
        label="Security alerts about my account"
        desc={admin ? "Always on for admins: a new sign-in, a password or two-factor change." : "A new sign-in, a password or two-factor change."}
        checked={admin || draft.security}
        disabled={!emailEnabled || admin}
        onChange={(security) => onChange({ security })}
      />
    </Group>
  );
}

/** Kept in this browser like the theme, so the switch applies at once and needs no save. */
function KeysGroup() {
  const [on, setOn] = useSingleKeyShortcuts();
  return (
    <Group id="set-keys" icon="command" title="Keyboard" sub="Kept in this browser">
      <SettingRow
        label="Single-key shortcuts"
        desc="D switches the theme and / jumps to search. Turn them off if they get in the way."
        className="set-row-toggle"
        onClick={(e) => {
          if (!(e.target instanceof Element && e.target.closest("button, label"))) setOn(!on);
        }}
      >
        {(ids) => <Switch ids={ids} checked={on} onChange={setOn} />}
      </SettingRow>
    </Group>
  );
}

export function PreferencesSection({ data, update, onDirty, now, preview, go, tab, onTab, emailEnabled, elevate }: SectionProps) {
  const me = data.me;
  const applyTime = useApplyTimePrefs();
  const saved = prefsOf(me);
  const [base, setBase] = useState<PrefsDraft>(saved);
  const [draft, setDraft] = useState<PrefsDraft>(saved);
  const [saving, setSaving] = useState(false);
  // Saved elsewhere (another tab's save lands in `me`): an untouched draft follows it.
  if (prefsPatch(base, saved)) {
    setBase(saved);
    if (!prefsPatch(draft, base)) setDraft(saved);
  }
  const patch = prefsPatch(saved, draft);
  const dirty = patch !== null;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const change = (next: Partial<PrefsDraft>) => setDraft((p) => ({ ...p, ...next }));

  const save = async () => {
    if (!patch) return;
    setSaving(true);
    const sent = draft;
    const res = await settle(elevate(() => updatePreferences(patch), { what: "Changing your preferences" }));
    setSaving(false);
    if (!res.ok) return void toast.error("Could not save preferences", { description: res.error });
    applyTime({ timeZone: res.data.timeZone, hour12: res.data.hour12 });
    update({ me: res.data });
    setDraft((p) => (p === sent ? prefsOf(res.data) : p));
    const done = [patch.timeZone !== undefined || patch.hour12 !== undefined ? "time and date" : null, patch.notify ? "email choices" : null].filter((x) => x !== null);
    toast.success("Preferences saved", { description: describe(done.join(", "), { preview }) });
  };

  const openEmailSetup = () => {
    go("integrations");
    requestAnimationFrame(() => document.getElementById("int-email")?.scrollIntoView({ block: "center" }));
  };

  return (
    <>
      <SectionTabs section="preferences" tab={tab} onTab={onTab}>
        <Segment value="time" tab={tab}>
          <TimeGroup draft={draft} now={now} onChange={change} />
        </Segment>
        <Segment value="email" tab={tab}>
          <MailGroup draft={draft} role={me.role} emailEnabled={emailEnabled} onSetUp={openEmailSetup} onChange={change} />
        </Segment>
        <Segment value="keyboard" tab={tab}>
          <KeysGroup />
        </Segment>
      </SectionTabs>
      <SaveBar dirty={dirty} saving={saving} onDiscard={() => setDraft(saved)} onSave={() => void save()} />
    </>
  );
}
