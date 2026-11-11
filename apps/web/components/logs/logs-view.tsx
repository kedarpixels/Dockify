"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { Topbar } from "@/components/shell/topbar";
import { Callout } from "@/components/ui/callout";
import { Empty } from "@/components/ui/empty";
import { envName } from "@/components/ui/env-tag";
import { projectsShowingEnvironments } from "@/lib/environments";
import { SearchField } from "@/components/ui/field";
import { NoSource } from "@/components/ui/no-source";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { filterOptions, Segmented } from "@/components/ui/segmented";
import { Select, type SelectOption } from "@/components/ui/select";
import { Skel } from "@/components/ui/skeleton";
import { deriveNotices, notRunning } from "@/lib/derive";
import { downloadText } from "@/lib/download";
import { appTitle, clause, plural } from "@/lib/format";
import { useNow, useOverview } from "@/lib/hooks";
import type { LogsResult } from "@/lib/pages/logs";
import type { OverviewResult } from "@/lib/types";
import { AppPicker, type PickerApp } from "./app-picker";
import { LogKeys } from "./log-keys";
import { LogList } from "./log-list";
import type { AppMeta } from "./log-rows";
import { checkPattern, colorSlot, compile, DEFAULT_FILTERS, filterKey, filtersSearch, isLiveRange, plainLine, type LogFilters, type LogLevel, type LogStream, type RuntimeLogLine } from "./model";
import { RangePicker } from "./range-picker";
import { useLogFeed, type LivePhase } from "./use-log-feed";

/* Streams are not statuses, and the list pages from the server, so the options carry neither a dot nor a count. */
const STREAMS = filterOptions<LogStream | "all">([
  { value: "all", label: "All" },
  { value: "stdout", label: "stdout" },
  { value: "stderr", label: "stderr" },
]);

const LEVELS: SelectOption<LogLevel | "all">[] = [
  { value: "all", label: "All levels", icon: "filter" },
  { value: "error", label: "Error", tone: "bad" },
  { value: "warn", label: "Warning", tone: "warn" },
  { value: "info", label: "Info", tone: "idle" },
  { value: "debug", label: "Debug", tone: "idle" },
];

const LIVE_TEXT: Record<LivePhase, string> = {
  off: "Fixed range",
  connecting: "Connecting",
  live: "Live",
  retrying: "Reconnecting",
  stopped: "Live tail stopped",
};

const LIVE_TONE: Record<LivePhase, "live" | "warn" | "bad" | "idle"> = { off: "idle", connecting: "idle", live: "live", retrying: "warn", stopped: "bad" };

/** Minutes either side of a line that its permalink opens. */
const AROUND = 5 * 60_000;

/** Also the route's loading state. */
export function LoadingRows() {
  const widths = ["62%", "48%", "71%", "39%", "56%", "66%", "44%", "58%", "35%", "69%", "51%", "47%"];
  return (
    <div className="lx-skel" role="status" aria-busy="true">
      <span className="sr">Loading logs</span>
      {widths.map((w, i) => (
        <div key={i} className="lx-skel-row" aria-hidden="true">
          <Skel w={64} />
          <Skel w={96} />
          <Skel w={28} />
          <Skel w={w} />
        </div>
      ))}
    </div>
  );
}

