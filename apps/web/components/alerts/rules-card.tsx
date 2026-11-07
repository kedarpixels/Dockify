"use client";

import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { AppIcon } from "@/components/icons/app-icon";
import { Chip } from "@/components/ui/chip";
import { Empty } from "@/components/ui/empty";
import { GroupHead } from "@/components/ui/group-head";
import { IconTile } from "@/components/ui/icon-tile";
import { PendingButton } from "@/components/ui/pending";
import { Switch } from "@/components/ui/switch";
import { When } from "@/components/ui/when";
import { duration, plural } from "@/lib/format";
import { useTimeFormat } from "@/lib/time-prefs";
import type { AlertApp, AlertMute, AlertRule } from "@/lib/pages/alerts";
import { useCan } from "@/lib/viewer";
import type { WebhookRef } from "@/lib/webhooks";
import { WebhookMark } from "@/components/activity-settings/integrations/webhook-mark";
import { appName, CHANNEL_ICON, CHANNEL_NAME, METRIC_ICON, ruleTitle, ruleWhen } from "./labels";

export interface RuleActions {
  onToggle: (r: AlertRule, on: boolean) => void;
  onEdit: (r: AlertRule) => void;
  onDelete: (r: AlertRule) => void;
  /** Opens the editor for a new rule, on this app when one is given. */
  onAdd: (appId: string | null) => void;
  onMute: (app: AlertApp) => void;
  onUnmute: (app: AlertApp) => void;
}

/** The mute that is still running for an app, if any. */
const activeMute = (mutes: AlertMute[], appId: string, now: number) => mutes.find((m) => m.appId === appId && Date.parse(m.until) > now);

/** A row shows this many channel tiles at most; past that the last tile counts the rest. */
const MAX_TILES = 5;

/** Where a rule sends, as tiles: its webhooks in the order they were added, then email and the bell. */
function ChannelTiles({ r, webhooks }: { r: AlertRule; webhooks: WebhookRef[] }) {
  const tiles = [
    ...webhooks.filter((w) => r.webhooks.includes(w.id)).map((w) => ({ key: w.id, name: w.name, glyph: <WebhookMark webhook={w} size={14} /> })),
    ...r.channels.map((c) => ({ key: c, name: CHANNEL_NAME[c], glyph: <Icon name={CHANNEL_ICON[c]} size={14} /> })),
  ];
  const shown = tiles.length > MAX_TILES ? tiles.slice(0, MAX_TILES - 1) : tiles;
  const rest = tiles.slice(shown.length);
  return (
    <span className="al-rule-ch" role="img" aria-label={`Notifies ${tiles.map((t) => t.name).join(", ")}`}>
      {shown.map((t) => (
        <IconTile key={t.key} className="al-ch-key" data-tip={t.name}>
          {t.glyph}
        </IconTile>
      ))}
      {rest.length ? (
        <IconTile className="al-ch-key al-ch-more num" data-tip={rest.map((t) => t.name).join(", ")}>
          +{rest.length}
        </IconTile>
      ) : null}
    </span>
  );
}

function RuleRow({ r, now, a, manage, webhooks }: { r: AlertRule; now: number; a: RuleActions; manage: boolean; webhooks: WebhookRef[] }) {
  const title = ruleTitle(r);
  const where = r.app ? appName(r.app) : "the server";
  return (
    <li className="soft-row al-rule" data-hover="true" data-off={!r.enabled || undefined} data-rule={r.id}>
      <IconTile size="sm" className="al-rule-tile">
        <Icon name={METRIC_ICON[r.metric]} />
      </IconTile>
      <span className="al-rule-id two">
        <span className="two-main">
          <span>{title}</span>
          {r.enabled && r.firing ? (
            <Chip size="xs" tone="bad">
              Firing
            </Chip>
          ) : null}
          {!r.enabled ? <Chip size="xs">Off</Chip> : null}
        </span>
        <span className="two-sub">
          {ruleWhen(r)}, <When iso={r.lastFiredAt} now={now} prefix="last fired" fallback="never fired" />
        </span>
      </span>
      <ChannelTiles r={r} webhooks={webhooks} />
      {manage ? (
        <>
          <Switch className="al-rule-sw" checked={r.enabled} onChange={(on) => a.onToggle(r, on)} label={`${title} on ${where}`} />
          <span className="al-rule-keys">
            <button type="button" className="btn btn-xs btn-icon" aria-label={`Edit ${title} on ${where}`} onClick={() => a.onEdit(r)}>
              <Icon name="edit" />
            </button>
            <button type="button" className="btn btn-xs btn-icon btn-quiet-danger" aria-label={`Delete ${title} on ${where}`} onClick={() => a.onDelete(r)}>
              <Icon name="trash" />
            </button>
          </span>
        </>
      ) : null}
    </li>
  );
}

