import { Chip } from "@/components/ui/chip";
import { Empty } from "@/components/ui/empty";
import { absTime, duration } from "@/lib/format";
import { INCIDENT_LABEL, type Incident } from "@/lib/pages/status-page-shared";

/** Public dates are UTC: one zone for every visitor, and the server HTML matches the browser. */
const at = (iso: string) => absTime(iso, { utc: true });

function meta(i: Incident) {
  const parts = [`Started ${at(i.startedAt)}`];
  if (i.resolvedAt) parts.push(`lasted ${duration((Date.parse(i.resolvedAt) - Date.parse(i.startedAt)) / 1000)}`);
  if (i.affects.length) parts.push(`affected ${i.affects.join(", ")}`);
  return parts.join(", ");
}

function IncidentItem({ incident: i }: { incident: Incident }) {
  const ongoing = i.status !== "resolved";
  return (
    <article id={`incident-${i.key}`} className="stp-inc" aria-labelledby={`incident-${i.key}-t`}>
      <div className="stp-inc-hd">
        <h3 id={`incident-${i.key}-t`} className="stp-inc-title">
          {i.title}
        </h3>
        <span className="stp-inc-tags">
          <Chip size="xs" tone={i.impact === "major" ? "bad" : "warn"}>
            {i.impact === "major" ? "Major" : "Minor"}
          </Chip>
          <Chip size="xs" tone={ongoing ? "live" : "ok"}>
            {INCIDENT_LABEL[i.status]}
          </Chip>
        </span>
      </div>
      <p className="stp-inc-meta num">{meta(i)}</p>
      {i.updates.length ? (
        <ol className="stp-upd">
          {i.updates.map((u) => (
            <li key={`${u.at}-${u.status}`} className="stp-upd-item">
              <span className="stp-upd-status">{INCIDENT_LABEL[u.status]}</span>
              <div className="stp-upd-body">
                <p>{u.body}</p>
                <time className="stp-upd-at num" dateTime={u.at}>
                  {at(u.at)}
                </time>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </article>
  );
}

/** The incident history of the last 90 days, newest first, or a calm empty state. */
export function Incidents({ incidents }: { incidents: Incident[] }) {
  if (!incidents.length) {
    return <Empty icon="checkCircle" title="No incidents" body="Nothing has been reported in the last 90 days." />;
  }
  return (
    <div>
      {incidents.map((i) => (
        <IncidentItem key={i.key} incident={i} />
      ))}
    </div>
  );
}
