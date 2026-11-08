"use client";

import { ToggleRow } from "@/components/project-detail/controls";
import { TextInput } from "@/components/ui/field";
import type { InstanceSettings } from "@/lib/pages/activity-settings";
import { useCan } from "@/lib/viewer";
import { DashboardDomainGroup } from "./dashboard-domain-group";
import { Group, SaveBar, SettingRow } from "./form";
import { Segment, SectionTabs } from "./section-tabs";
import { useSettingsDraft } from "./settings-draft";
import type { SectionProps } from "./settings-view";
import { BRANCH_NAME, displayNameProblem } from "@/lib/validation";

/* Settings, Instance: the defaults every project on this server shares. The reset lives in Danger zone. */

/** A branch name, as packages/contracts Branch: no leading or trailing slash, no "//" or "..". */

type InstanceDraft = Pick<InstanceSettings, "instanceName" | "defaultBranch"> & { buildConcurrency: string; logRetentionDays: string; previewDomain: string; terminalEnabled: boolean };

const PREVIEW_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function InstanceSection(props: SectionProps) {
  const { manage } = useCan();
  const { draft, setDraft, dirty, saving, error, save, discard } = useSettingsDraft<InstanceDraft>(
    (s) => ({
      instanceName: s.instanceName,
      defaultBranch: s.defaultBranch,
      buildConcurrency: String(s.buildConcurrency),
      logRetentionDays: String(s.logRetentionDays),
      previewDomain: s.previewDomainCustom ? (s.previewDomain ?? "") : "",
      terminalEnabled: s.terminalEnabled ?? true,
    }),
    (s, d) => ({
      ...s,
      instanceName: d.instanceName.trim(),
      defaultBranch: d.defaultBranch.trim(),
      buildConcurrency: Number(d.buildConcurrency),
      logRetentionDays: Number(d.logRetentionDays),
      // Empty or the derived default means "derive it": the API stores null.
      previewDomain: d.previewDomain.trim() && d.previewDomain.trim().toLowerCase() !== s.previewDomainDefault ? d.previewDomain.trim().toLowerCase() : null,
      terminalEnabled: d.terminalEnabled,
    }),
    props,
  );
  const previewDefault = props.data.settings.previewDomainDefault ?? null;

  const days = Number(draft.logRetentionDays);
  const errors = {
    instanceName: displayNameProblem(draft.instanceName, { empty: "Give the instance a name" }),
    defaultBranch: BRANCH_NAME.test(draft.defaultBranch.trim()) ? null : "Use a branch name like main",
    logRetentionDays: Number.isInteger(days) && days >= 1 && days <= 365 ? null : "Between 1 and 365 days",
    previewDomain: !draft.previewDomain.trim() || PREVIEW_HOST.test(draft.previewDomain.trim().toLowerCase()) ? null : "Use a hostname like preview.example.com",
  };
  const valid = Object.values(errors).every((e) => !e);
  const set = (patch: Partial<InstanceDraft>) => setDraft({ ...draft, ...patch });
  // A Viewer reads the defaults; the fields stay put.
  const readOnly = !manage;

  return (
    <>
      <SectionTabs section="instance" tab={props.tab} onTab={props.onTab}>
        <Segment value="domain" tab={props.tab}>
          <DashboardDomainGroup url={props.data.settings.publicUrl} manage={manage} preview={props.preview} />
        </Segment>
        <Segment value="general" tab={props.tab}>
          <Group id="set-instance" icon="server" title="Instance" sub={manage ? "Defaults for every project on this server" : "Defaults for every project on this server. Only an admin can change them"}>
            <SettingRow label="Instance name" desc="Shown on the sign-in page, in invites and in emails." error={errors.instanceName}>
              {(ids) => <TextInput ids={ids} value={draft.instanceName} maxLength={60} readOnly={readOnly} onChange={(e) => set({ instanceName: e.target.value })} />}
            </SettingRow>
            <SettingRow label="Default branch" desc="New projects deploy from it." error={errors.defaultBranch}>
              {(ids) => <TextInput ids={ids} spellCheck={false} value={draft.defaultBranch} readOnly={readOnly} onChange={(e) => set({ defaultBranch: e.target.value })} />}
            </SettingRow>
            {/* No Build concurrency row: deploys run one at a time on the worker's deploy lane, which also
                keeps route syncs from overlapping a swap, so a higher number would change nothing. */}
            <SettingRow label="Preview domain" desc="Previews answer on pr-<n>-<app> under it. Leave empty for the default." error={errors.previewDomain}>
              {(ids) => (
                <TextInput
                  ids={ids}
                  spellCheck={false}
                  autoCapitalize="off"
                  placeholder={previewDefault ?? "preview.example.com"}
                  value={draft.previewDomain}
                  readOnly={readOnly}
                  onChange={(e) => set({ previewDomain: e.target.value })}
                />
              )}
            </SettingRow>
            <SettingRow label="Log retention" desc="Runtime logs older than this are deleted. A build log stays with its deployment." error={errors.logRetentionDays}>
              {(ids) => (
                <span className="field-unit">
                  <TextInput
                    ids={ids}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={365}
                    value={draft.logRetentionDays}
                    readOnly={readOnly}
                    onChange={(e) => set({ logRetentionDays: e.target.value })}
                  />
                  <span className="field-unit-text" aria-hidden="true">
                    days
                  </span>
                </span>
              )}
            </SettingRow>
            {manage ? (
              <ToggleRow
                title="Web terminal"
                body="Lets admins open a shell inside an app's or database's container, after confirming it is them. Off closes every open session within seconds and refuses new ones."
                checked={draft.terminalEnabled}
                onChange={(terminalEnabled) => set({ terminalEnabled })}
              />
            ) : null}
          </Group>
        </Segment>
      </SectionTabs>

      <SaveBar dirty={dirty} saving={saving} error={valid ? null : error} onDiscard={discard} onSave={() => void save(valid, "Instance settings saved", draft.instanceName.trim())} />
    </>
  );
}
