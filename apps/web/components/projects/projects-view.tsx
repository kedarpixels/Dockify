"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { Topbar } from "@/components/shell/topbar";
import { Empty } from "@/components/ui/empty";
import { SearchField } from "@/components/ui/field";
import { KpiStrip, type KpiData } from "@/components/ui/kpi";
import { NoSource } from "@/components/ui/no-source";
import { ResultCount } from "@/components/ui/result-count";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { filterOptions, Segmented } from "@/components/ui/segmented";
import { APP_TONE, deriveNotices, deriveProjects, type ProjectCard, type Tone } from "@/lib/derive";
import { plural } from "@/lib/format";
import { useNow, useOverview } from "@/lib/hooks";
import type { OverviewResult } from "@/lib/types";
import { useCan } from "@/lib/viewer";
import { ProjectGrid, ProjectRows } from "./project-list";

type Filter = "all" | "ok" | "live" | "attention";

const FILTERS: Array<{ id: Filter; label: string; tone?: Tone; match: (t: Tone) => boolean }> = [
  { id: "all", label: "All", match: () => true },
  { id: "ok", label: "Healthy", tone: "ok", match: (t) => t === "ok" },
  { id: "live", label: "Deploying", tone: "live", match: (t) => t === "live" },
  // Amber, the tone of most of what it holds (stopped, partial, not reporting); a degraded app still shows red on its own chip.
  { id: "attention", label: "Needs attention", tone: "warn", match: (t) => t === "bad" || t === "warn" },
];

function summary(projects: ProjectCard[]): KpiData[] {
  const apps = projects.flatMap((p) => p.apps);
  const deploying = apps.filter((a) => a.status === "deploying").length;
  // The filter rule, per app: the bad and warn tones, so a stopped app and one not reporting both count.
  const needs = apps.filter((a) => APP_TONE[a.status] === "bad" || APP_TONE[a.status] === "warn");
  const attention = needs.length;
  return [
    { icon: "folder", label: "Projects", value: projects.length, lead: `${plural(new Set(apps.map((a) => a.kind)).size, "kind")} of app` },
    { icon: "layers", label: "Apps", value: apps.length, lead: "Across every project" },
    { icon: "deploy", label: "Deploying", value: deploying, lead: "Apps deploying now", tone: deploying ? "live" : undefined },
    {
      icon: "alert",
      label: "Apps needing attention",
      value: attention,
      lead: "Stopped, degraded or not reporting",
      tone: needs.some((a) => APP_TONE[a.status] === "bad") ? "bad" : attention ? "warn" : undefined,
    },
  ];
}

export function ProjectsView({ initial }: { initial: OverviewResult }) {
  const { result } = useOverview(initial);
  const now = useNow(30_000, initial.fetchedAt);
  const can = useCan();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<"grid" | "list">("grid");
  const o = result.data;

  const projects = useMemo(() => (o ? deriveProjects(o) : []), [o]);
  const kpis = useMemo(() => summary(projects), [projects]);
  const notices = useMemo(() => (o ? deriveNotices(o, now) : null), [o, now]);
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.id, projects.filter((p) => f.match(p.tone)).length])) as Record<Filter, number>,
    [projects],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = FILTERS.find((f) => f.id === filter)!.match;
    return projects.filter(
      (p) => match(p.tone) && (!q || p.slug.toLowerCase().includes(q) || p.apps.some((a) => a.name.toLowerCase().includes(q) || !!a.displayName?.toLowerCase().includes(q))),
    );
  }, [projects, query, filter]);

  const q = query.trim();
  const clear = () => {
    setQuery("");
    setFilter("all");
  };

  // Creating is an admin's: a Viewer sees no create key at all, and the empty state says who can.
  const create = can.manage ? (
    <Link href="/projects/new" className="btn btn-primary">
      <Icon name="plus" />
      New project
    </Link>
  ) : null;

  return (
    <>
      <Topbar trail={["Projects"]} notices={notices} now={now} />
      <main className="page" id="main" tabIndex={-1}>
        {/* The KPI strip carries the counts, so the lead says what the page holds. */}
        <SectionHead level={1} title="Projects" lead="Every product on this server, with the apps and databases it runs." actions={create} />
        <Rule />

        {!o ? (
          <NoSource error={result.error} polling icon="folder" />
        ) : projects.length === 0 ? (
          <div className="card">
            <Empty
              icon="folder"
              title="No projects yet"
              body={
                can.manage
                  ? "A project groups the apps and databases one product runs. Create one, then add its apps."
                  : "A project groups the apps and databases one product runs. An admin can create one."
              }
              action={create}
            />
          </div>
        ) : (
          <>
            <KpiStrip label="Summary" cells={kpis} />
            <Spacer />

            <div className="toolbar pj-bar">
              <SearchField value={query} onChange={setQuery} label="Search projects" placeholder="Search projects and apps" />
              <Segmented
                label="Filter by status"
                value={filter}
                onChange={setFilter}
                options={filterOptions(FILTERS.map((f) => ({ value: f.id, label: f.label, tone: f.tone, count: counts[f.id] })))}
              />
              <span className="pj-views">
                <Segmented
                  label="Layout"
                  iconOnly
                  value={view}
                  onChange={setView}
                  options={[
                    { value: "grid", label: <Icon name="grid" />, ariaLabel: "Grid view" },
                    { value: "list", label: <Icon name="list" />, ariaLabel: "List view" },
                  ]}
                />
              </span>
              <ResultCount count={visible.length} one="project" query={q} />
            </div>
            <Rule />

            {visible.length === 0 ? (
              <Empty
                icon="search"
                title="No projects match"
                body={q ? `Nothing matches “${q}”. Try a project or app name.` : "No project has this status right now."}
                action={
                  <button type="button" className="btn btn-sm" onClick={clear}>
                    {filter !== "all" ? "Clear filters" : "Clear search"}
                  </button>
                }
              />
            ) : view === "grid" ? (
              <ProjectGrid projects={visible} now={now} />
            ) : (
              <ProjectRows projects={visible} now={now} />
            )}
          </>
        )}
        <Spacer end />
      </main>
    </>
  );
}
