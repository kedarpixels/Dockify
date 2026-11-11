import { CardTitle } from "@/components/card-title";
import { Empty } from "@/components/ui/empty";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { When } from "@/components/ui/when";
import { headlineOf, pctText, uptimePct, type PublicStatus, type StatusComponent, type StatusState } from "@/lib/pages/status-page-shared";
import { StatusFoot, StatusTop } from "./frame";
import { Incidents } from "./incidents";
import { StatusRefresh } from "./refresh";
import { UptimeBar } from "./uptime-bar";

const STATE_LABEL: Record<StatusState, string> = {
  operational: "Operational",
  degraded: "Degraded",
  outage: "Outage",
};

const TONE = { operational: "ok", degraded: "warn", outage: "bad" } as const;

/** "API and Website", "API, Database and Website". */
const names = (list: string[]) => (list.length < 2 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);

function leadLine(data: PublicStatus) {
  const total = data.components.length;
  if (!total) return "No components are published yet.";
  const down = data.components.filter((c) => c.state === "outage").map((c) => c.name);
  const slow = data.components.filter((c) => c.state === "degraded").map((c) => c.name);
  if (!down.length && !slow.length) return `${total === 1 ? "The component is" : `All ${total} components are`} running normally.`;
  const parts = [];
  if (down.length) parts.push(`${names(down)} ${down.length === 1 ? "is" : "are"} down`);
  if (slow.length) parts.push(`${names(slow)} ${slow.length === 1 ? "is" : "are"} degraded`);
  return `${parts.join(", ")}.`;
}

function ComponentRow({ c, now }: { c: StatusComponent; now: number }) {
  const pct = pctText(uptimePct(c.days, now));
  const summary = `${STATE_LABEL[c.state]}, ${pct === "No data" ? "no uptime data yet" : `${pct} uptime over 90 days`}`;
  return (
    <li className="stp-comp">
      <div className="stp-comp-hd">
        <span className="stp-comp-name">{c.name}</span>
        <span className={`stp-comp-state tone-${TONE[c.state]}`}>
          <span className="dot" data-tone={TONE[c.state]} aria-hidden="true" />
          {STATE_LABEL[c.state]}
        </span>
      </div>
      <UptimeBar name={c.name} days={c.days} summary={summary} />
      <div className="stp-comp-ft num" aria-hidden="true">
        <span>
          <span className="stp-span-90">90 days ago</span>
          <span className="stp-span-45">45 days ago</span>
          <span className="stp-span-30">30 days ago</span>
        </span>
        <i />
        <span>{pct === "No data" ? pct : `${pct} uptime`}</span>
        <i />
        <span>Today</span>
      </div>
    </li>
  );
}

export function StatusView({ data }: { data: PublicStatus }) {
  const now = Date.parse(data.updatedAt);
  const tone = TONE[data.state];
  return (
    <>
      <StatusRefresh />
      <StatusTop
        name={data.name}
        logoUrl={data.logoUrl}
        actions={
          <a className="btn btn-sm" href={`/api/status/${data.slug}/rss`} type="application/rss+xml">
            Subscribe via RSS
          </a>
        }
      />
      <Rule />
      <SectionHead
        level={1}
        className="stp-head"
        title={
          <span className="stp-state" data-tone={tone}>
            <span className="dot" data-tone={tone} aria-hidden="true" />
            {headlineOf(data)}
          </span>
        }
        lead={
          <>
            {leadLine(data)} <When iso={data.updatedAt} start={data.updatedAt} prefix="Updated" />
          </>
        }
      />
      <Spacer />

      <section className="card" aria-labelledby="stp-comps">
        <div className="card-hd">
          <CardTitle id="stp-comps" icon="activity" title="Components" sub="Uptime over the last 90 days, UTC days" />
        </div>
        {data.components.length ? (
          <ul className="stp-comps">
            {data.components.map((c) => (
              <ComponentRow key={c.name} c={c} now={now} />
            ))}
          </ul>
        ) : (
          <Empty icon="activity" title="Nothing to show yet" body="This project has no app with a public domain yet." />
        )}
        <div className="stp-legend" aria-hidden="true">
          <span><i className="stp-cell" data-s="ok" />No incidents</span>
          <span><i className="stp-cell" data-s="minor" />Degraded</span>
          <span><i className="stp-cell" data-s="major" />Outage</span>
          <span><i className="stp-cell" data-s="none" />No data</span>
        </div>
      </section>
      <Spacer />

      <section className="card" aria-labelledby="stp-incs">
        <div className="card-hd">
          <CardTitle id="stp-incs" icon="alert" title="Incidents" sub="Last 90 days, newest first" />
        </div>
        <Incidents incidents={data.incidents} />
      </section>
      <Spacer />
      <div className="stp-fill" aria-hidden="true" />
      <Rule />
      <StatusFoot utc />
    </>
  );
}
