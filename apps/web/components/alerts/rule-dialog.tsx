"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/icon";
import { Dialog } from "@/components/ui/dialog";
import { envName } from "@/components/ui/env-tag";
import { Field, TextInput } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { Segmented } from "@/components/ui/segmented";
import { Select, type SelectOption } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { APP_TONE } from "@/lib/derive";
import { projectsShowingEnvironments } from "@/lib/environments";
import { appTitle, plural } from "@/lib/format";
import {
  APP_METRICS,
  CHANNELS,
  DURATIONS,
  SERVER_METRICS,
  SERVICES,
  THRESHOLD,
  type AlertChannel,
  type AlertMetric,
  type AlertRule,
  type AlertsPayload,
  type ControlService,
  type RuleInput,
} from "@/lib/pages/alerts-shared";
import type { Resource } from "@/lib/types";
import { providerLabel, type WebhookRef } from "@/lib/webhooks";
import { WebhookMark } from "@/components/activity-settings/integrations/webhook-mark";
import { CHANNEL_ICON, CHANNEL_NAME, METRIC_HINT, METRIC_ICON, METRIC_NAME, SERVICE_NAME } from "./labels";

type Scope = "server" | "app";

interface Draft {
  scope: Scope;
  appId: string;
  metric: AlertMetric;
  service: ControlService;
  threshold: string;
  durationMin: string;
  channels: AlertChannel[];
  webhooks: string[];
  enabled: boolean;
}

/** Same metric, app and service as another rule: the API refuses that with a 409. */
const sameRule = (a: Pick<AlertRule, "metric" | "service">, appId: string | null, b: AlertRule) =>
  a.metric === b.metric && (appId ?? null) === (b.app?.id ?? null) && (a.service ?? null) === (b.service ?? null);

function draftOf(rule: AlertRule | null, presetApp: string | null, channels: AlertsPayload["channels"], webhooks: WebhookRef[], rules: AlertRule[]): Draft {
  if (rule) {
    return {
      scope: rule.app ? "app" : "server",
      appId: rule.app?.id ?? "",
      metric: rule.metric,
      service: rule.service ?? "any",
      threshold: rule.threshold === null ? "" : String(rule.threshold),
      durationMin: String(rule.durationMin),
      channels: rule.channels,
      webhooks: rule.webhooks,
      enabled: rule.enabled,
    };
  }
  // The first condition this target has no rule for yet, so a new rule never opens as a duplicate.
  // When the server already has a rule for every condition, a new rule starts on an app instead.
  const free = (options: AlertMetric[], app: string | null) => options.find((m) => !rules.some((r) => sameRule({ metric: m, service: m === "service" ? "any" : null }, app, r)));
  const serverFree = presetApp ? undefined : free(SERVER_METRICS, null);
  const onApp = Boolean(presetApp) || !serverFree;
  const metric = presetApp ? (free(APP_METRICS, presetApp) ?? APP_METRICS[0]!) : (serverFree ?? APP_METRICS[0]!);
  const range = THRESHOLD[metric];
  return {
    scope: onApp ? "app" : "server",
    appId: presetApp ?? "",
    metric,
    service: "any",
    threshold: range ? String(range.fallback) : "",
    durationMin: "5",
    // New rules notify every channel that is set up: each webhook that is on, email, the bell.
    channels: [...(channels.email ? (["email"] as const) : []), "bell"],
    webhooks: webhooks.filter((w) => w.enabled).map((w) => w.id),
    enabled: true,
  };
}

