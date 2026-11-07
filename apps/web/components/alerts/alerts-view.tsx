"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { send, usePoll } from "@/components/server-backups/use-poll";
import { Topbar } from "@/components/shell/topbar";
import { ConfirmDialog } from "@/components/ui/dialog";
import { KpiStrip, type KpiData } from "@/components/ui/kpi";
import { NoSource } from "@/components/ui/no-source";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { toast } from "@/components/ui/toast";
import { Updating } from "@/components/ui/updating";
import { deriveNotices } from "@/lib/derive";
import { describe, errText } from "@/lib/feedback";
import { absTime, duration, firstNames, plural } from "@/lib/format";
import { useNow, useOverview } from "@/lib/hooks";
import type { AlertApp, AlertMute, AlertRule, AlertsResult, MuteHours, RuleInput } from "@/lib/pages/alerts";
import type { OverviewResult } from "@/lib/types";
import { useCan } from "@/lib/viewer";
import { HistoryCard } from "./history-card";
import { appName, ruleTitle } from "./labels";
import { MuteDialog } from "./mute-dialog";
import { RuleDialog } from "./rule-dialog";
import { RulesCard, type RuleActions } from "./rules-card";

const DAY = 86_400_000;

/** A failed read keeps the last good snapshot on screen. */
const hasData = (r: AlertsResult) => r.data !== null;

type Editing = { rule: AlertRule | null; presetApp: string | null };

/** The other half of notifications, named in the lead so each page points at the other. */
const ELSEWHERE = (
  <>
    Instance events such as failed backups are set in{" "}
    <Link href="/settings?section=notifications" className="al-link">
      Settings, Notifications
    </Link>
    .
  </>
);

