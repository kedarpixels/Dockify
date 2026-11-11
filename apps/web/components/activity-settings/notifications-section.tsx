"use client";

import Link from "next/link";
import { Switch } from "@/components/ui/switch";
import type { NotifyEvent } from "@/lib/pages/activity-settings";
import { useCan } from "@/lib/viewer";
import { Group, SaveBar, SettingRow } from "./form";
import { Segment, SectionTabs } from "./section-tabs";
import { useSettingsDraft } from "./settings-draft";
import { notificationsPatch, type NotifyDraft } from "./settings-patch";
import type { SectionProps } from "./settings-view";

/* Instance events only. Rules for the server and each app live in Alerts. */

const EVENTS: Array<{ id: NotifyEvent; label: string; hint: string }> = [
  { id: "deployFailed", label: "Deploy failed", hint: "A deploy fails, here or on Vercel. Webhooks, and email to who started it." },
  { id: "appDown", label: "App down", hint: "An app stops answering. Off, alert rules only show in the bell." },
  { id: "backupFailed", label: "Backup failed", hint: "A scheduled backup does not finish. Webhooks, and email to admins." },
  { id: "jobFailed", label: "Scheduled job failed", hint: "A scheduled job starts failing. Webhooks, and email to admins." },
  { id: "tlsExpiring", label: "TLS expiring", hint: "A certificate has under 14 days left. Webhooks, and email to admins." },
  { id: "previewDeployments", label: "Preview deployments", hint: "A preview is ready or fails. Email to who opened the PR, or to admins." },
];

function EventRow({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <SettingRow
      label={label}
      desc={hint}
      className="set-row-toggle"
      onClick={(e) => {
        if (!disabled && !(e.target instanceof Element && e.target.closest("button, label"))) onChange(!checked);
      }}
    >
      {(ids) => <Switch ids={ids} checked={checked} disabled={disabled} onChange={onChange} />}
    </SettingRow>
  );
}

export function NotificationsSection(props: SectionProps) {
  const { manage } = useCan();
  const { draft, setDraft, dirty, saving, error, save, discard } = useSettingsDraft<NotifyDraft>(
    (s) => ({ ...s.notifications.events }),
    notificationsPatch,
    props,
  );
  const on = EVENTS.filter((e) => draft[e.id]).length;

  const openChannels = () => {
    props.go("integrations");
    requestAnimationFrame(() => document.getElementById("int-webhooks")?.scrollIntoView({ block: "center" }));
  };

  return (
    <>
      <SectionTabs section="notifications" tab={props.tab} onTab={props.onTab}>
        <Segment value="events" tab={props.tab}>
          <Group
            id="set-events"
            icon="bell"
            title="Events"
            sub={`${on} of ${EVENTS.length} events notify${manage ? "" : ". Only an admin can change them"}`}
          >
            {EVENTS.map((e) => (
              <EventRow key={e.id} label={e.label} hint={e.hint} checked={draft[e.id]} disabled={!manage} onChange={(v) => setDraft({ ...draft, [e.id]: v })} />
            ))}
          </Group>
        </Segment>
        <Segment value="channels" tab={props.tab}>
          <Group id="set-channels" icon="webhook" title="Channels" sub="Where notifications are sent">
            <SettingRow label="Webhooks" desc="Discord, Slack, Microsoft Teams, Google Chat, Telegram, Mattermost, Rocket.Chat, ntfy or any https endpoint, set up under Integrations with a test message for each.">
              <button type="button" className="btn btn-sm" onClick={openChannels}>
                Open integrations
              </button>
            </SettingRow>
            <SettingRow label="Alert rules" desc="Each rule picks its webhooks, email and the in-app bell. Rules for the server and each app, and what they caught, live in Alerts.">
              <Link href="/alerts" className="btn btn-sm">
                Open alerts
              </Link>
            </SettingRow>
          </Group>
        </Segment>
      </SectionTabs>
      <SaveBar dirty={dirty} saving={saving} error={error} onDiscard={discard} onSave={() => void save(true, "Notifications saved", `${on} of ${EVENTS.length} events notify`)} />
    </>
  );
}