/** The mute state and keys at the right of an app's group head. */
function MuteKeys({ app, mute, now, a, pending }: { app: AlertApp; mute: AlertMute | undefined; now: number; a: RuleActions; pending: boolean }) {
  const time = useTimeFormat();
  const name = appName(app);
  if (!mute) {
    return (
      <button type="button" className="btn btn-xs" aria-label={`Mute alerts for ${name}`} onClick={() => a.onMute(app)}>
        Mute
      </button>
    );
  }
  // Rounded up to the minute, so the chip never reads "0s left".
  const left = Math.max(60, Math.ceil((Date.parse(mute.until) - now) / 60_000) * 60);
  return (
    <>
      <span className="al-muted" data-tip={`Muted until ${time.abs(mute.until)}`} data-tip-align="end">
        <Chip size="xs" icon={<Icon name="pause" size={12} />} className="num">
          Muted, {duration(left)} left
        </Chip>
      </span>
      <PendingButton className="btn btn-xs" aria-label={`Unmute alerts for ${name}`} pending={pending} onClick={() => a.onUnmute(app)}>
        Unmute
      </PendingButton>
    </>
  );
}

/**
 * Every rule, grouped: the server's own rules first, then one group per app (firing apps on top,
 * then by name). Each app group carries its mute state and a New rule key for that app. A Viewer
 * reads the rules without the keys that change them.
 */
export function RulesCard({
  rules,
  mutes,
  webhooks,
  now,
  a,
  unmuting,
}: {
  rules: AlertRule[];
  mutes: AlertMute[];
  /** Names and marks for each rule's webhooks. */
  webhooks: WebhookRef[];
  now: number;
  a: RuleActions;
  /** The app whose unmute is on its way. */
  unmuting: string | null;
}) {
  const { manage } = useCan();
  const server = rules.filter((r) => !r.app);
  const byApp = new Map<string, { app: AlertApp; rules: AlertRule[] }>();
  for (const r of rules) {
    if (!r.app) continue;
    const g = byApp.get(r.app.id) ?? { app: r.app, rules: [] };
    g.rules.push(r);
    byApp.set(r.app.id, g);
  }
  const hot = (g: { rules: AlertRule[] }) => (g.rules.some((r) => r.firing && r.enabled) ? 0 : 1);
  const groups = [...byApp.values()].sort((x, y) => hot(x) - hot(y) || appName(x.app).localeCompare(appName(y.app)));
  const on = rules.filter((r) => r.enabled).length;
  const sub = rules.length ? `${plural(rules.length, "rule")}, ${on} on${manage ? "" : ". An admin can change them"}` : "Nothing is watched yet";

  return (
    <section className="card al-rules" aria-labelledby="al-rules-title">
      <div className="card-hd">
        <CardTitle id="al-rules-title" icon="sliders" title="Rules" sub={sub} />
      </div>
      {rules.length === 0 ? (
        <Empty
          icon="bell"
          title="No alert rules yet"
          body={
            manage
              ? "Watch the server disk and the control plane, or an app going down, crash looping or running out of memory."
              : "Rules watch the server disk and the control plane, or an app going down. An admin can add them."
          }
          action={
            manage ? (
              <button type="button" className="btn btn-sm" onClick={() => a.onAdd(null)}>
                New rule
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="al-wrap">
          <section className="al-group" aria-label="Server rules">
            <GroupHead
              label="Server"
              icon="server"
              count={server.length}
              noun="rule"
              actions={
                manage ? (
                  <button type="button" className="btn btn-xs" aria-label="New rule for the server" onClick={() => a.onAdd(null)}>
                    New rule
                  </button>
                ) : undefined
              }
            />
            {server.length ? (
              <ul className="soft-list">
                {server.map((r) => (
                  <RuleRow key={r.id} r={r} now={now} a={a} manage={manage} webhooks={webhooks} />
                ))}
              </ul>
            ) : (
              <p className="al-group-none">No server rules yet. They watch the disk and the control-plane services.</p>
            )}
          </section>
          {groups.map((g) => {
            const mute = activeMute(mutes, g.app.id, now);
            const name = appName(g.app);
            return (
              <section key={g.app.id} className="al-group" aria-label={`${name} rules`} data-muted={mute ? true : undefined}>
                <GroupHead
                  label={name}
                  lead={<AppIcon id={g.app.id} kind={g.app.kind} />}
                  count={g.rules.length}
                  noun="rule"
                  actions={
                    manage ? (
                      <>
                        <MuteKeys app={g.app} mute={mute} now={now} a={a} pending={unmuting === g.app.id} />
                        <button type="button" className="btn btn-xs" aria-label={`New rule for ${name}`} onClick={() => a.onAdd(g.app.id)}>
                          New rule
                        </button>
                      </>
                    ) : mute ? (
                      <Chip size="xs" icon={<Icon name="pause" size={12} />}>
                        Muted
                      </Chip>
                    ) : undefined
                  }
                />
                <ul className="soft-list">
                  {g.rules.map((r) => (
                    <RuleRow key={r.id} r={r} now={now} a={a} manage={manage} webhooks={webhooks} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
