"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { AppIcon, ProjectIcon } from "@/components/icons/app-icon";
import { Chip, StatusChip } from "@/components/ui/chip";
import { Empty } from "@/components/ui/empty";
import { EnvTag } from "@/components/ui/env-tag";
import { SearchField } from "@/components/ui/field";
import { GroupHead } from "@/components/ui/group-head";
import { Meter } from "@/components/ui/meter";
import { ResultCount } from "@/components/ui/result-count";
import { Rule } from "@/components/ui/rule";
import { Segmented, filterOptions } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { appTitle, bytes, plural } from "@/lib/format";
import { useTimeFormat } from "@/lib/time-prefs";
import { useHydrated } from "@/lib/hooks";
import type { ContainerRow, ContainerState } from "@/lib/pages/server-backups";
import type { HostSnapshot } from "@/lib/types";
import { useSecond } from "./live";
import { upLive } from "./util";

/* Every container on the host, grouped by project, searchable, filterable and sortable. */

type SortKey = "name" | "state" | "app" | "cpu" | "memory" | "restarts" | "uptime";
type CtrFilter = "all" | "running" | "issues";

/** Every column, its cell class, and whether it sorts as a number (largest first). */
const COLUMNS: Array<{ key: SortKey; label: string; cls: string; numeric?: boolean }> = [
  { key: "name", label: "Container", cls: "sb-c-name" },
  { key: "state", label: "Status", cls: "sb-c-state" },
  { key: "app", label: "App", cls: "sb-c-app" },
  { key: "cpu", label: "CPU", cls: "sb-c-cpu", numeric: true },
  { key: "memory", label: "Memory", cls: "sb-c-mem", numeric: true },
  { key: "restarts", label: "Restarts", cls: "sb-c-rs", numeric: true },
  { key: "uptime", label: "Uptime", cls: "sb-c-up", numeric: true },
];

/** Container states as a status chip, the way Services and Resources show a running state. */
const STATE_TONE: Record<ContainerState, "ok" | "warn" | "bad" | "idle"> = {
  running: "ok",
  restarting: "warn",
  unhealthy: "bad",
  exited: "idle",
};

const STATE_LABEL: Record<ContainerState, string> = {
  running: "Running",
  restarting: "Restarting",
  unhealthy: "Unhealthy",
  exited: "Exited",
};

/** Sorting by status puts problems first: unhealthy, restarting, exited, then running. */
const STATE_RANK: Record<ContainerState, number> = { unhealthy: 0, restarting: 1, exited: 2, running: 3 };

/** An issue is anything not plainly running, or a container that keeps restarting. */
const isIssue = (c: ContainerRow) => c.state !== "running" || c.restarts >= 3;

const SYSTEM_GROUP = "__dockify";

const appName = (c: ContainerRow) => (c.app ? `${c.app.projectSlug} / ${appTitle(c.app)}` : "Dockify");

function sortValue(c: ContainerRow, key: SortKey): number | string {
  switch (key) {
    case "name":
      return c.name;
    case "state":
      return STATE_RANK[c.state];
    case "app":
      return appName(c);
    case "cpu":
      return c.state === "exited" ? -1 : c.cpuPct;
    case "memory":
      return c.state === "exited" ? -1 : c.memoryBytes;
    case "restarts":
      return c.restarts;
    case "uptime":
      // An earlier start is a longer uptime; containers that are not running sort last.
      return c.startedAt ? -Date.parse(c.startedAt) : -Infinity;
  }
}

