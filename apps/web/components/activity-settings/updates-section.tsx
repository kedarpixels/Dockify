"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { modeLabel, UPDATE_MODES, v } from "@/components/server-backups/util";
import { send } from "@/components/server-backups/use-poll";
import { wasCancelled } from "@/components/step-up/step-up";
import { Chip, StatusChip } from "@/components/ui/chip";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { callJson } from "@/lib/client-api";
import { describe, errText } from "@/lib/feedback";
import { useZoneList } from "@/lib/use-zone-list";
import { type ReleaseChannel, type UpdateMode, type UpdatePolicyBody, type UpdateStatus, type UpdatesResult } from "@/lib/pages/server-backups";
import { useCan } from "@/lib/viewer";
import { Group, isUtc, SaveBar, SettingRow, zoneLabel } from "./form";
import type { SectionProps } from "./settings-view";

/* Loads its own status and saves through a step-up. Checking and installing live on the Server page. */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HALF_HOURS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
const UTC = "Etc/UTC";

type Draft = { mode: UpdateMode; channel: ReleaseChannel; anyTime: boolean; days: number[]; start: string; end: string; timeZone: string };

function toDraft(s: UpdateStatus): Draft {
  const p = s.policy;
  return {
    mode: p.mode,
    channel: p.channel,
    anyTime: p.window === null,
    days: p.window ? [...p.window.days].sort() : [0, 1, 2, 3, 4, 5, 6],
    start: p.window?.start ?? "03:00",
    end: p.window?.end ?? "05:00",
    timeZone: p.timeZone || UTC,
  };
}

function toBody(d: Draft): UpdatePolicyBody {
  return { mode: d.mode, channel: d.channel, window: d.anyTime ? null : { days: [...d.days].sort(), start: d.start, end: d.end }, timeZone: d.timeZone };
}

const same = (a: Draft, b: Draft) => JSON.stringify(toBody(a)) === JSON.stringify(toBody(b));

