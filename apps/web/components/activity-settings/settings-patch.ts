import type { InstanceSettings, NotifyEvent } from "@/lib/pages/activity-settings";

// Only the fields that changed are sent: a whole-object save would store the shown preview domain
// as a custom one and put back values another admin changed since.

export type SettingsPatch = Partial<Pick<InstanceSettings, "instanceName" | "defaultBranch" | "logRetentionDays" | "previewDomain" | "terminalEnabled">> & {
  notifications?: { events: Partial<Record<NotifyEvent, boolean>> };
};

export type NotifyDraft = Record<NotifyEvent, boolean>;

export type InstanceDraft = Pick<InstanceSettings, "instanceName" | "defaultBranch"> & { logRetentionDays: string; previewDomain: string; terminalEnabled: boolean };

/** The custom preview domain as stored: null while it follows the dashboard domain. */
const customPreview = (s: InstanceSettings) => (s.previewDomainCustom ? s.previewDomain : null);

export const instanceDraft = (s: InstanceSettings): InstanceDraft => ({
  instanceName: s.instanceName,
  defaultBranch: s.defaultBranch,
  logRetentionDays: String(s.logRetentionDays),
  previewDomain: customPreview(s) ?? "",
  terminalEnabled: s.terminalEnabled ?? true,
});

export function instancePatch(s: InstanceSettings, d: InstanceDraft): SettingsPatch {
  const out: SettingsPatch = {};
  const name = d.instanceName.trim();
  const branch = d.defaultBranch.trim();
  const days = Number(d.logRetentionDays);
  const typed = d.previewDomain.trim().toLowerCase();
  // Empty or the derived default means "derive it": the API stores null.
  const preview = typed && typed !== s.previewDomainDefault ? typed : null;
  if (name !== s.instanceName) out.instanceName = name;
  if (branch !== s.defaultBranch) out.defaultBranch = branch;
  if (days !== s.logRetentionDays) out.logRetentionDays = days;
  if (preview !== customPreview(s)) out.previewDomain = preview;
  if (d.terminalEnabled !== (s.terminalEnabled ?? true)) out.terminalEnabled = d.terminalEnabled;
  return out;
}

export function notificationsPatch(s: InstanceSettings, d: NotifyDraft): SettingsPatch {
  const events: Partial<Record<NotifyEvent, boolean>> = {};
  for (const k of Object.keys(d) as NotifyEvent[]) if (d[k] !== s.notifications.events[k]) events[k] = d[k];
  return { notifications: { events } };
}

/** The settings after a patch, for the design preview, where no API answers with the stored row. */
export function applyPatch(s: InstanceSettings, p: SettingsPatch): InstanceSettings {
  const { notifications, previewDomain, ...rest } = p;
  return {
    ...s,
    ...rest,
    notifications: { events: { ...s.notifications.events, ...notifications?.events } },
    ...(previewDomain === undefined ? {} : { previewDomain: previewDomain ?? s.previewDomainDefault ?? null, previewDomainCustom: previewDomain !== null }),
  };
}
