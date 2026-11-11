"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/icon";
import { AppIcon } from "@/components/icons/app-icon";
import { KIND_LABEL } from "@/components/project-detail/shared";
import { Topbar } from "@/components/shell/topbar";
import { StatusChip } from "@/components/ui/chip";
import { Empty } from "@/components/ui/empty";
import { EnvTag, envName, useRowEnv } from "@/components/ui/env-tag";
import { useShowsEnv } from "@/components/ui/env-scope";
import { SearchField } from "@/components/ui/field";
import { KpiStrip, type KpiData } from "@/components/ui/kpi";
import { Meter } from "@/components/ui/meter";
import { NoSource } from "@/components/ui/no-source";
import { ResultCount } from "@/components/ui/result-count";
import { Corners, Node, Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Segmented, filterOptions } from "@/components/ui/segmented";
import { APP_STATUS_LABEL, APP_TONE, deriveNotices, notRunning } from "@/lib/derive";
import { appTitle, bytes, plural, uptime } from "@/lib/format";
import { useNow, useOverview } from "@/lib/hooks";
import type { PageResult, ResourceRow, StatefulKind } from "@/lib/pages/resources-domains";
import type { AppKind, OverviewResult } from "@/lib/types";
import { useCan } from "@/lib/viewer";
import { liveResources, onServer, RESOURCES_POLL_MS } from "./live";
import { usePageRefresh } from "./refresh";
import { Stamp } from "./shared";

/* -------------- Kinds and filters -------------- */

type KindFilter = "all" | "apps" | "databases" | "caches" | "storage";

const KIND_FILTERS: Array<{ id: KindFilter; label: string; match: (k: AppKind) => boolean }> = [
  { id: "all", label: "All", match: () => true },
  { id: "apps", label: "Apps", match: (k) => k === "frontend" || k === "backend" || k === "bot" },
  { id: "databases", label: "Databases", match: (k) => k === "postgres" },
  { id: "caches", label: "Caches", match: (k) => k === "redis" },
  // Storage is no longer offered (MinIO stopped publishing an image); the filter shows only while an older install still lists one.
  { id: "storage", label: "Storage", match: (k) => k === "s3" },
];

const isStateful = (k: AppKind): k is StatefulKind => k === "postgres" || k === "redis" || k === "s3";

const ENGINE: Record<StatefulKind, string> = { postgres: "Postgres", redis: "Redis", s3: "MinIO" };

/**
 * The image as two short lines. Services: "Postgres 16.4" over the image they run. Built apps: the
 * repository without the registry prefix over the commit the tag names. Null when the API reported
 * no image, and no sub line when the reference names no tag: neither is ever made up.
 */
