"use client";

import Link from "next/link";
import { CardTitle } from "@/components/card-title";
import { AppIcon } from "@/components/icons/app-icon";
import { Empty } from "@/components/ui/empty";
import { GitLink } from "@/components/ui/git-ref";
import { GroupHead } from "@/components/ui/group-head";
import { Node } from "@/components/ui/rule";
import { deploySource } from "@/lib/deploy-source";
import { appLabel } from "@/lib/derive";
import { clock } from "@/lib/format";
import { branchHref, commitHref, githubRepo } from "@/lib/git-links";
import { useDayHeading } from "@/lib/time-prefs";
import type { RecentDeployment } from "@/lib/types";
import { DeployRow, elapsed } from "./deploy-row";

/** Recent deployments across every project, newest first, grouped by day with each day's count. */
export function DeploymentList({ deployments, now }: { deployments: RecentDeployment[]; now: number }) {
  const heading = useDayHeading();
  const groups: Array<{ label: string; rows: RecentDeployment[] }> = [];
  for (const d of deployments) {
    const label = heading(d.createdAt, now);
    const last = groups.at(-1);
    if (last?.label === label) last.rows.push(d);
    else groups.push({ label, rows: [d] });
  }
  return (
    <section className="card reveal dep-card" aria-labelledby="dep-title" style={{ animationDelay: "200ms" }}>
      <div className="card-hd">
        <CardTitle id="dep-title" icon="deploy" title="Recent deployments" sub="All projects, newest first" />
        <Link href="/deployments" className="btn btn-sm">
          View all deployments
        </Link>
      </div>
      {deployments.length === 0 ? (
        <Empty icon="deploy" title="No deployments yet" body="Push to an environment’s branch or press Deploy on an app. Every build shows up here." />
      ) : (
        <div className="dep-list">
          {groups.map((g) => (
            <section key={g.label} aria-label={g.label}>
              <GroupHead label={g.label} count={g.rows.length} noun="deployment" />
              <ul className="soft-list">
                {g.rows.map((d) => (
                  <li key={d.id}>
                    <DeployRow d={d} now={now} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Builds running or waiting for a slot. With nothing in flight it renders nothing: the KPI strip
 * already says so, and an empty card would only repeat it. Its top line meets the column divider
 * and the rail on nodes, as the lines inside it do.
 */
export function InFlight({ deployments, now }: { deployments: RecentDeployment[]; now: number }) {
  if (deployments.length === 0) return null;
  const building = deployments.filter((d) => d.status !== "queued").length;
  const queued = deployments.length - building;
  const sub = [building ? `${building} building` : "", queued ? `${queued} queued` : ""].filter(Boolean).join(", ");
  return (
    <section className="card reveal fl-card" aria-labelledby="fl-title" style={{ animationDelay: "240ms" }}>
      <Node pos="tl" />
      <Node pos="tr" />
      <div className="card-hd">
        <CardTitle id="fl-title" icon="clock" title="In progress" sub={sub} />
        {building ? <span className="dot pulse" data-tone="live" aria-hidden="true" /> : null}
      </div>
      {deployments.map((d, i) => {
        const isQueued = d.status === "queued";
        const repo = githubRepo(d.repo);
        const source = deploySource(d);
        return (
          <div key={d.id} className="flight" data-queued={isQueued}>
            {i ? (
              <>
                <Node pos="tl" />
                <Node pos="tr" />
              </>
            ) : null}
            <div className="flight-hd">
              <AppIcon id={d.app.id} kind={d.app.kind} size="md" />
              <span className="flight-id two">
                <span className="two-main ellipsis">{appLabel(d)}</span>
                {source ? (
                  <span className="two-sub flight-ref">
                    <span className="ellipsis" title={d.image ?? source}>
                      {source}
                    </span>
                  </span>
                ) : !d.branch && !d.commit ? (
                  <span className="two-sub flight-ref">
                    <span className="none-mark">None</span>
                  </span>
                ) : (
                  <span className="two-sub flight-ref num">
                    <GitLink href={branchHref(repo, d.branch)} className="flight-branch">
                      {d.branch ? <span className="ellipsis" title={d.branch}>{d.branch}</span> : <span className="none-mark">None</span>}
                    </GitLink>
                    ,&nbsp;
                    <GitLink href={commitHref(repo, d.commit)}>{d.commit ? d.commit.slice(0, 7) : <span className="none-mark">None</span>}</GitLink>
                  </span>
                )}
              </span>
              <span className={`flight-time num${isQueued ? " tone-pending" : ""}`}>{isQueued ? "Queued" : clock(elapsed(d, now))}</span>
            </div>
            <div className="track" data-indeterminate={!isQueued} data-queued={isQueued} aria-hidden="true">
              <span />
            </div>
            <div className="flight-ft">
              <span className={isQueued ? "flight-state" : "flight-state tone-live"}>
                {isQueued ? "Waiting for a build slot" : d.status === "building" ? "Building image" : "Health checks and swap"}
              </span>
              <Link href={`/deployments/${d.id}`} className="btn btn-xs">
                Logs
              </Link>
            </div>
          </div>
        );
      })}
    </section>
  );
}