export function RuleDialog({
  rule,
  presetApp,
  apps,
  rules,
  channels,
  webhooks,
  onClose,
  onSave,
}: {
  rule: AlertRule | null;
  presetApp: string | null;
  apps: Resource[];
  rules: AlertRule[];
  channels: AlertsPayload["channels"];
  webhooks: WebhookRef[];
  onClose: () => void;
  /** Resolves true when saved, so the dialog closes; false keeps it open. */
  onSave: (input: RuleInput) => Promise<boolean>;
}) {
  const [d, setD] = useState<Draft>(() => draftOf(rule, presetApp, channels, webhooks, rules));
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  const range = THRESHOLD[d.metric];
  const t = Number(d.threshold);
  const tErr = range && (!d.threshold.trim() || !Number.isInteger(t) || t < range.min || t > range.max) ? `Enter a whole number from ${range.min} to ${range.max}` : null;
  const appErr = d.scope === "app" && !d.appId ? "Pick the app to watch" : null;
  // A rule may still name a webhook removed since; saving drops that link.
  const live = d.webhooks.filter((id) => webhooks.some((w) => w.id === id));
  const chErr = d.channels.length === 0 && live.length === 0 ? "Pick at least one channel" : null;
  const appId = d.scope === "app" ? d.appId : null;
  const service = d.metric === "service" ? d.service : null;
  const dupe = rules.some((r) => r.id !== rule?.id && sameRule({ metric: d.metric, service }, appId, r));
  const dupeErr = dupe ? "A rule for this already exists. Edit that one instead." : null;
  const valid = !tErr && !appErr && !chErr && !dupe;

  const pickScope = (scope: Scope) => {
    const metric = scope === "server" ? SERVER_METRICS[0]! : APP_METRICS[0]!;
    const r = THRESHOLD[metric];
    set({ scope, metric, threshold: r ? String(r.fallback) : "" });
  };
  const pickMetric = (metric: AlertMetric) => {
    const r = THRESHOLD[metric];
    const keep = r && Number(d.threshold) >= r.min && Number(d.threshold) <= r.max && d.threshold.trim();
    set({ metric, threshold: r ? (keep ? d.threshold : String(r.fallback)) : "", durationMin: metric === "crashLoop" ? "10" : d.durationMin });
  };
  const toggleChannel = (c: AlertChannel, on: boolean) =>
    set({ channels: on ? CHANNELS.filter((x) => x === c || d.channels.includes(x)) : d.channels.filter((x) => x !== c) });
  // Kept in the order the webhooks were added, so a saved rule reads the same as the list.
  const toggleWebhook = (id: string, on: boolean) =>
    set({ webhooks: on ? webhooks.filter((w) => w.id === id || d.webhooks.includes(w.id)).map((w) => w.id) : d.webhooks.filter((x) => x !== id) });

  const submit = async () => {
    setTried(true);
    if (!valid || busy) return;
    setBusy(true);
    const ok = await onSave({
      metric: d.metric,
      appId,
      service,
      threshold: range ? t : null,
      durationMin: Number(d.durationMin),
      channels: d.channels,
      webhooks: live,
      enabled: d.enabled,
    });
    setBusy(false);
    if (ok) onClose();
  };

  const metricOptions: SelectOption<AlertMetric>[] = (d.scope === "server" ? SERVER_METRICS : APP_METRICS).map((m) => ({ value: m, label: METRIC_NAME[m], icon: METRIC_ICON[m] }));
  const shows = projectsShowingEnvironments(apps);
  const appOptions: SelectOption<string>[] = [...apps]
    .sort((a, b) => `${a.projectSlug}/${appTitle(a)}/${a.environment}`.localeCompare(`${b.projectSlug}/${appTitle(b)}/${b.environment}`))
    .map((a) => ({ value: a.id, label: `${a.projectSlug} / ${appTitle(a)}`, hint: shows(a.projectSlug) ? envName(a.environment) : undefined, tone: APP_TONE[a.status] }));
  // An edited rule whose app is gone still shows its name.
  if (rule?.app && !apps.some((a) => a.id === rule.app!.id)) appOptions.unshift({ value: rule.app.id, label: `${rule.app.projectSlug} / ${appTitle(rule.app)}`, hint: "Removed" });

  const durOptions: SelectOption<string>[] = DURATIONS.map((n) => ({ value: String(n), label: plural(n, "minute") }));
  const show = (e: string | null) => (tried ? e : null);

  return (
    <Dialog
      open
      onClose={onClose}
      title={rule ? "Edit alert rule" : "New alert rule"}
      sub={rule ? "Changes apply from the next sample" : "Notify a channel when a condition holds"}
      icon="bell"
      busy={busy}
      onSubmit={() => void submit()}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {/* Never disabled: a key that turns off under the focus drops it, and a press on a form
              with problems shows them instead of saving. */}
          <PendingButton type="submit" className="btn btn-primary" pending={busy} icon={rule ? "check" : "plus"}>
            {rule ? "Save rule" : "Create rule"}
          </PendingButton>
        </>
      }
    >
      <div className="al-form">
        <Field label="Watch">
          {(ids) => (
            <Segmented
              ids={ids}
              label="What the rule watches"
              value={d.scope}
              onChange={pickScope}
              options={[
                { value: "server", label: "Server" },
                { value: "app", label: "An app" },
              ]}
            />
          )}
        </Field>

        {d.scope === "app" ? (
          <Field label="App" error={show(appErr)}>
            {(ids) => <Select ids={ids} label="App" value={d.appId || null} options={appOptions} onChange={(appId) => set({ appId })} placeholder="Pick an app" icon={d.appId ? undefined : "box"} />}
          </Field>
        ) : null}

        <Field label="Condition" hint={METRIC_HINT[d.metric]}>
          {(ids) => <Select ids={ids} label="Condition" value={d.metric} options={metricOptions} onChange={pickMetric} />}
        </Field>

        {d.metric === "service" ? (
          <Field label="Service">
            {(ids) => (
              <Select ids={ids} label="Service" value={d.service} onChange={(service) => set({ service })} options={SERVICES.map((s) => ({ value: s, label: SERVICE_NAME[s] }))} />
            )}
          </Field>
        ) : null}

        <div className="al-form-pair">
          {range ? (
            <Field label={d.metric === "crashLoop" ? "Restarts" : "Threshold"} error={show(tErr)} hint={d.metric === "crashLoop" ? `${range.min} to ${range.max}` : `${range.min}% to ${range.max}%`}>
              {(ids) => (
                <span className="field-unit">
                  <TextInput ids={ids} inputMode="numeric" value={d.threshold} onChange={(e) => set({ threshold: e.target.value.replace(/[^\d]/g, "").slice(0, 3) })} className="num" />
                  <span className="field-unit-text" aria-hidden="true">
                    {d.metric === "crashLoop" ? "times" : "%"}
                  </span>
                </span>
              )}
            </Field>
          ) : null}
          <Field label={d.metric === "crashLoop" ? "Within" : "For at least"}>
            {(ids) => <Select ids={ids} label={d.metric === "crashLoop" ? "Window" : "Duration"} value={d.durationMin} options={durOptions} onChange={(durationMin) => set({ durationMin })} icon="clock" />}
          </Field>
        </div>

        <fieldset className="al-channels" aria-describedby={show(chErr) ? "al-ch-err" : undefined}>
          <legend className="fld-label">Notify</legend>
          {webhooks.map((w) => {
            const checked = d.webhooks.includes(w.id);
            return (
              <label key={w.id} className="al-channel" data-off={!w.enabled || undefined}>
                <input type="checkbox" checked={checked} disabled={!w.enabled && !checked} onChange={(e) => toggleWebhook(w.id, e.target.checked)} />
                <WebhookMark webhook={w} size={14} />
                <span className="two">
                  <span className="two-main">{w.name}</span>
                  <span className="two-sub">{w.enabled ? providerLabel(w.provider) : `${providerLabel(w.provider)}, switched off in Settings`}</span>
                </span>
              </label>
            );
          })}
          {!webhooks.length ? (
            <label className="al-channel" data-off="true">
              <input type="checkbox" disabled />
              <Icon name="webhook" size={14} />
              <span className="two">
                <span className="two-main">Webhooks</span>
                <span className="two-sub">
                  No webhooks yet. <Link href="/settings?section=integrations">Add Discord, Slack or another in Settings</Link>
                </span>
              </span>
            </label>
          ) : null}
          {CHANNELS.map((c) => {
            const ready = c === "bell" || channels.email;
            const checked = d.channels.includes(c);
            return (
              <label key={c} className="al-channel" data-off={!ready || undefined}>
                <input type="checkbox" checked={checked} disabled={!ready && !checked} onChange={(e) => toggleChannel(c, e.target.checked)} />
                <Icon name={CHANNEL_ICON[c]} size={14} />
                <span className="two">
                  <span className="two-main">{CHANNEL_NAME[c]}</span>
                  <span className="two-sub">
                    {c === "bell" ? (
                      "The notifications panel in this dashboard"
                    ) : ready ? (
                      "Every admin, through your mail server"
                    ) : (
                      <>
                        Email is not set up. <Link href="/settings?section=integrations">Connect it in Settings</Link>
                      </>
                    )}
                  </span>
                </span>
              </label>
            );
          })}
          {show(chErr) ? (
            <span id="al-ch-err" className="al-err" role="alert">
              {chErr}
            </span>
          ) : null}
        </fieldset>

        <label className="al-enable">
          <span className="two">
            <span className="two-main">Rule on</span>
            <span className="two-sub">An off rule keeps its settings and never fires.</span>
          </span>
          <Switch checked={d.enabled} onChange={(enabled) => set({ enabled })} label="Rule on" />
        </label>

        {dupeErr ? (
          <p className="al-err" role="alert">
            {dupeErr}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
