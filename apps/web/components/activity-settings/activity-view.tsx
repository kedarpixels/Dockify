"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { Topbar } from "@/components/shell/topbar";
import { Empty } from "@/components/ui/empty";
import { SearchField } from "@/components/ui/field";
import { GroupHead } from "@/components/ui/group-head";
import { NoSource } from "@/components/ui/no-source";
import { PendingButton } from "@/components/ui/pending";
import { ResultCount } from "@/components/ui/result-count";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Segmented, filterOptions } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { SkelRows } from "@/components/ui/skeleton";
import { Updating } from "@/components/ui/updating";
import { callJson } from "@/lib/client-api";
import { deriveNotices } from "@/lib/derive";
import { useDayHeading } from "@/lib/time-prefs";
import { downloadText } from "@/lib/download";
import { plural } from "@/lib/format";
import { useNow, useOverview } from "@/lib/hooks";
import type { ActivityActor, ActivityCategory, ActivityEvent, ActivityResult } from "@/lib/pages/activity-settings";
import type { OverviewResult } from "@/lib/types";
import { useCan } from "@/lib/viewer";
import { EventRow, SYSTEM_NAME } from "./activity-row";

type Filter = "all" | ActivityCategory;

/* Categories are kinds, not states, and the log pages from the server: no dots, no counts. */
const FILTERS = filterOptions<Filter>([
  { value: "all", label: "All" },
  { value: "deploys", label: "Deploys" },
  { value: "config", label: "Config" },
  { value: "access", label: "Access" },
  { value: "system", label: "System" },
]);

/** How often page one is asked again for events newer than the top of the list. */
const POLL_MS = 15_000;
/** A poll shows the "Updating" mark only once it has taken this long, as every polling page does. */
const SLOW_MS = 600;
/** How long a new row keeps its arrival tint. Matches the act-fresh animation in the CSS. */
const FRESH_MS = 2_000;
/** The sticky top bar's height: a log whose top is above this line is out of view. */
const TOPBAR_PX = 56;

/** The event row's columns (tile, sentence, place, time, key), so the skeleton holds its shape. */
const SKEL_TEMPLATE = "var(--col-status) minmax(0, 1fr) 176px var(--col-time) var(--col-key)";

/** The sentence as plain text, for the CSV export. */
function sentence(e: ActivityEvent) {
  return [e.actor?.name ?? SYSTEM_NAME, e.verb, e.target?.label, e.suffix].filter(Boolean).join(" ");
}

/** `more` after `have`, without the events `have` already holds. */
function append(have: ActivityEvent[], more: ActivityEvent[]) {
  const seen = new Set(have.map((e) => e.id));
  return [...have, ...more.filter((e) => !seen.has(e.id))];
}

/** The loaded events as CSV, one row each, every cell quoted. */
function toCsv(items: ActivityEvent[]) {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = items.map((e) => [e.at, e.category, e.action, e.actor?.name ?? SYSTEM_NAME, sentence(e), e.ip ?? "", e.location ?? ""].map(q).join(","));
  return ["time_utc,category,action,actor,event,ip,location", ...rows].join("\n") + "\n";
}

type Status = "idle" | "loading" | "more" | "error";

