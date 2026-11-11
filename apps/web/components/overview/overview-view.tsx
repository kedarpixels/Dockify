"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Icon } from "@/components/icon";
import { Topbar } from "@/components/shell/topbar";
import { KpiStrip } from "@/components/ui/kpi";
import { NoSource } from "@/components/ui/no-source";
import { PreviewProvider } from "@/components/ui/preview";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Updating } from "@/components/ui/updating";
import { deriveKpis, deriveNotices, deriveProjects, IN_FLIGHT } from "@/lib/derive";
import { plural } from "@/lib/format";
import { useNow, useOverview } from "@/lib/hooks";
import type { OverviewResult, RecentDeployment } from "@/lib/types";
import { useCan } from "@/lib/viewer";
import { DeployHeatmap } from "./deploy-heatmap";
import { DeploymentList, InFlight } from "./panels";
import { ProjectCarousel } from "./project-carousel";
import { ServerCard } from "./server-card";
import { dayIn } from "./today";

/** Newest first, the order every list of deployments uses (the Deployments page included). */
const newestFirst = (list: RecentDeployment[]) => [...list].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));

/* The overview reads like the portfolio home: a pixel head, then ruled blocks between dither bands. */
export function OverviewView({ initial }: { initial: OverviewResult }) {
  const { result, refreshing } = useOverview(initial);
  const now = useNow(1000, initial.fetchedAt);
  const can = useCan();
  const o = result.data;

  // The zone the API counted the trend's days in; an older API sends none and counts UTC days.
  const zone = o?.trendZone;
  const todayIso = dayIn(now, zone);
  const view = useMemo(() => {
    if (!o) return null;
    const deployments = newestFirst(o.recentDeployments);
    return {
      kpis: deriveKpis(o, todayIso),
      projects: deriveProjects(o),
      flight: deployments.filter((d) => IN_FLIGHT.includes(d.status)),
      recent: deployments.slice(0, 16),
      rollbacks: deployments.filter((d) => d.trigger === "rollback").length,
    };
  }, [o, todayIso]);

  const notices = useMemo(() => (o ? deriveNotices(o, now) : null), [o, now]);

  const lead = o
    ? `${plural(o.counts.projects.active, "project")}, ${plural(o.counts.apps.total, "app")}, ${plural(o.counts.domains, "domain")} on one server.`
    : "Connect this dashboard to a Dockify API to see your projects.";

  return (
    <PreviewProvider preview={result.source === "preview"}>
      <Topbar trail={["Overview"]} notices={notices} now={now} />
      <main className="page" id="main" tabIndex={-1}>
        <SectionHead
          level={1}
          id="overview-title"
          title="Overview"
          lead={lead}
          className="ov-head"
          actions={
            <>
              {refreshing ? <Updating /> : null}
              {/* Creating is an admin's: a Viewer sees no create key at all. */}
              {can.manage ? (
                <Link href="/projects/new" className="btn btn-primary">
                  <Icon name="plus" />
                  New project
                </Link>
              ) : null}
            </>
          }
        />

        {!view || !o ? (
          <>
            <Rule />
            <NoSource error={result.error} polling />
            <Spacer end />
          </>
        ) : (
          <>
            <Rule />
            <KpiStrip cells={view.kpis} />
            <Spacer />
            <ProjectCarousel projects={view.projects} now={now} empty={can.manage ? undefined : "An admin can create one. Projects show up here with their health and last deploy."} />
            <Spacer />
            <DeployHeatmap trend={o.deployTrend} rollbacks={view.rollbacks} todayIso={todayIso} />
            <Spacer />
            <div className="split ov-split" data-stretch="true">
              <DeploymentList deployments={view.recent} now={now} />
              <div className="col">
                <ServerCard host={o.host} now={now} fetchedAt={result.fetchedAt} />
                {/* Only while something builds or waits; otherwise Server fills the column. */}
                <InFlight deployments={view.flight} now={now} />
              </div>
            </div>
            <Spacer end />
          </>
        )}
      </main>
    </PreviewProvider>
  );
}