export function LogsView({ initial, overview, filters: start }: { initial: LogsResult | null; overview: OverviewResult; filters: LogFilters }) {
  const { result: ov } = useOverview(overview);
  const now = useNow(30_000, initial?.fetchedAt ?? overview.fetchedAt);
  const notices = useMemo(() => (ov.data ? deriveNotices(ov.data, now) : null), [ov.data, now]);
  const countId = useId();

  const [filters, setFilters] = useState(start);
  const [text, setText] = useState(start.q);
  const [wrap, setWrap] = useState(false);
  const source = initial?.source ?? ov.source;
  const enabled = source !== "none";
  const { feed, live, setPaused, loadOlder, retry, reconnect } = useLogFeed({ filters, initial, enabled });

  const patch = (p: Partial<LogFilters>) => setFilters((f) => ({ ...f, ...p }));

  useEffect(() => {
    const id = setTimeout(() => setFilters((f) => (f.q === text.trim() ? f : { ...f, q: text.trim() })), 300);
    return () => clearTimeout(id);
  }, [text]);

  // A line hash only survives while the filters it was opened with stay.
  const key = filterKey(filters);
  const [startKey] = useState(() => filterKey(start));
  useEffect(() => {
    const url = new URL(window.location.href);
    url.search = filtersSearch(filters).toString();
    if (key !== startKey) url.hash = "";
    window.history.replaceState(window.history.state, "", url);
  }, [filters, key, startKey]);

  // The overview's order also fixes each app's colour.
  const catalogue = useMemo(() => ov.data?.resources ?? [], [ov.data]);
  const pickerApps = useMemo<PickerApp[]>(() => {
    const order = catalogue.map((r) => r.id);
    return catalogue.map((r) => ({ id: r.id, name: appTitle(r), kind: r.kind, project: r.projectSlug, env: r.environment, stopped: notRunning(r.status), onVercel: !!r.onVercel, slot: colorSlot(r.id, order) }));
  }, [catalogue]);
  // A picked app on Vercel prints nothing here: its lines are read live on its own page, never stored.
  const pickedOnVercel = pickerApps.filter((a) => a.onVercel && filters.apps.includes(a.id));
  const meta = useMemo(() => {
    const shows = projectsShowingEnvironments(catalogue);
    const m = new Map<string, AppMeta>();
    for (const a of pickerApps) m.set(a.id, { label: `${a.project} / ${a.name}`, env: a.env === "production" || !shows(a.project) ? undefined : envName(a.env, true), slot: a.slot });
    return m;
  }, [pickerApps, catalogue]);
  const nameOf = (id: string) => meta.get(id)?.label ?? id;

  const patternError = checkPattern(filters.q, filters.regex);
  const re = useMemo(() => compile(filters.q, filters.regex), [filters.q, filters.regex]);
  const tailing = enabled && isLiveRange(filters) && live !== "off";
  const follow = tailing && !feed.paused;
  const paused = tailing && feed.paused;
  // A relative range is only off while its first page loads or while its search cannot run, so
  // the label keeps the phase it last showed (Connecting at first) instead of reading "Fixed range".
  const [lastLive, setLastLive] = useState<LivePhase>("connecting");
  if (live !== "off" && live !== lastLive) setLastLive(live);
  const shownLive = live === "off" && isLiveRange(filters) ? lastLive : live;
  const narrowed = filters.apps.length > 0 || filters.stream !== "all" || filters.level !== "all";
  const filtered = narrowed || !!filters.q;

  const clearFilters = () => {
    setText("");
    setFilters((f) => ({ ...DEFAULT_FILTERS, range: f.range, from: f.from, to: f.to }));
  };

  const permalink = (l: RuntimeLogLine) => {
    const t = Date.parse(l.ts);
    const p = new URLSearchParams({ apps: l.appId, from: new Date(t - AROUND).toISOString(), to: new Date(t + AROUND).toISOString() });
    return `${window.location.origin}/logs?${p}#L-${l.id}`;
  };

  const plainText = () => feed.lines.map((l) => plainLine(l, nameOf(l.appId))).join("\n");
  const allText = async () => plainText();
  const download = () => downloadText(`dockify-logs-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}.log`, plainText());

  const lead = enabled ? "Output from every app on this server, live or back to 7 days." : "Connect this dashboard to a Dockify API to see your app logs.";

  const status =
    feed.phase === "loading" ? (
      <LoadingRows />
    ) : feed.phase === "invalid" ? (
      <div className="lx-callout">
        <Callout tone="bad" icon="alert" role="alert">
          {clause(patternError ?? "Fix the search pattern to see lines")}.
        </Callout>
      </div>
    ) : feed.phase === "error" ? (
      <Empty
        icon="logs"
        title="Logs are unavailable"
        body={`${clause(feed.error ?? "The API did not answer")}. Try again in a moment.`}
        action={
          <button type="button" className="btn btn-sm" onClick={retry}>
            Try again
          </button>
        }
      />
    ) : feed.lines.length === 0 ? (
      filtered ? (
        <Empty
          icon="search"
          title="No log lines match"
          body={filters.q ? `Nothing matches “${filters.q}” in this range. Try another search or a longer range.` : "Nothing matches these filters in this range. Try other apps or a longer range."}
          action={
            <button type="button" className="btn btn-sm" onClick={clearFilters}>
              {narrowed ? "Clear filters" : "Clear search"}
            </button>
          }
        />
      ) : tailing ? (
        <Empty icon="logs" title="No log lines yet" body="Nothing printed in this range yet. New lines show here as soon as an app writes them." />
      ) : (
        <Empty
          icon="logs"
          title="No log lines in this range"
          body="Nothing printed in this window. Try a longer range."
          action={
            filters.range !== "7d" ? (
              <button type="button" className="btn btn-sm" onClick={() => patch({ range: "7d", from: undefined, to: undefined })}>
                Show last 7 days
              </button>
            ) : undefined
          }
        />
      )
    ) : undefined;

  const count = feed.lines.length;

  return (
    <>
      <Topbar trail={["Logs"]} notices={notices} now={now} />
      <main className="page lx" id="main" tabIndex={-1}>
        <SectionHead level={1} title="Logs" lead={lead} />

        {!enabled ? (
          <>
            <Rule />
            <NoSource icon="logs" />
          </>
        ) : (
          <>
            <Rule />
            <div className="toolbar lx-filters">
              <SearchField
                value={text}
                onChange={setText}
                label="Search logs"
                placeholder={filters.regex ? "Regular expression" : "Search log lines"}
                className="lx-search"
                invalid={!!checkPattern(text.trim(), filters.regex)}
                describedBy={countId}
              >
                <button
                  type="button"
                  className="btn btn-xs btn-icon lx-regex"
                  aria-pressed={filters.regex}
                  aria-label="Regular expression"
                  data-tip={filters.regex ? "Regular expression on" : "Regular expression"}
                  data-tip-side="bottom"
                  onClick={() => patch({ regex: !filters.regex })}
                >
                  <span aria-hidden="true">.*</span>
                </button>
              </SearchField>
              <AppPicker apps={pickerApps} value={filters.apps} onChange={(apps) => patch({ apps })} />
              <Segmented label="Filter by stream" value={filters.stream} onChange={(stream) => patch({ stream })} options={STREAMS} />
              <Select className="lx-level" label="Filter by level" value={filters.level} onChange={(level) => patch({ level })} options={LEVELS} />
              <RangePicker value={filters} onChange={(w) => patch({ from: undefined, to: undefined, ...w })} />
            </div>
            <Rule />

            <div className="toolbar">
              <span className="lx-live" data-phase={shownLive} aria-live="polite">
                <span className={shownLive === "live" && !paused ? "dot pulse" : "dot"} data-tone={paused ? "warn" : LIVE_TONE[shownLive]} aria-hidden="true" />
                {paused ? "Paused" : LIVE_TEXT[shownLive]}
              </span>
              {live === "stopped" ? (
                <button type="button" className="btn btn-xs" onClick={reconnect}>
                  Reconnect
                </button>
              ) : null}
              <span id={countId} className="lx-count num">
                {plural(count, "line")}
                {feed.dropped > 0 ? `, ${feed.dropped.toLocaleString("en-US")} skipped` : ""}
              </span>
              <span className="lx-keys">
                {tailing ? (
                  <button
                    type="button"
                    className="btn btn-icon"
                    aria-label={feed.paused ? "Resume live tail" : "Pause live tail"}
                    data-tip={feed.paused ? "Resume live tail" : "Pause live tail"}
                    onClick={() => setPaused(!feed.paused)}
                  >
                    <Icon name={feed.paused ? "play" : "pause"} />
                  </button>
                ) : null}
                <LogKeys wrap={wrap} onWrap={() => setWrap(!wrap)} allText={allText} empty={count === 0} download={download} />
              </span>
            </div>
            <Rule />

            {pickedOnVercel.length ? (
              <>
                <div className="lx-callout lx-vercel">
                  {pickedOnVercel.map((a) => (
                    <Callout
                      key={a.id}
                      icon="vercel"
                      action={
                        <Link href={`/apps/${encodeURIComponent(a.id)}?tab=logs`} className="btn btn-sm">
                          Open live logs
                        </Link>
                      }
                    >
                      <b className="pd-strong">{a.project} / {a.name} is on Vercel.</b> Its lines are read live on its page and not stored here.
                    </Callout>
                  ))}
                </div>
                <Rule />
              </>
            ) : null}

            <LogList
              lines={feed.lines}
              base={feed.base}
              apps={meta}
              re={re}
              wrap={wrap}
              follow={follow}
              onPause={tailing ? setPaused : undefined}
              fresh={tailing && feed.paused ? feed.buffer.length : 0}
              pinKey={feed.key}
              older={{ more: !!feed.older, trimmed: feed.trimmed, pending: feed.olderPhase === "loading", error: feed.olderError, load: () => void loadOlder() }}
              status={status}
              permalink={permalink}
            />
          </>
        )}
        <Spacer end />
      </main>
    </>
  );
}
