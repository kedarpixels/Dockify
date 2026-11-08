"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DeployRow } from "@/components/overview/deploy-row";
import { Topbar } from "@/components/shell/topbar";
import { Empty } from "@/components/ui/empty";
import { SearchField } from "@/components/ui/field";
import { GroupHead } from "@/components/ui/group-head";
import { NoSource } from "@/components/ui/no-source";
import { PendingButton } from "@/components/ui/pending";
import { PreviewProvider } from "@/components/ui/preview";
import { ResultCount } from "@/components/ui/result-count";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { filterOptions, Segmented } from "@/components/ui/segmented";
import { Select, type SelectOption } from "@/components/ui/select";
import { SkelRows } from "@/components/ui/skeleton";
import { Updating } from "@/components/ui/updating";
import { callJson } from "@/lib/client-api";
import { deriveNotices, deriveProjects, IN_FLIGHT } from "@/lib/derive";
import { clause, plural } from "@/lib/format";
import { useNow, useOverview } from "@/lib/hooks";
import type { DeployFilter, DeploymentPage, DeploymentQuery, DeploymentsResult, DeploymentStats } from "@/lib/pages/deployments";
import { useDayHeading } from "@/lib/time-prefs";
import type { OverviewResult, RecentDeployment } from "@/lib/types";
import { DeployKpis } from "./deploy-kpis";
import { DEPLOY_ROW_BARS, DEPLOY_ROW_TEMPLATE } from "./skeleton";

/* A status filter leads with its tone dot. The list pages from the server, so the options carry no counts. */
const FILTERS = filterOptions<DeployFilter>([
  { value: "all", label: "All" },
  { value: "building", label: "Building", tone: "live" },
  { value: "ready", label: "Ready", tone: "ok" },
  { value: "failed", label: "Failed", tone: "bad" },
  { value: "cancelled", label: "Cancelled", tone: "idle" },
]);

const DAY = 86_400_000;
/** A poll that takes this long shows "Updating" in the page head; a quick one never flashes it. */
const SLOW_MS = 600;

type Phase = "ready" | "loading" | "more" | "error";

interface ListState {
  items: RecentDeployment[];
  next: string | null;
  phase: Phase;
  error?: string;
  /** Set when "Load more" failed; the rows already shown stay. */
  moreError?: string;
}

function feedUrl(q: DeploymentQuery) {
  const p = new URLSearchParams();
  if (q.cursor) p.set("cursor", q.cursor);
  if (q.status && q.status !== "all") p.set("status", q.status);
  if (q.project) p.set("project", q.project);
  if (q.q?.trim()) p.set("q", q.q.trim());
  return `/api/deployments/feed?${p}`;
}

/** One page of the feed; a failure carries the route's reason, and an aborted request says so. */
async function fetchPage(q: DeploymentQuery, signal?: AbortSignal): Promise<{ page: DeploymentPage } | { error: string; aborted?: boolean }> {
  const r = await callJson<DeploymentsResult>(feedUrl(q), { signal });
  if (!r.ok) return { error: r.error, aborted: r.aborted };
  if (!r.data?.data) return { error: r.data?.error ?? "The API did not answer" };
  return { page: r.data.data };
}

/** The filters as one comparable string. */
const filterKey = (q: DeploymentQuery) => `${q.status ?? "all"}|${q.project ?? ""}|${q.q ?? ""}`;

/** The key with no filters. The KPI strip counts every build, so only this query may update it. */
const UNFILTERED = filterKey({ status: "all" });

/** Rows grouped by day, newest first: Today, Yesterday, then the date. */
function byDay(items: RecentDeployment[], now: number, heading: (iso: string, now: number) => string) {
  const groups: Array<{ label: string; rows: RecentDeployment[] }> = [];
  for (const d of items) {
    const label = heading(d.createdAt, now);
    const last = groups.at(-1);
    if (last?.label === label) last.rows.push(d);
    else groups.push({ label, rows: [d] });
  }
  return groups;
}

/** When the API sends no stats, the strip counts what the loaded rows can show. */
function statsFrom(items: RecentDeployment[], now: number): DeploymentStats {
  const last = items.filter((d) => now - Date.parse(d.createdAt) <= DAY);
  const ok = last.filter((d) => d.status === "ready" && d.finishedAt);
  const secs = ok.map((d) => (Date.parse(d.finishedAt!) - Date.parse(d.createdAt)) / 1000).sort((a, b) => a - b);
  const mid = Math.floor(secs.length / 2);
  return {
    inFlight: items.filter((d) => IN_FLIGHT.includes(d.status)).length,
    queued: items.filter((d) => d.status === "queued").length,
    succeeded24h: ok.length,
    failed24h: last.filter((d) => d.status === "failed").length,
    medianSeconds: secs.length ? (secs.length % 2 ? secs[mid]! : (secs[mid - 1]! + secs[mid]!) / 2) : null,
  };
}