function imageParts(r: ResourceRow): { main: string; sub: string | null } | null {
  const image = r.image.trim();
  if (r.version && isStateful(r.kind)) return { main: `${ENGINE[r.kind]} ${r.version}`, sub: image || null };
  if (!image) return null;
  const at = image.lastIndexOf(":");
  const tagged = at > image.lastIndexOf("/");
  const repo = tagged ? image.slice(0, at) : image;
  const tag = tagged ? image.slice(at + 1) : null;
  return { main: repo.replace(/^dockify\//, ""), sub: tag === null ? null : /^[0-9a-f]{7,40}$/.test(tag) ? `Commit ${tag.slice(0, 7)}` : `Tag ${tag}` };
}

/** A size split for the KPI strip, the figure big and the unit small: "1.5" and "GB". */
function sizeParts(n: number) {
  const s = bytes(n);
  const at = s.lastIndexOf(" ");
  return { value: s.slice(0, at), unit: s.slice(at + 1) };
}

/* -------------- Summary -------------- */

function Summary({ items, hostMemory }: { items: ResourceRow[]; hostMemory?: number }) {
  const running = items.filter((r) => r.status === "running").length;
  const deploying = items.filter((r) => r.status === "deploying").length;
  // The projects page rule: an app in the bad or warn tone (broken, stopped, or not deployed) needs a look.
  const attention = items.filter((r) => APP_TONE[r.status] === "bad" || APP_TONE[r.status] === "warn");
  // Memory is this server's: an app on Vercel reserves none of it.
  const here = onServer(items);
  const reserved = here.reduce((n, r) => n + r.memory.reservedBytes, 0);
  const used = here.reduce((n, r) => n + r.memory.usedBytes, 0);
  const volumes = items.filter((r) => r.volume);
  const volumeBytes = volumes.reduce((n, r) => n + (r.volume?.sizeBytes ?? 0), 0);
  const memory = sizeParts(reserved);
  const disk = sizeParts(volumeBytes);

  const cells: KpiData[] = [
    { icon: "checkCircle", label: "Running", value: running, lead: deploying ? `${deploying} deploying, ${items.length} in all` : `Of ${plural(items.length, "resource")}` },
    {
      icon: "alert",
      label: "Needs attention",
      value: attention.length,
      lead: "Stopped, degraded or not reporting",
      tone: attention.some((r) => APP_TONE[r.status] === "bad") ? "bad" : attention.length ? "warn" : undefined,
    },
    {
      icon: "server",
      label: "Memory",
      value: memory.value,
      unit: memory.unit,
      lead: hostMemory ? `Reserved of ${bytes(hostMemory)}, ${bytes(used)} in use` : `Reserved, ${bytes(used)} in use`,
    },
    { icon: "database", label: "Volumes", value: disk.value, unit: disk.unit, lead: `${plural(volumes.length, "volume")} on disk` },
  ];
  return <KpiStrip label="Summary" cells={cells} />;
}

/* -------------- Rows and cells -------------- */

/** Memory used as a share of the reservation, 0 when nothing is reserved. */
const memPct = (r: ResourceRow) => (r.memory.reservedBytes ? (r.memory.usedBytes / r.memory.reservedBytes) * 100 : 0);

/**
 * The link that opens the app: its name says project, app, kind and, when the project's apps sit in
 * several environments, the environment, so twin rows differ.
 */
const coverName = (r: ResourceRow, shows: (project: string) => boolean) =>
  `${r.projectSlug} / ${appTitle(r)}, ${KIND_LABEL[r.kind]}${shows(r.projectSlug) ? `, ${envName(r.environment)}` : ""}`;

/** "horseai" for production (the default says nothing in a row) or a project with one environment, "horseai, Dev" otherwise. */
function Where({ r }: { r: ResourceRow }) {
  const named = useRowEnv()(r.projectSlug, r.environment);
  return (
    <span className="two-sub rd-sub">
      <span>
        {r.projectSlug}
        {named ? "," : null}
      </span>
      {named ? <EnvTag env={r.environment} compact /> : null}
    </span>
  );
}

/** What stands in for a meter: an app on Vercel has no container here, a stopped one uses nothing. Null while it runs here. */
const noMeter = (r: ResourceRow) => (r.onVercel ? ON_VERCEL : notRunning(r.status) ? "Idle" : null);
const ON_VERCEL = "On Vercel";

function Stats({ r }: { r: ResourceRow }) {
  const quiet = noMeter(r);
  return (
    <>
      <span className="rs-col-cpu">{quiet ? <span className="none">{quiet}</span> : <Meter label="CPU" pct={r.cpu.usedPct} />}</span>
      <span className="rs-col-mem">
        {quiet ? <span className="none">{quiet}</span> : <Meter label="Memory" pct={memPct(r)} text={bytes(r.memory.usedBytes)} />}
      </span>
    </>
  );
}

/** Container uptime, "4m" at least, with the start in its tip. */
function Uptime({ r, now }: { r: ResourceRow; now: number }) {
  const start = r.startedAt ? Date.parse(r.startedAt) : NaN;
  return r.startedAt && !Number.isNaN(start) ? (
    <Stamp iso={r.startedAt} tip="Since">{uptime(Math.max(60, (now - start) / 1000))}</Stamp>
  ) : (
    <span className="none">{r.onVercel ? ON_VERCEL : notRunning(r.status) ? APP_STATUS_LABEL[r.status] : "Starting"}</span>
  );
}

interface RowProps {
  r: ResourceRow;
  now: number;
  delay: number;
}

function ResourceListRow({ r, now, delay }: RowProps) {
  const shows = useShowsEnv();
  const img = imageParts(r);
  return (
    <li className="reveal" style={{ animationDelay: `${delay}ms` }}>
      <div className="soft-row rs-row" data-hover="true">
        <Link href={`/apps/${r.id}`} className="rd-cover" aria-label={coverName(r, shows)} />
        <span className="rs-col-name">
          <AppIcon id={r.id} kind={r.kind} size="md" />
          <span className="two">
            <span className="two-main rd-wrap">{appTitle(r)}</span>
            <Where r={r} />
          </span>
        </span>
        <span className="rs-col-status">
          <StatusChip tone={APP_TONE[r.status]}>{APP_STATUS_LABEL[r.status]}</StatusChip>
        </span>
        <span className="rs-col-image two">
          {img ? (
            <>
              <span className="num two-main rd-wrap">{img.main}</span>
              {img.sub ? <span className="num two-sub rd-wrap">{img.sub}</span> : null}
            </>
          ) : (
            <span className="none">Not reported</span>
          )}
        </span>
        <Stats r={r} />
        <span className="rs-col-up">
          <Uptime r={r} now={now} />
        </span>
      </div>
    </li>
  );
}

function ResourceCell({ r, now, delay }: RowProps) {
  const shows = useShowsEnv();
  const img = imageParts(r);
  return (
    <article className="rs-cell reveal" style={{ animationDelay: `${delay}ms` }}>
      <Corners />
      <Link href={`/apps/${r.id}`} className="rd-cover" aria-label={coverName(r, shows)} />
      <div className="rs-cell-body">
        <header className="rs-cell-hd">
          <AppIcon id={r.id} kind={r.kind} size="lg" />
          <span className="two">
            <span className="two-main rd-wrap rs-name-lg">{appTitle(r)}</span>
            <Where r={r} />
          </span>
          <StatusChip tone={APP_TONE[r.status]} className="rs-cell-status">
            {APP_STATUS_LABEL[r.status]}
          </StatusChip>
        </header>
        <dl className="rs-cell-facts">
          <div>
            <dt>{isStateful(r.kind) ? "Version" : "Image"}</dt>
            <dd className="num rd-wrap">{img ? img.main : <span className="none">Not reported</span>}</dd>
          </div>
          <div>
            <dt>CPU</dt>
            <dd>{noMeter(r) ? <span className="none">{noMeter(r)}</span> : <Meter label="CPU" pct={r.cpu.usedPct} />}</dd>
          </div>
          <div>
            <dt>Memory</dt>
            <dd>
              {noMeter(r) ? (
                <span className="none">{noMeter(r)}</span>
              ) : (
                <Meter label="Memory" pct={memPct(r)} text={bytes(r.memory.usedBytes)} />
              )}
            </dd>
          </div>
          {r.volume ? (
            <div>
              <dt>Volume</dt>
              {/* The worker measures volumes on its janitor pass; until then there is no size to show. */}
              <dd className="num">{r.volume.sizeBytes > 0 ? bytes(r.volume.sizeBytes) : <span className="none">Not measured yet</span>}</dd>
            </div>
          ) : null}
        </dl>
      </div>
      <footer className="rs-cell-ft">
        <Node pos="tl" />
        <Node pos="tr" />
        <Icon name="clock" size={14} />
        <span className="rs-cell-up">
          <Uptime r={r} now={now} />
        </span>
      </footer>
    </article>
  );
}

/* -------------- Page -------------- */

type Layout = "grid" | "list";
const LAYOUT_KEY = "resources-layout";
const layoutListeners = new Set<() => void>();

function readLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

function subscribeLayout(onChange: () => void) {
  layoutListeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === LAYOUT_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    layoutListeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The grid or list choice, kept in this browser. The server render and hydration read "list". */
function useLayout(): [Layout, (v: Layout) => void] {
  const layout = useSyncExternalStore<Layout>(subscribeLayout, readLayout, () => "list");
  const set = (v: Layout) => {
    try {
      localStorage.setItem(LAYOUT_KEY, v);
    } catch {
      /* storage blocked: the choice lasts until the page reloads */
    }
    layoutListeners.forEach((l) => l());
  };
  return [layout, set];
}

export function ResourcesView({ overview, initial }: { overview: OverviewResult; initial: PageResult<ResourceRow[]> }) {
  const { result } = useOverview(overview);
  const now = useNow(30_000, initial.fetchedAt);
  const o = result.data;
  const can = useCan();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<KindFilter>("all");
  const [view, setView] = useLayout();

  const notices = useMemo(() => (o ? deriveNotices(o, now) : null), [o, now]);

  // Statuses follow the polled overview, so a row flips to Running without a reload. The rest of a
  // row (when it started, CPU, memory) comes from the list, which is read again on its own timer:
  // without that a newly started app reads "Starting" at 0% for as long as the page stays open.
  usePageRefresh(initial.source === "api", RESOURCES_POLL_MS);
  const items = useMemo(() => liveResources(initial.data ?? [], o?.resources), [initial.data, o]);

  const counts = useMemo(
    () => Object.fromEntries(KIND_FILTERS.map((f) => [f.id, items.filter((r) => f.match(r.kind)).length])) as Record<KindFilter, number>,
    [items],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = KIND_FILTERS.find((f) => f.id === filter)!.match;
    return items.filter(
      (r) => match(r.kind) && (!q || [r.name, r.displayName ?? "", r.projectSlug, r.environment, r.image, KIND_LABEL[r.kind]].some((s) => s.toLowerCase().includes(q))),
    );
  }, [items, query, filter]);

  const data = initial.data;
  // The KPI strip under the head carries the counts, so the lead says what the page holds instead.
  const lead = "Every container on the server: apps, databases and caches.";

  const rowProps = (r: ResourceRow, i: number): RowProps => ({ r, now, delay: Math.min(i, 12) * 30 });

  return (
    <>
      <Topbar trail={["Resources"]} notices={notices} now={now} />
      <main className="page" id="main" tabIndex={-1}>
        <SectionHead level={1} title="Resources" lead={lead} />
        <Rule />

        {!data ? (
          <NoSource error={initial.error} />
        ) : items.length === 0 ? (
          <div className="card">
            <Empty
              icon="box"
              title="No resources yet"
              body={
                can.manage
                  ? "Deploy an app, or add Postgres or Redis to a project with New app. Everything on the server shows up here."
                  : "Apps and services show up here once an admin adds them to a project."
              }
              action={
                <Link href="/projects" className="btn btn-sm">
                  Open projects
                </Link>
              }
            />
          </div>
        ) : (
          <>
            <Summary items={items} hostMemory={o?.host?.memory.totalBytes} />
            <Spacer />

            <div className="toolbar rd-tools">
              <SearchField value={query} onChange={setQuery} label="Search resources" placeholder="Search names, projects and images" />
              <Segmented
                label="Filter by kind"
                value={filter}
                onChange={setFilter}
                options={filterOptions(KIND_FILTERS.filter((f) => f.id !== "storage" || counts.storage > 0).map((f) => ({ value: f.id, label: f.label, count: counts[f.id] })))}
              />
              <span className="rd-views">
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
              <ResultCount count={visible.length} one="resource" query={query} />
            </div>
            <Rule />

            {visible.length === 0 ? (
              <div className="card">
                <Empty
                  icon="search"
                  title="No resources match"
                  body={query.trim() ? `Nothing matches “${query.trim()}”. Try a name, project or image.` : "Nothing of this kind runs on the server yet."}
                  action={
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setQuery("");
                        setFilter("all");
                      }}
                    >
                      {query.trim() && filter === "all" ? "Clear search" : "Clear filters"}
                    </button>
                  }
                />
              </div>
            ) : view === "list" ? (
              <section className="rd-list" aria-label="Resources">
                <div className="rs-head" aria-hidden="true">
                  <span className="rs-col-name">Name</span>
                  <span className="rs-col-status">Status</span>
                  <span className="rs-col-image">Image</span>
                  <span className="rs-col-cpu">CPU</span>
                  <span className="rs-col-mem">Memory</span>
                  <span className="rs-col-up">Uptime</span>
                </div>
                <ul className="soft-list">
                  {visible.map((r, i) => (
                    <ResourceListRow key={r.id} {...rowProps(r, i)} />
                  ))}
                </ul>
              </section>
            ) : (
              <section className="rs-grid" aria-label="Resources">
                {visible.map((r, i) => (
                  <ResourceCell key={r.id} {...rowProps(r, i)} />
                ))}
              </section>
            )}
          </>
        )}
        <Spacer end />
      </main>
    </>
  );
}