export function ActivityView({ overview, initial }: { overview: OverviewResult; initial: ActivityResult }) {
  const { result } = useOverview(overview);
  const now = useNow(30_000, initial.fetchedAt);
  const notices = useMemo(() => (result.data ? deriveNotices(result.data, now) : null), [result.data, now]);
  const can = useCan();

  const [items, setItems] = useState<ActivityEvent[]>(initial.data?.items ?? []);
  const [cursor, setCursor] = useState<string | null>(initial.data?.nextCursor ?? null);
  const [actors, setActors] = useState<ActivityActor[]>(initial.data?.actors ?? []);
  const [status, setStatus] = useState<Status>(initial.error ? "error" : "idle");
  const [error, setError] = useState<string | undefined>(initial.error);
  const [filter, setFilter] = useState<Filter>("all");
  const [actor, setActor] = useState("");
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const req = useRef(0);
  const search = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLElement>(null);
  // Live updates: ids that just slid in, how many arrived while the top was out of view, whether it
  // is, and whether a slow poll is on its way.
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [unseen, setUnseen] = useState(0);
  const [away, setAway] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const polling = useRef(false);

  const download = () => downloadText(`dockify-activity-${new Date(now).toISOString().slice(0, 10)}.csv`, toCsv(items));

  // The search settles for 250ms before it asks the API.
  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const params = (more: boolean) => {
    const p = new URLSearchParams();
    if (filter !== "all") p.set("category", filter);
    if (actor) p.set("actor", actor);
    if (q) p.set("q", q);
    if (more && cursor) p.set("cursor", cursor);
    return p;
  };

  const load = async (more: boolean) => {
    const id = ++req.current;
    setStatus(more ? "more" : "loading");
    const r = await callJson<ActivityResult>(`/api/activity?${params(more)}`);
    if (id !== req.current) return;
    const page = r.ok ? r.data?.data : null;
    if (!page) {
      // A failed first page clears the list: rows from the previous filters would read as matches.
      setStatus("error");
      setError(r.ok ? (r.data?.error ?? "The API did not answer") : r.error);
      if (more) return;
      setItems([]);
      setCursor(null);
      return;
    }
    // Rows that arrived by polling push older ones down a page, so the next page can repeat them.
    setItems((prev) => (more ? append(prev, page.items) : page.items));
    setCursor(page.nextCursor);
    if (page.actors.length) setActors(page.actors);
    setError(undefined);
    setStatus("idle");
  };

  // Any filter change reloads from the newest event. The first render already has page one, and
  // comparing keys (not a first-render flag) keeps a double-run effect from fetching it again.
  const filterKey = JSON.stringify([filter, actor, q]);
  const loadedKey = useRef(filterKey);
  const reload = useEffectEvent(() => {
    setOpen(new Set());
    setFresh(new Set());
    setUnseen(0);
    void load(false);
  });
  useEffect(() => {
    if (loadedKey.current === filterKey) return;
    loadedKey.current = filterKey;
    reload();
  }, [filterKey]);

  const noSource = initial.source === "none";
  // The activity log is for admins (the API refuses a Viewer), so a Viewer gets a plain note instead.
  const readable = can.manage;

  // Page one for the current filters, asked while the tab is visible and nothing else is loading.
  // Events newer than the top of the list slide in above it; a load that starts meanwhile wins.
  const tick = useEffectEvent(async () => {
    const loading = status === "loading" || status === "more";
    // One poll at a time: the interval and a tab coming back can fire together.
    if (document.hidden || loading || polling.current) return;
    polling.current = true;
    const id = req.current;
    const slow = setTimeout(() => setRefreshing(true), SLOW_MS);
    const r = await callJson<ActivityResult>(`/api/activity?${params(false)}`);
    clearTimeout(slow);
    setRefreshing(false);
    polling.current = false;
    const page = r.ok ? r.data?.data : null;
    // A missed poll is silent; the next one tries again. A load that started meanwhile wins.
    if (!page || id !== req.current) return;
    // Any answer ends an error state: the log is reachable again.
    if (status === "error") {
      setStatus("idle");
      setError(undefined);
      // A failed first page emptied the list and dropped its cursor, so this answer is page one
      // whole: rows, cursor and actors. Rows alone would end the list at "That is everything".
      if (!items.length) {
        setItems(page.items);
        setCursor(page.nextCursor);
        if (page.actors.length) setActors(page.actors);
        return;
      }
    }
    const have = new Set(items.map((e) => e.id));
    const top = items[0] ? Date.parse(items[0].at) : 0;
    const add = page.items.filter((e) => !have.has(e.id) && Date.parse(e.at) >= top);
    if (!add.length) return;
    setItems((prev) => append(add, prev));
    setFresh(new Set(add.map((e) => e.id)));
    if (away) setUnseen((n) => n + add.length);
  });

  useEffect(() => {
    if (noSource || !readable) return;
    const timer = setInterval(() => void tick(), POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [noSource, readable]);

  // New rows lose their arrival tint once it has played.
  useEffect(() => {
    if (!fresh.size) return;
    const t = setTimeout(() => setFresh(new Set()), FRESH_MS);
    return () => clearTimeout(t);
  }, [fresh]);

  // "Away" once the top of the log has scrolled under the top bar. Coming back clears the count.
  useEffect(() => {
    const onScroll = () => {
      const r = card.current?.getBoundingClientRect();
      const next = r ? r.top < TOPBAR_PX : false;
      setAway(next);
      if (!next) setUnseen(0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const jumpToNew = () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    setUnseen(0);
  };

  // Up and Down walk the rows: Down from the search enters them, Up from the first row goes back
  // to the search. Enter on a row opens it.
  const walk = (ev: React.KeyboardEvent, from: "list" | "search") => {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    if (from === "search" && ev.key === "ArrowUp") return;
    const rows = Array.from(card.current?.querySelectorAll<HTMLElement>(".act-list .act-row") ?? []);
    if (!rows.length) return;
    const at = from === "search" ? -1 : rows.findIndex((r) => r.contains(document.activeElement));
    ev.preventDefault();
    if (ev.key === "ArrowUp" && at <= 0) return search.current?.focus();
    rows[ev.key === "ArrowDown" ? Math.min(rows.length - 1, at + 1) : at - 1]?.focus();
  };

  const heading = useDayHeading();
  const groups = useMemo(() => {
    const out: Array<{ label: string; rows: ActivityEvent[] }> = [];
    for (const e of items) {
      const label = heading(e.at, now);
      const last = out.at(-1);
      if (last?.label === label) last.rows.push(e);
      else out.push({ label, rows: [e] });
    }
    return out;
  }, [items, now, heading]);

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const filtered = filter !== "all" || Boolean(actor);
  const clear = () => {
    setFilter("all");
    setActor("");
    setQuery("");
    setQ("");
  };

  return (
    <>
      <Topbar trail={["Activity"]} notices={notices} now={now} />
      <main className="page act" id="main" tabIndex={-1}>
        <SectionHead
          level={1}
          title="Activity"
          lead="Every deploy, config change, sign-in and system job on this server, newest first."
          actions={refreshing ? <Updating /> : null}
        />
        <Rule />

        {noSource ? (
          <NoSource />
        ) : !readable ? (
          <div className="card">
            <Empty icon="lock" title="Activity is for admins" body="Every deploy, config change and sign-in is listed here for admins. Ask an admin if you need an entry." />
          </div>
        ) : (
          <>
            <div className="toolbar">
              {/* Down from the search walks into the rows. The wrapper draws no box of its own. */}
              <span className="act-search" onKeyDown={(e) => walk(e, "search")}>
                <SearchField value={query} onChange={setQuery} inputRef={search} label="Search activity" placeholder="Search people, apps and domains" />
              </span>
              <span className="act-cats">
                <Segmented label="Filter by category" value={filter} onChange={setFilter} options={FILTERS} />
              </span>
              <span className="act-actor-filter">
                <Select
                  label="Filter by person"
                  icon="users"
                  align="end"
                  value={actor}
                  onChange={setActor}
                  options={[
                    { value: "", label: "Everyone", icon: "users" },
                    ...actors.map((a) => ({ value: a.id, label: a.name, icon: "user" as const })),
                    { value: "system", label: `${SYSTEM_NAME}, automatic`, icon: "server" as const },
                  ]}
                />
              </span>
              {status === "idle" ? <ResultCount count={items.length} one="event" query={q} /> : null}
            </div>
            <Rule />

            {status === "error" && items.length === 0 ? (
              <NoSource error={error ?? "The API did not answer"} polling onRetry={() => void load(false)} />
            ) : (
              <section ref={card} className="card act-card" aria-label="Activity log" aria-busy={status === "loading"}>
                {unseen > 0 && away && status === "idle" ? (
                  <div className="act-new-wrap">
                    <button type="button" className="new-pill num" onClick={jumpToNew} aria-label={`Show ${plural(unseen, "new event")}`}>
                      <span className="dot" data-tone="live" aria-hidden="true" />
                      {unseen.toLocaleString("en-US")} new
                    </button>
                  </div>
                ) : null}
                {status === "loading" ? (
                  <div className="act-list">
                    <SkelRows rows={Math.min(Math.max(items.length, 6), 25)} template={SKEL_TEMPLATE} cols={[24, "60%", 96, 48]} label="Loading activity" />
                  </div>
                ) : items.length === 0 ? (
                  filtered || q ? (
                    <Empty
                      icon="search"
                      title="No events match"
                      body={q ? `Nothing matches “${q}”. Try a wider search or clear the filters.` : "No events fit these filters. Try a wider filter or clear them."}
                      action={
                        <button type="button" className="btn btn-sm" onClick={clear}>
                          {filtered ? "Clear filters" : "Clear search"}
                        </button>
                      }
                    />
                  ) : (
                    <Empty icon="box" title="No activity yet" body="Deploys, config changes, sign-ins, backups and prunes are recorded here as they happen." />
                  )
                ) : (
                  <>
                    <div className="act-list" onKeyDown={(e) => walk(e, "list")}>
                      {groups.map((g) => (
                        <section key={g.label} aria-label={g.label}>
                          <GroupHead as="h2" label={g.label} count={g.rows.length} noun="event" />
                          <ul className="soft-list">
                            {g.rows.map((e) => (
                              <EventRow key={e.id} e={e} now={now} open={open.has(e.id)} fresh={fresh.has(e.id)} onToggle={() => toggle(e.id)} />
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
                    <div className="card-foot">
                      <span className="num">Showing {plural(items.length, "event")}</span>
                      {status === "error" ? (
                        <span className="tone-bad act-foot-error" role="alert">
                          {error}
                        </span>
                      ) : null}
                      <span className="act-foot-keys">
                        {cursor ? null : <span className="act-foot-end">That is everything</span>}
                        <button type="button" className="btn btn-sm btn-lead" onClick={download}>
                          <Icon name="download" />
                          Download CSV
                        </button>
                        {cursor ? (
                          <PendingButton className="btn btn-sm" onClick={() => void load(true)} pending={status === "more"}>
                            Load more
                          </PendingButton>
                        ) : null}
                      </span>
                    </div>
                  </>
                )}
              </section>
            )}
          </>
        )}
        <Spacer end />
      </main>
    </>
  );
}