function ContainerRowView({ c, tick, host }: { c: ContainerRow; tick: number; host: HostSnapshot }) {
  const time = useTimeFormat();
  const local = useHydrated();
  const memPct = (c.memoryBytes / host.memory.totalBytes) * 100;
  const off = c.state === "exited";
  const href = c.app ? `/apps/${c.app.id}` : null;
  return (
    <div role="row" className="sb-crow" data-state={c.state}>
      <span role="rowheader" className="sb-c-name">
        <span className="sb-c-id">{c.name}</span>
      </span>
      <span role="cell" className="sb-c-state">
        <StatusChip tone={STATE_TONE[c.state]}>{STATE_LABEL[c.state]}</StatusChip>
      </span>
      <span role="cell" className="sb-c-app">
        {c.app && href ? (
          <Link href={href} className="sb-c-applink">
            <AppIcon id={c.app.id} kind={c.app.kind} />
            {/* The group head above already names the project. */}
            <span className="sb-c-appname">{appTitle(c.app)}</span>
            <EnvTag env={c.app.environment} compact quiet />
          </Link>
        ) : (
          <span className="sb-c-applink" data-system="true">
            <Icon name="server" size={16} />
            <span className="sb-c-appname">Control plane</span>
          </span>
        )}
      </span>
      {/* A stopped container reads Idle and the CPU reading is the meter's own, both as on Resources. */}
      <span role="cell" className="sb-c-cpu" data-label="CPU">
        {off ? <span className="none">Idle</span> : <Meter pct={c.cpuPct} label="CPU, share of the host" />}
      </span>
      <span role="cell" className="sb-c-mem" data-label="Memory">
        {off ? <span className="none">Idle</span> : <Meter pct={memPct} text={bytes(c.memoryBytes)} label={`Memory, ${Math.round(memPct * 10) / 10}% of the host`} />}
      </span>
      <span role="cell" className="sb-c-rs">
        {c.restarts > 0 ? (
          <Chip size="xs" tone={c.restarts >= 3 ? "bad" : "warn"} className="num">
            {c.restarts}
            {/* Read aloud always; shown only on the two-line rows, which have no Restarts header. */}
            <span className="sr"> {c.restarts === 1 ? "restart" : "restarts"}</span>
            <span className="sb-rs-word" aria-hidden="true">
              {" "}
              {c.restarts === 1 ? "restart" : "restarts"}
            </span>
          </Chip>
        ) : (
          <span className="none num sb-rs-zero">0</span>
        )}
      </span>
      {/* Without a start time from the API the uptime is unknown, never guessed. */}
      <span role="cell" className="sb-c-up num">
        {c.startedAt ? (
          <span data-tip={`Started ${time.abs(c.startedAt, { utc: !local && !time.prefs.timeZone })}`} data-tip-align="end">
            {upLive((tick - Date.parse(c.startedAt)) / 1000)}
          </span>
        ) : (
          <span className="none">{off ? "None" : "Unknown"}</span>
        )}
      </span>
    </div>
  );
}

