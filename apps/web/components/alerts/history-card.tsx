"use client";

import Link from "next/link";
import { useState } from "react";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { Chip, StatusChip } from "@/components/ui/chip";
import { Empty } from "@/components/ui/empty";
import { GroupHead } from "@/components/ui/group-head";
import { IconTile } from "@/components/ui/icon-tile";
import { Segmented, filterOptions } from "@/components/ui/segmented";
import { When } from "@/components/ui/when";
import { duration, plural } from "@/lib/format";
import { useDayHeading } from "@/lib/time-prefs";
import type { AlertEvent, AlertRule } from "@/lib/pages/alerts";
import { appName, METRIC_ICON, METRIC_NAME, ruleTitle, SERVICE_NAME } from "./labels";

type Filter = "all" | "firing" | "resolved";

/** A title for an event whose rule was deleted since: the condition, its threshold no longer known. */
const ORPHAN_TITLE: Record<AlertEvent["metric"], string> = {
  disk: `${METRIC_NAME.disk} its threshold`,
  service: METRIC_NAME.service,
  down: METRIC_NAME.down,
  crashLoop: METRIC_NAME.crashLoop,
  memory: `${METRIC_NAME.memory} its threshold`,
};

function title(e: AlertEvent, rules: AlertRule[]) {
  const r = rules.find((x) => x.id === e.ruleId);
  if (r) return ruleTitle({ ...r, service: e.service ?? r.service });
  return e.metric === "service" && e.service && e.service !== "any" ? `${SERVICE_NAME[e.service]} down` : ORPHAN_TITLE[e.metric];
}

const lasted = (e: AlertEvent, now: number) => ((e.resolvedAt ? Date.parse(e.resolvedAt) : now) - Date.parse(e.startedAt)) / 1000;

function EventRow({ e, rules, now }: { e: AlertEvent; rules: AlertRule[]; now: number }) {
  const firing = e.status === "firing";
  const where = e.app ? appName(e.app) : "Server";
  const t = title(e, rules);
  return (
    <Link href={e.href} className="soft-row al-ev" data-status={e.status}>
      <IconTile size="sm">
        <Icon name={METRIC_ICON[e.metric]} />
      </IconTile>
      <span className="al-ev-id two">
        <span className="two-main">
          <span>{t}</span>
          {e.muted ? (
            <Chip size="xs" icon={<Icon name="pause" size={12} />}>
              Muted
            </Chip>
          ) : null}
        </span>
        <span className="two-sub">
          {where}, {e.detail}
        </span>
      </span>
      <span className="al-ev-when two">
        <span className="two-main num">
          <When iso={e.startedAt} now={now} prefix="Started" />
        </span>
        <span className="two-sub num">{e.resolvedAt ? <When iso={e.resolvedAt} now={now} prefix="Resolved" /> : "Still firing"}</span>
      </span>
      <span className={`al-ev-dur num${firing ? " tone-bad" : ""}`} data-tip="How long it fired">
        <span className="sr">Fired for </span>
        {duration(lasted(e, now))}
      </span>
      <span className="al-ev-state">
        <StatusChip tone={firing ? "bad" : "ok"}>{firing ? "Firing" : "Resolved"}</StatusChip>
      </span>
      <Icon name="chevronRight" size={14} className="al-ev-go" />
    </Link>
  );
}

function rowKeys(ev: React.KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(ev.key)) return;
  const rows = [...ev.currentTarget.querySelectorAll<HTMLAnchorElement>("a.al-ev")];
  const at = rows.indexOf(document.activeElement as HTMLAnchorElement);
  if (at < 0) return;
  ev.preventDefault();
  const next = ev.key === "Home" ? 0 : ev.key === "End" ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, at + (ev.key === "ArrowDown" ? 1 : -1)));
  rows[next]?.focus();
}

export function HistoryCard({ events, rules, now }: { events: AlertEvent[]; rules: AlertRule[]; now: number }) {
  const [filter, setFilter] = useState<Filter>("all");
  const heading = useDayHeading();
  const firing = events.filter((e) => e.status === "firing").length;
  const shown = filter === "all" ? events : events.filter((e) => e.status === filter);

  const groups: Array<{ label: string; rows: AlertEvent[] }> = [];
  for (const e of shown) {
    const label = heading(e.startedAt, now);
    const last = groups.at(-1);
    if (last?.label === label) last.rows.push(e);
    else groups.push({ label, rows: [e] });
  }

  return (
    <section className="card al-hist" aria-labelledby="al-hist-title">
      <div className="card-hd">
        <CardTitle id="al-hist-title" icon="history" title="History" sub="Last 90 days, newest first" />
        {events.length ? (
          <Segmented
            label="Filter events"
            value={filter}
            onChange={setFilter}
            options={filterOptions<Filter>([
              { value: "all", label: "All", count: events.length },
              { value: "firing", label: "Firing", tone: "bad", count: firing },
              { value: "resolved", label: "Resolved", tone: "ok", count: events.length - firing },
            ])}
          />
        ) : null}
      </div>
      {events.length === 0 ? (
        <Empty icon="checkCircle" title="No events yet" body="When a rule fires, and when it resolves, the event shows here with the app and a link to it." />
      ) : shown.length === 0 ? (
        <Empty
          icon="checkCircle"
          title="No events match"
          body={filter === "firing" ? "Nothing is firing. Every rule is quiet right now." : "Nothing has resolved in the last 90 days."}
          action={
            <button type="button" className="btn btn-sm" onClick={() => setFilter("all")}>
              Clear filters
            </button>
          }
        />
      ) : (
        <>
          <div className="al-wrap" onKeyDown={rowKeys}>
            {groups.map((g) => (
              <section key={g.label} className="al-group" aria-label={g.label}>
                <GroupHead label={g.label} count={g.rows.length} noun="event" />
                <ul className="soft-list">
                  {g.rows.map((e) => (
                    <li key={e.id}>
                      <EventRow e={e} rules={rules} now={now} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          {/* The shared list footer: the count on a ruled line. */}
          <div className="card-foot">
            <span className="num" role="status">
              Showing {shown.length.toLocaleString("en-US")} of {plural(events.length, "event")}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