function dayList(days: number[]) {
  if (days.length === 7) return "Every day";
  const names = days.map((d) => DAYS[d]!);
  return names.length < 2 ? (names[0] ?? "No days") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The list fills after mount so server and client agree. UTC is listed once, in the spelling the policy holds. */
function useTimeZones(current: string) {
  const list = useZoneList();
  const zones = [isUtc(current) ? current : UTC, ...(list.at === "ready" ? list.zones.filter((z) => !isUtc(z)) : [])];
  return zones.includes(current) ? zones : [current, ...zones];
}

const timeOptions = (current: string) => (HALF_HOURS.includes(current) ? HALF_HOURS : [...HALF_HOURS, current].sort()).map((t) => ({ value: t, label: t }));

export function UpdatesSection({ preview, onDirty, onMode }: SectionProps & { onMode: (mode: UpdateMode) => void }) {
  const { manage } = useCan();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Results land only in the promise callback; a load that a newer one replaced is ignored.
  useEffect(() => {
    let live = true;
    void callJson<UpdatesResult>("/api/server/updates").then((r) => {
      if (!live) return;
      const data = r.ok ? r.data?.data : null;
      if (data) {
        setStatus(data);
        setDraft(toDraft(data));
      } else {
        setLoadError(r.ok ? errText(r.data?.error, "The API did not answer for updates") : r.error);
      }
    });
    return () => {
      live = false;
    };
  }, [attempt]);

  const zones = useTimeZones(draft?.timeZone ?? UTC);
  const dirty = status !== null && draft !== null && !same(draft, toDraft(status));
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const mode = status?.policy.mode;
  useEffect(() => {
    if (mode) onMode(mode);
  }, [mode, onMode]);

  if (!status || !draft) {
    return (
      <Group id="set-updates" icon="download" title="Updates" sub="Signed Dockify releases">
        <SettingRow label={loadError ? "Update settings unavailable" : "Loading update settings"} desc={loadError ?? "Asking the API for the update policy."} error={null}>
          {loadError ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setLoadError(null);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          ) : null}
        </SettingRow>
      </Group>
    );
  }

  const saved = toDraft(status);
  const noDays = !draft.anyTime && draft.days.length === 0;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const toggleDay = (d: number) => set({ days: draft.days.includes(d) ? draft.days.filter((x) => x !== d) : [...draft.days, d].sort() });
  const overnight = !draft.anyTime && draft.end <= draft.start;

  const save = async () => {
    if (saving || !dirty || noDays) return;
    setSaving(true);
    const sent = draft;
    try {
      const next = await send<UpdateStatus>("/api/server/updates/policy", "PUT", toBody(sent));
      setStatus(next);
      // Edits typed while the save ran stay; otherwise the draft takes the stored values.
      setDraft((d) => (d && same(d, sent) ? toDraft(next) : d));
      const w = next.policy.window;
      toast.success("Update settings saved", { description: describe([modeLabel(next.policy.mode), w ? `${w.start} to ${w.end}, ${zoneLabel(next.policy.timeZone)}` : "Any time"], { preview }) });
    } catch (e) {
      if (!wasCancelled(e)) toast.error("Could not save update settings", { description: describe(errText(e), { preview }) });
    } finally {
      setSaving(false);
    }
  };

  const sub = status.configured ? `Dockify ${v(status.current)}, signed releases only` : `Dockify ${v(status.current)}, no release feed set`;

  return (
    <>
      <Group
        id="set-updates"
        icon="download"
        title="Updates"
        sub={manage ? sub : `${sub}. Only an admin can change them`}
        actions={
          <Link href="/server#srv-up-title" className="btn btn-sm">
            Check for releases
          </Link>
        }
      >
        {status.configured ? null : (
          <SettingRow label="Release feed" desc="Set DOCKIFY_RELEASE_FEED and DOCKIFY_RELEASE_PUBKEY for Dockify, then restart it.">
            <StatusChip tone="idle">Not set</StatusChip>
          </SettingRow>
        )}
        <SettingRow label="Policy" desc="Automatic installs back up the database first and roll back on any failure.">
          {manage ? (ids) => <Select ids={ids} label="Update policy" align="end" value={draft.mode} onChange={(mode) => set({ mode })} options={UPDATE_MODES} /> : <span className="set-ro">{modeLabel(draft.mode)}</span>}
        </SettingRow>
        <SettingRow label="Channel" desc="Beta gets releases first. Both are signed.">
          {manage ? (
            <Segmented
              label="Release channel"
              value={draft.channel}
              onChange={(channel) => set({ channel })}
              options={[
                { value: "stable", label: "Stable" },
                { value: "beta", label: "Beta" },
              ]}
            />
          ) : (
            <span className="set-ro">{draft.channel === "beta" ? "Beta" : "Stable"}</span>
          )}
        </SettingRow>
        <SettingRow label="Maintenance window" desc={draft.mode === "manual" ? "Used once automatic installs are on." : "When automatic installs may start."}>
          {manage ? (
            <Segmented
              label="Maintenance window"
              value={draft.anyTime ? "any" : "window"}
              onChange={(w) => set({ anyTime: w === "any" })}
              options={[
                { value: "any", label: "Any time" },
                { value: "window", label: "Window" },
              ]}
            />
          ) : (
            <span className="set-ro">{draft.anyTime ? "Any time" : `${dayList(draft.days)}, ${draft.start} to ${draft.end}`}</span>
          )}
        </SettingRow>
        {!draft.anyTime && manage ? (
          <>
            <SettingRow label="Days" error={noDays ? "Pick at least one day" : null} desc="In the time zone below.">
              <span className="set-upd-days">
                {DAYS.map((d, i) => (
                  <Chip key={d} picked={draft.days.includes(i)} onClick={() => toggleDay(i)}>
                    <span aria-hidden="true">{d}</span>
                    <span className="sr">{DAY_NAMES[i]}</span>
                  </Chip>
                ))}
              </span>
            </SettingRow>
            <SettingRow label="Hours" desc={overnight ? "Runs past midnight into the next day." : "Installs start inside this range."}>
              <span className="set-upd-hours">
                <Select label="Window start" align="end" value={draft.start} onChange={(start) => set({ start })} options={timeOptions(draft.start)} />
                <span className="set-upd-to">to</span>
                <Select label="Window end" align="end" value={draft.end} onChange={(end) => set({ end })} options={timeOptions(draft.end)} />
              </span>
            </SettingRow>
          </>
        ) : null}
        <SettingRow label="Time zone" desc="The window and the schedule read in this zone.">
          {manage ? (
            (ids) => <Select ids={ids} label="Time zone" align="end" search="Search time zones" value={draft.timeZone} onChange={(timeZone) => set({ timeZone })} options={zones.map((z) => ({ value: z, label: zoneLabel(z) }))} />
          ) : (
            <span className="set-ro">{zoneLabel(draft.timeZone)}</span>
          )}
        </SettingRow>
      </Group>
      <SaveBar dirty={dirty} saving={saving} error={noDays ? "Fix the highlighted fields first" : null} onDiscard={() => setDraft(saved)} onSave={() => void save()} />
    </>
  );
}