export function AlertsView({ overview, initial }: { overview: OverviewResult; initial: AlertsResult }) {
  const { result: ov } = useOverview(overview);
  const now = useNow(1000, initial.fetchedAt);
  const notices = useMemo(() => (ov.data ? deriveNotices(ov.data, now) : null), [ov.data, now]);
  const { result, setResult, refreshing, hold } = usePoll(initial, "/api/alerts", 15_000, hasData);
  const d = result.data;
  const preview = result.source === "preview";
  const can = useCan();
  // The rule that takes the focus once a deleted one is gone: the next row, else the one before.
  const nextAfterDelete = useRef<string | null>(null);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<AlertRule | null>(null);
  const [muting, setMuting] = useState<AlertApp | null>(null);
  const [unmuting, setUnmuting] = useState<string | null>(null);

  // Per rule: the newest switch request, so only its answer lands, and the last confirmed value.
  const latest = useRef(new Map<string, number>());
  const confirmed = useRef(new Map<string, boolean>());

  const patchRules = (fn: (rules: AlertRule[]) => AlertRule[]) => setResult((p) => (p.data ? { ...p, data: { ...p.data, rules: fn(p.data.rules) } } : p));
  const patchMutes = (fn: (mutes: AlertMute[]) => AlertMute[]) => setResult((p) => (p.data ? { ...p, data: { ...p.data, mutes: fn(p.data.mutes) } } : p));
  const where = (r: Pick<AlertRule, "app">) => (r.app ? appName(r.app) : "Server");

  /* The switch flips at once; a failure rolls back to the last value the API confirmed. */
  const toggle = async (r: AlertRule, enabled: boolean) => {
    if (!confirmed.current.has(r.id)) confirmed.current.set(r.id, r.enabled);
    const n = (latest.current.get(r.id) ?? 0) + 1;
    latest.current.set(r.id, n);
    const release = hold();
    patchRules((rules) => rules.map((x) => (x.id === r.id ? { ...x, enabled } : x)));
    try {
      const next = await send<Partial<AlertRule>>(`/api/alerts/rules/${encodeURIComponent(r.id)}`, "PATCH", { enabled });
      confirmed.current.set(r.id, enabled);
      if (latest.current.get(r.id) !== n) return;
      latest.current.delete(r.id);
      confirmed.current.delete(r.id);
      patchRules((rules) => rules.map((x) => (x.id === r.id ? { ...x, ...next, enabled } : x)));
      toast.success(enabled ? "Rule on" : "Rule off", { description: describe(`${ruleTitle(r)}, ${where(r)}`, { preview }) });
    } catch (e) {
      if (latest.current.get(r.id) !== n) return;
      const back = confirmed.current.get(r.id) ?? !enabled;
      latest.current.delete(r.id);
      confirmed.current.delete(r.id);
      patchRules((rules) => rules.map((x) => (x.id === r.id ? { ...x, enabled: back } : x)));
      toast.error(enabled ? "Could not turn the rule on" : "Could not turn the rule off", { description: `${ruleTitle(r)}, ${where(r)}. ${errText(e)}` });
    } finally {
      release();
    }
  };

  const save = async (input: RuleInput, rule: AlertRule | null): Promise<boolean> => {
    const release = hold();
    try {
      if (rule) {
        const next = await send<Partial<AlertRule>>(`/api/alerts/rules/${encodeURIComponent(rule.id)}`, "PATCH", input);
        const merged: AlertRule = {
          ...rule,
          ...next,
          metric: input.metric,
          service: input.service,
          threshold: input.threshold,
          durationMin: input.durationMin,
          channels: input.channels,
          webhooks: input.webhooks,
          enabled: input.enabled,
        };
        patchRules((rules) => rules.map((x) => (x.id === rule.id ? merged : x)));
        toast.success("Rule saved", { description: describe(`${ruleTitle(merged)}, ${where(merged)}`, { preview }) });
      } else {
        const created = await send<AlertRule>("/api/alerts/rules", "POST", input);
        patchRules((rules) => [...rules, created]);
        toast.success("Rule created", { description: describe(`${ruleTitle(created)}, ${where(created)}`, { preview }) });
      }
      return true;
    } catch (e) {
      toast.error(rule ? "Could not save the rule" : "Could not create the rule", { description: errText(e) });
      return false;
    } finally {
      release();
    }
  };

  const remove = async (r: AlertRule) => {
    try {
      await send(`/api/alerts/rules/${encodeURIComponent(r.id)}`, "DELETE");
    } catch (e) {
      toast.error("Could not delete the rule", { description: `${ruleTitle(r)}, ${where(r)}. ${errText(e)}` });
      throw e;
    }
    const order = [...document.querySelectorAll<HTMLElement>(".al-rules [data-rule]")].map((el) => el.dataset.rule);
    const at = order.indexOf(r.id);
    nextAfterDelete.current = order[at + 1] ?? order[at - 1] ?? null;
    patchRules((rules) => rules.filter((x) => x.id !== r.id));
    toast.success("Rule deleted", { description: describe([`${ruleTitle(r)}, ${where(r)}`, "Its past events stay in the history"], { preview }) });
  };

  const mute = async (app: AlertApp, hours: MuteHours): Promise<boolean> => {
    try {
      const m = await send<AlertMute>(`/api/alerts/mutes/${encodeURIComponent(app.id)}`, "PUT", { hours });
      patchMutes((mutes) => [...mutes.filter((x) => x.appId !== app.id), m]);
      toast.success("Alerts muted", { description: describe(`${appName(app)} until ${absTime(m.until)}`, { preview }) });
      return true;
    } catch (e) {
      toast.error("Could not mute the alerts", { description: `${appName(app)}. ${errText(e)}` });
      return false;
    }
  };

  const unmute = async (app: AlertApp) => {
    if (unmuting) return;
    setUnmuting(app.id);
    try {
      await send(`/api/alerts/mutes/${encodeURIComponent(app.id)}`, "DELETE");
      patchMutes((mutes) => mutes.filter((x) => x.appId !== app.id));
      toast.success("Alerts unmuted", { description: describe(`${appName(app)} notifies again`, { preview }) });
    } catch (e) {
      toast.error("Could not unmute the alerts", { description: `${appName(app)}. ${errText(e)}` });
    } finally {
      setUnmuting(null);
    }
  };

  const actions: RuleActions = {
    onToggle: (r, on) => void toggle(r, on),
    onEdit: (rule) => setEditing({ rule, presetApp: null }),
    onDelete: setDeleting,
    onAdd: (presetApp) => setEditing({ rule: null, presetApp }),
    onMute: setMuting,
    onUnmute: (app) => void unmute(app),
  };

  if (!d) {
    const down = result.source !== "none";
    return (
      <>
        <Topbar trail={["Alerts"]} notices={notices} now={now} />
        <main className="page" id="main" tabIndex={-1}>
          <SectionHead level={1} title="Alerts" lead="Rules that watch the server and every app, and what they caught." />
          <Rule />
          <NoSource icon="bell" error={down ? (result.error ?? "The API did not answer") : null} />
          <Spacer end />
        </main>
      </>
    );
  }

  // -------------- KPI strip --------------
  const firingNow = d.events.filter((e) => e.status === "firing");
  const day = d.events.filter((e) => now - Date.parse(e.startedAt) <= DAY);
  const dayResolved = day.filter((e) => e.status === "resolved").length;
  const mutedApps = [...new Set(d.mutes.filter((m) => Date.parse(m.until) > now).map((m) => m.appId))];
  const mutedRules = d.rules.filter((r) => r.app && mutedApps.includes(r.app.id));
  const soonest = d.mutes.filter((m) => Date.parse(m.until) > now).sort((a, b) => Date.parse(a.until) - Date.parse(b.until))[0];
  const firingNames = [...new Set(firingNow.map((e) => (e.app ? appName(e.app) : "Server")))];
  const mutedNames = [...new Set(mutedRules.map((r) => appName(r.app!)))];

  const kpis: KpiData[] = [
    {
      icon: "alert",
      label: "Firing now",
      value: firingNow.length,
      tone: firingNow.length ? "bad" : undefined,
      lead: firingNow.length ? firstNames(firingNames) : "All clear",
    },
    {
      icon: "history",
      label: "Fired, 24 hours",
      value: day.length,
      lead: day.length ? `${dayResolved} resolved, ${day.length - dayResolved} still firing` : "Nothing fired today",
    },
    {
      icon: "pause",
      label: "Muted rules",
      value: mutedRules.length,
      lead: soonest ? `${firstNames(mutedNames)}, ${duration(Math.max(60, Math.ceil((Date.parse(soonest.until) - now) / 60_000) * 60))} left` : "Nothing muted",
    },
  ];

  const lead = (
    <>
      {d.rules.length
        ? `${plural(d.rules.length, "rule")}, ${firingNow.length ? `${firingNow.length} firing now` : "all quiet"}. `
        : "Rules that watch the server and every app, and what they caught. "}
      {ELSEWHERE}
    </>
  );

  const muteRules = muting ? d.rules.filter((r) => r.app?.id === muting.id).length : 0;
  // Nothing set up and nothing ever fired: the rules card's empty state is the whole page, not
  // three zeros over two empty cards.
  const blank = d.rules.length === 0 && d.events.length === 0;

  return (
    <>
      <Topbar trail={["Alerts"]} notices={notices} now={now} />
      <main className="page" id="main" tabIndex={-1}>
        <SectionHead
          level={1}
          title="Alerts"
          lead={lead}
          actions={
            refreshing || can.manage ? (
              <>
                {refreshing ? <Updating /> : null}
                {can.manage ? (
                  <button type="button" className="btn btn-primary" onClick={() => setEditing({ rule: null, presetApp: null })}>
                    <Icon name="plus" />
                    New rule
                  </button>
                ) : null}
              </>
            ) : null
          }
        />
        <Rule />
        {blank ? null : (
          <>
            <KpiStrip label="Alert summary" cells={kpis} />
            <Spacer />
          </>
        )}
        <RulesCard rules={d.rules} mutes={d.mutes} webhooks={d.webhooks} now={now} a={actions} unmuting={unmuting} />
        {blank ? null : (
          <>
            <Spacer />
            <HistoryCard events={d.events} rules={d.rules} now={now} />
          </>
        )}
        <Spacer end />

        {editing ? (
          <RuleDialog
            key={editing.rule?.id ?? `new-${editing.presetApp ?? "server"}`}
            rule={editing.rule}
            presetApp={editing.presetApp}
            apps={ov.data?.resources ?? []}
            rules={d.rules}
            channels={d.channels}
            webhooks={d.webhooks}
            onClose={() => setEditing(null)}
            onSave={(input) => save(input, editing.rule)}
          />
        ) : null}
        {muting ? <MuteDialog key={muting.id} app={muting} rules={muteRules} now={now} onClose={() => setMuting(null)} onMute={(h) => mute(muting, h)} /> : null}
        <ConfirmDialog
          open={deleting !== null}
          onClose={() => setDeleting(null)}
          tone="danger"
          title="Delete rule"
          sub={deleting ? where(deleting) : undefined}
          body={deleting ? `${ruleTitle(deleting)} stops watching ${deleting.app ? appName(deleting.app) : "the server"}. Its past events stay in the history.` : ""}
          confirmLabel="Delete rule"
          confirmIcon="trash"
          onConfirm={async () => {
            if (deleting) await remove(deleting);
          }}
          returnFocus={() => {
            const id = nextAfterDelete.current;
            return id ? document.querySelector<HTMLElement>(`[data-rule="${CSS.escape(id)}"] .al-rule-keys button`) : null;
          }}
        />
      </main>
    </>
  );
}