export function ContainersCard({ containers, now, host }: { containers: ContainerRow[]; now: number; host: HostSnapshot }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "cpu", dir: "desc" });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CtrFilter>("all");
  // Uptime cells count every second on the shared clock.
  const tick = useSecond(now);

  const counts = useMemo(
    () => ({
      all: containers.length,
      running: containers.filter((c) => c.state === "running").length,
      issues: containers.filter(isIssue).length,
    }),
    [containers],
  );

  // Dockify's own containers first, then each project in the order the API lists them.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const keep = containers.filter(
      (c) =>
        (filter === "all" || (filter === "running" ? c.state === "running" : isIssue(c))) &&
        (!q || c.name.toLowerCase().includes(q) || appName(c).toLowerCase().includes(q)),
    );
    const order = [SYSTEM_GROUP, ...new Set(containers.flatMap((c) => (c.app ? [c.app.projectSlug] : [])))];
    const cmp = (a: ContainerRow, b: ContainerRow) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      const c = typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y)) : x === y ? 0 : x < y ? -1 : 1;
      // Ties fall back to the name, so equal rows never swap places between polls.
      return (sort.dir === "asc" ? c : -c) || a.name.localeCompare(b.name);
    };
    return order
      .map((key) => ({
        key,
        all: containers.filter((c) => (c.app?.projectSlug ?? SYSTEM_GROUP) === key),
        rows: keep.filter((c) => (c.app?.projectSlug ?? SYSTEM_GROUP) === key).sort(cmp),
      }))
      .filter((g) => g.rows.length > 0);
  }, [containers, query, filter, sort]);

  const flip = (key: SortKey, numeric?: boolean) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: numeric ? "desc" : "asc" }));

  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  const sortLabel = COLUMNS.find((c) => c.key === sort.key)!.label;

  return (
    <section className="card sb-ctr" aria-labelledby="sb-ctr-title">
      <div className="card-hd">
        <CardTitle
          id="sb-ctr-title"
          icon="layers"
          title="Containers"
          sub={`${plural(containers.length, "container")}, ${counts.running} running${counts.issues ? `, ${plural(counts.issues, "issue")}` : ""}`}
        />
      </div>
      {containers.length === 0 ? (
        <Empty icon="box" title="No containers yet" body="Deploy an app and its containers show up here with their CPU and memory." />
      ) : (
        <>
          <div className="toolbar sb-ctr-tools">
            <SearchField value={query} onChange={setQuery} label="Search containers" placeholder="Search containers and apps" />
            <Segmented
              label="Filter containers"
              value={filter}
              onChange={setFilter}
              options={filterOptions<CtrFilter>([
                { value: "all", label: "All", count: counts.all },
                { value: "running", label: "Running", tone: "ok", count: counts.running },
                { value: "issues", label: "Needs attention", tone: counts.issues ? "bad" : "idle", count: counts.issues },
              ])}
            />
            <ResultCount count={shown} one="container" query={query} />
            {/* Narrow widths hide the header row, so sorting moves into this pair. */}
            <span className="sb-ctr-sort">
              <Select
                label="Sort containers by"
                align="end"
                value={sort.key}
                options={COLUMNS.map((c) => ({ value: c.key, label: c.label }))}
                onChange={(key) => setSort({ key, dir: COLUMNS.find((c) => c.key === key)!.numeric ? "desc" : "asc" })}
              />
              <button
                type="button"
                className="btn btn-icon"
                aria-label={sort.dir === "asc" ? "Sorted ascending, switch to descending" : "Sorted descending, switch to ascending"}
                onClick={() => setSort((s) => ({ ...s, dir: s.dir === "asc" ? "desc" : "asc" }))}
              >
                <Icon name={sort.dir === "asc" ? "arrowUp" : "arrowDown"} />
              </button>
            </span>
          </div>
          <Rule />

          {shown === 0 ? (
            <Empty
              icon="search"
              title="No containers match"
              body={query.trim() ? `Nothing matches “${query.trim()}” with this filter. Try another name or clear the search.` : "No container is in this state right now."}
              action={
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                  }}
                >
                  {filter === "all" ? "Clear search" : "Clear filters"}
                </button>
              }
            />
          ) : (
            <div className="sb-ctable" role="table" aria-label={`Containers, sorted by ${sortLabel.toLowerCase()}`}>
              <div role="rowgroup" className="sb-chead">
                <div role="row" className="sb-crow sb-crow-hd">
                  {COLUMNS.map((col) => {
                    const on = sort.key === col.key;
                    return (
                      <span
                        key={col.key}
                        role="columnheader"
                        className={col.cls}
                        data-numeric={col.numeric || undefined}
                        aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                      >
                        <button type="button" className="sb-sort" data-on={on || undefined} onClick={() => flip(col.key, col.numeric)}>
                          {col.label}
                          <Icon name={on ? (sort.dir === "asc" ? "arrowUp" : "arrowDown") : "updown"} size={12} />
                        </button>
                      </span>
                    );
                  })}
                </div>
              </div>
              {groups.map((g) => {
                const issues = g.all.filter(isIssue).length;
                const system = g.key === SYSTEM_GROUP;
                const label = system ? "Dockify system" : g.key;
                return (
                  <div role="rowgroup" key={g.key} className="sb-cgroup" aria-label={label}>
                    {/* The shared group head, in a one-cell row so the table stays a table. */}
                    <div role="row">
                      <div role="cell">
                        <GroupHead
                          label={label}
                          icon={system ? "server" : undefined}
                          lead={system ? undefined : <ProjectIcon slug={g.key} />}
                          count={g.rows.length}
                          noun="container"
                          actions={
                            issues ? (
                              <Chip size="xs" tone="bad" className="num">
                                {plural(issues, "issue")}
                              </Chip>
                            ) : undefined
                          }
                        />
                      </div>
                    </div>
                    {g.rows.map((c) => (
                      <ContainerRowView key={c.id} c={c} tick={tick} host={host} />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
          <div className="card-foot sb-ctr-foot">
            <span className="num">
              Showing {shown} of {plural(containers.length, "container")}
            </span>
            <span className="num">CPU and memory bars show each container’s share of the host</span>
          </div>
        </>
      )}
    </section>
  );
}