/** Merges a fresh first page over what is shown: changed rows update, new rows go on top. */
function merge(shown: RecentDeployment[], fresh: RecentDeployment[]) {
  const byId = new Map(fresh.map((d) => [d.id, d]));
  const known = new Set(shown.map((d) => d.id));
  return [...fresh.filter((d) => !known.has(d.id)), ...shown.map((d) => byId.get(d.id) ?? d)];
}

export function DeploymentsView({ initial, overview, query }: { initial: DeploymentsResult; overview: OverviewResult; query: DeploymentQuery }) {
  const { result: ov } = useOverview(overview);
  const now = useNow(1000, initial.fetchedAt);
  const notices = useMemo(() => (ov.data ? deriveNotices(ov.data, now) : null), [ov.data, now]);

  const heading = useDayHeading();
  const [status, setStatus] = useState<DeployFilter>(query.status ?? "all");
  const [project, setProject] = useState(query.project ?? "");
  const [text, setText] = useState(query.q ?? "");
  const [q, setQ] = useState(query.q ?? "");
  const [list, setList] = useState<ListState>({
    items: initial.data?.items ?? [],
    next: initial.data?.nextCursor ?? null,
    phase: initial.data ? "ready" : "error",
    error: initial.error,
  });
  const [stats, setStats] = useState(initial.data?.stats);
  const [refreshing, setRefreshing] = useState(false);
  const filters = useMemo<DeploymentQuery>(() => ({ status, project: project || undefined, q: q || undefined }), [status, project, q]);

  // Every answer is checked against the filters it was asked for: a first page, a poll or a
  // "Load more" that lands after the filters changed is dropped instead of mixing in old rows.
  const shownKey = useRef(filterKey(filters));
  const firstPage = useRef<AbortController | null>(null);

  /** Loads the first page for `f`, replacing the rows; any older first-page request is aborted. */
  const reload = useCallback((f: DeploymentQuery) => {
    const key = filterKey(f);
    shownKey.current = key;
    firstPage.current?.abort();
    const ctrl = new AbortController();
    firstPage.current = ctrl;
    setList((l) => ({ ...l, phase: "loading", moreError: undefined }));
    void fetchPage(f, ctrl.signal).then((r) => {
      if (shownKey.current !== key) return;
      if ("page" in r) {
        setList({ items: r.page.items, next: r.page.nextCursor, phase: "ready" });
        if (r.page.stats && key === UNFILTERED) setStats(r.page.stats);
      } else if (!r.aborted) setList((l) => ({ ...l, phase: "error", error: r.error }));
    });
  }, []);

  useEffect(() => () => firstPage.current?.abort(), []);

  // The search settles for 250ms before it asks the server.
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(id);
  }, [text]);

  // A filter change reloads the first page and mirrors the filters into the address bar. The
  // server already rendered the first set, so an unchanged key does nothing.
  useEffect(() => {
    if (filterKey(filters) === shownKey.current) return;
    const url = new URL(window.location.href);
    for (const [k, v] of Object.entries({ status: filters.status === "all" ? "" : filters.status, project: filters.project, q: filters.q })) {
      if (v) url.searchParams.set(k, v);
      else url.searchParams.delete(k);
    }
    window.history.replaceState(window.history.state, "", url);
    reload(filters);
  }, [filters, reload]);

  // 15s after each answer the first page is pulled again so running builds finish and new ones
  // appear. A pull slower than SLOW_MS shows "Updating" in the head until it lands.
  useEffect(() => {
    if (initial.source === "none") return;
    const key = filterKey(filters);
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!document.hidden) {
        const slow = setTimeout(() => setRefreshing(true), SLOW_MS);
        // A failed pull keeps the rows on screen; the next tick tries again.
        const r = await fetchPage(filters, ctrl.signal);
        clearTimeout(slow);
        setRefreshing(false);
        if ("page" in r && shownKey.current === key) {
          const page = r.page;
          setList((l) => (l.phase === "ready" ? { ...l, items: merge(l.items, page.items), next: l.items.length > page.items.length ? l.next : page.nextCursor } : l));
          if (page.stats && key === UNFILTERED) setStats(page.stats);
        }
      }
      if (!ctrl.signal.aborted) timer = setTimeout(() => void poll(), 15_000);
    };
    timer = setTimeout(() => void poll(), 15_000);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [filters, initial.source]);

  const more = async () => {
    if (!list.next || list.phase === "more") return;
    const key = filterKey(filters);
    setList((l) => ({ ...l, phase: "more", moreError: undefined }));
    const r = await fetchPage({ ...filters, cursor: list.next });
    if (shownKey.current !== key) return;
    if ("page" in r) {
      const page = r.page;
      setList((l) => {
        const known = new Set(l.items.map((d) => d.id));
        return { items: [...l.items, ...page.items.filter((d) => !known.has(d.id))], next: page.nextCursor, phase: "ready" };
      });
    } else setList((l) => ({ ...l, phase: "ready", moreError: r.error }));
  };

  /** "Clear search" empties the text only; "Clear filters" resets everything. */
  const clearSearch = () => {
    setText("");
    setQ("");
  };
  const clearFilters = () => {
    clearSearch();
    setStatus("all");
    setProject("");
  };

  // Project filter options: every known project with its health dot and app count, "All" first.
  const projectOptions = useMemo<SelectOption<string>[]>(() => {
    const cards = ov.data ? deriveProjects(ov.data) : [];
    const slugs = new Set(cards.map((c) => c.slug));
    for (const d of list.items) slugs.add(d.projectSlug);
    if (project) slugs.add(project);
    const rows = [...slugs].sort().map((slug): SelectOption<string> => {
      const card = cards.find((c) => c.slug === slug);
      return card ? { value: slug, label: slug, tone: card.tone, hint: plural(card.apps.length, "app") } : { value: slug, label: slug, icon: "folder" };
    });
    return [{ value: "", label: "All projects", icon: "folder" }, ...rows];
  }, [ov.data, list.items, project]);

  const shownStats = stats ?? statsFrom(list.items, now);
  const groups = byDay(list.items, now, heading);
  // A status or a project narrows the list beyond the search text.
  const narrowed = status !== "all" || !!project;
  const filtered = narrowed || !!q;
  const noSource = initial.source === "none";
  const down = !initial.data && !noSource;

  const lead = noSource
    ? "Connect this dashboard to a Dockify API to see your deployments."
    : "Every build across every project, newest first.";

  return (
    <PreviewProvider preview={initial.source === "preview"}>
      <Topbar trail={["Deployments"]} notices={notices} now={now} />
      <main className="page" id="main" tabIndex={-1}>
        <SectionHead level={1} title="Deployments" lead={lead} actions={refreshing ? <Updating /> : undefined} />

        {noSource || down ? (
          <>
            <Rule />
            <NoSource icon="deploy" error={down ? (initial.error ?? "The API did not answer") : undefined} />
          </>
        ) : (
          <>
            <Rule />
            <DeployKpis stats={shownStats} />
            <Spacer />

            <div className="toolbar dpl-tools">
              <SearchField value={text} onChange={setText} label="Search deployments" placeholder="Search apps, messages and commits" />
              <Segmented label="Filter by status" value={status} onChange={setStatus} options={FILTERS} />
              <Select
                className="dpl-select"
                label="Filter by project"
                value={project}
                onChange={setProject}
                options={projectOptions}
                icon={project ? undefined : "folder"}
                align="end"
              />
            </div>
            <Rule />

            <section className="dpl-feed" aria-label="Deployments" aria-busy={list.phase === "loading"}>
              {list.phase === "loading" ? (
                <div className="dep-list">
                  <SkelRows rows={Math.min(Math.max(list.items.length, 6), 25)} label="Loading deployments" template={DEPLOY_ROW_TEMPLATE} cols={DEPLOY_ROW_BARS} />
                </div>
              ) : list.phase === "error" ? (
                <Empty
                  icon="deploy"
                  title="Deployments are unavailable"
                  body={`${clause(list.error ?? "The API did not answer")}. Try again in a moment.`}
                  action={
                    <button type="button" className="btn btn-sm" onClick={() => reload(filters)}>
                      Try again
                    </button>
                  }
                />
              ) : list.items.length === 0 ? (
                filtered ? (
                  <>
                    <Empty
                      icon="search"
                      title="No deployments match"
                      body={q ? `Nothing matches “${q}”${narrowed ? " with these filters" : ""}. Try another search${narrowed ? " or clear the filters" : ""}.` : "Nothing matches these filters. Try another status or project."}
                      action={
                        <button type="button" className="btn btn-sm" onClick={narrowed ? clearFilters : clearSearch}>
                          {narrowed ? "Clear filters" : "Clear search"}
                        </button>
                      }
                    />
                    <ResultCount count={0} one="deployment" query={q} />
                  </>
                ) : (
                  <Empty icon="deploy" title="No deployments yet" body="Push to an app’s branch or press Deploy on an app. Every build shows up here." />
                )
              ) : (
                <div className="dep-list">
                  {groups.map((g) => (
                    <section key={g.label} aria-label={g.label}>
                      {/* The page's second level: the day groups sit right under its title. */}
                      <GroupHead as="h2" label={g.label} count={g.rows.length} noun="deployment" />
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

              {list.items.length > 0 && (list.phase === "ready" || list.phase === "more") ? (
                <div className="card-foot dpl-foot">
                  <span className="num" role="status">
                    {list.moreError
                      ? `Could not load more. ${clause(list.moreError)}.`
                      : list.next || list.items.length === 1
                        ? `Showing ${plural(list.items.length, "deployment")}`
                        : `Showing all ${plural(list.items.length, "deployment")}`}
                  </span>
                  {list.next ? (
                    <PendingButton className="btn btn-sm" pending={list.phase === "more"} onClick={() => void more()}>
                      {list.moreError ? "Try again" : "Load more"}
                    </PendingButton>
                  ) : null}
                </div>
              ) : null}
            </section>
          </>
        )}
        <Spacer end />
      </main>
    </PreviewProvider>
  );
}
