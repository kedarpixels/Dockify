"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { Topbar } from "@/components/shell/topbar";
import { elevate } from "@/components/step-up/step-up";
import type { ChipTone } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { SearchField } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { NoSource } from "@/components/ui/no-source";
import { PendingButton } from "@/components/ui/pending";
import { ResultCount } from "@/components/ui/result-count";
import { Rule, Spacer } from "@/components/ui/rule";
import { SectionHead } from "@/components/ui/section-head";
import { Segmented, filterOptions } from "@/components/ui/segmented";
import { toast } from "@/components/ui/toast";
import { callJson } from "@/lib/client-api";
import { worstFinding, type CfHostState } from "@/lib/dashboard-domain";
import { deriveNotices } from "@/lib/derive";
import { domainTargets } from "@/lib/domain-targets";
import { describe, errText } from "@/lib/feedback";
import { plural } from "@/lib/format";
import { useNow, useOverview } from "@/lib/hooks";
import type { DomainRow, DomainsPayload, PageResult } from "@/lib/pages/resources-domains";
import { isStepUpCancel } from "@/lib/step-up";
import type { OverviewResult } from "@/lib/types";
import { useCan } from "@/lib/viewer";
import { AddDomainDialog } from "./add-domain-dialog";
import { CfRecordDialog, CfStatePanel, cfRowNote, useCloudflareDomains } from "./cloudflare";
import { DOMAINS_POLL_MS, domainSettling } from "./live";
import { usePageRefresh } from "./refresh";
import { DomainHead, DomainRow as DomainLine, tlsState } from "./shared";

/** A domain needs attention when its certificate is not plainly active, its record does not point here, or Cloudflare's setup breaks it. */
const hasIssue = (d: DomainRow, now: number, cf: CfHostState | null) => tlsState(d.tls, now).tone !== "ok" || d.dns.status !== "ok" || worstFinding(cf) === "bad";

const issueTone = (d: DomainRow, now: number, cf: CfHostState | null): ChipTone => (tlsState(d.tls, now).tone === "bad" || d.dns.status === "mismatch" || worstFinding(cf) === "bad" ? "bad" : "warn");

type Filter = "all" | "issues";

export function DomainsView({ overview, initial }: { overview: OverviewResult; initial: PageResult<DomainsPayload> }) {
  const { result } = useOverview(overview);
  const now = useNow(30_000, initial.fetchedAt);
  const o = result.data;
  const can = useCan();
  const live = initial.source === "api";
  const target = useMemo(() => domainTargets(initial.data), [initial.data]);
  const [items, setRows] = useState<DomainRow[]>(initial.data?.items ?? []);
  // Counts the changes made here (an add, a remove, a recheck), so a list that was asked for before
  // one is not laid over it.
  const writes = useRef(0);
  const asked = useRef(0);
  const setItems = (next: (xs: DomainRow[]) => DomainRow[]) => {
    writes.current += 1;
    setRows(next);
  };
  // A new domain's record lookup and certificate settle on the server, so the list is read again
  // while any row waits on them. Otherwise it reads Pending and Not checked until a manual recheck.
  usePageRefresh(live && items.some(domainSettling), DOMAINS_POLL_MS, () => {
    asked.current = writes.current;
  });
  const adopt = useEffectEvent((rows: DomainRow[]) => {
    if (asked.current === writes.current) setRows(rows);
  });
  const listed = initial.data?.items;
  const firstList = useRef(listed);
  useEffect(() => {
    if (listed && listed !== firstList.current) adopt(listed);
  }, [listed]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<DomainRow | null>(null);
  // Remove also removes the record Dockify made, unless the owner keeps it.
  const [keepRecord, setKeepRecord] = useState(false);
  const cf = useCloudflareDomains(can.manage && !!initial.data);
  const [writing, setWriting] = useState<{ domain: DomainRow; state: CfHostState } | null>(null);
  const [checking, setChecking] = useState<Set<string>>(() => new Set());
  const [checkingAll, setCheckingAll] = useState(false);
  // Every lookup listens to one signal, aborted on unmount so no check outlives the page.
  const stop = useRef<AbortController>(null);
  useEffect(() => {
    const ctl = new AbortController();
    stop.current = ctl;
    return () => ctl.abort();
  }, []);
  // Ids with a lookup in flight, read synchronously so a row is never checked twice at once.
  const inflight = useRef(new Set<string>());
  // The row that takes the focus once a removed one is gone: the next in the list, else the one before.
  const nextAfterRemove = useRef<string | null>(null);

  const notices = useMemo(() => (o ? deriveNotices(o, now) : null), [o, now]);

  // Apps that serve HTTP can take a domain; databases, caches and bots cannot.
  const targets = useMemo(
    () => (o?.resources ?? []).filter((r) => (r.kind === "frontend" || r.kind === "backend" || r.kind === "s3") && !r.onVercel),
    [o],
  );

  const flagged = items.filter((d) => hasIssue(d, now, cf.stateOf(d.id)));
  const issues = flagged.length;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((d) => (filter === "all" || hasIssue(d, now, cf.stateOf(d.id))) && (!q || [d.hostname, d.projectSlug, d.appName, d.appDisplayName ?? ""].some((s) => s.toLowerCase().includes(q))))
      .sort((a, b) => a.projectSlug.localeCompare(b.projectSlug) || a.hostname.split(".").length - b.hostname.split(".").length || a.hostname.localeCompare(b.hostname));
  }, [items, filter, query, now, cf]);

  const stopped = () => stop.current?.signal.aborted ?? false;

  const setBusy = (ids: string[], on: boolean) => {
    ids.forEach((id) => (on ? inflight.current.add(id) : inflight.current.delete(id)));
    if (!stopped()) setChecking(new Set(inflight.current));
  };

  const merge = (fresh: DomainRow[]) => {
    if (!stopped() && fresh.length) setItems((xs) => xs.map((x) => fresh.find((n) => n.id === x.id) ?? x));
  };

  /** Rejects with the API error, or when the page closes. */
  const lookup = (d: DomainRow): Promise<DomainRow> => {
    const signal = stop.current?.signal;
    if (!live) {
      // Preview: a short wait stands in for the lookup; the record itself is unchanged.
      return new Promise((done, fail) => {
        const t = setTimeout(() => done({ ...d, dns: { ...d.dns, checkedAt: new Date().toISOString() } }), 900);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          fail(signal.reason);
        });
      });
    }
    return callJson<DomainRow>(`/api/domains/${encodeURIComponent(d.id)}/check`, { method: "POST", signal }).then((r) => {
      if (!r.ok) throw new Error(r.error);
      if (!r.data?.id) throw new Error("The API sent no domain");
      return r.data;
    });
  };

  /** Toast descriptions say so in preview, where nothing reaches an API. */
  const note = (text: string) => describe(text, { preview: !live });

  /** What a check cut short by leaving the page says, instead of a failure. */
  const STOPPED = { title: "Recheck stopped", description: "The page closed before it finished." };

  const recheck = (d: DomainRow) => {
    if (inflight.current.has(d.id)) return;
    setBusy([d.id], true);
    const run = lookup(d)
      .then((next) => {
        merge([next]);
        return next;
      })
      .finally(() => setBusy([d.id], false));
    void toast
      .promise(run, {
        loading: `Checking ${d.hostname}`,
        description: note("Looking up its DNS records"),
        success: (next) =>
          next.dns.status === "ok"
            ? `${d.hostname} points here`
            : {
                title:
                  next.dns.status === "mismatch" ? `${d.hostname} points elsewhere` : next.dns.status === "missing" ? `No record for ${d.hostname}` : `${d.hostname} is still waiting for DNS`,
                tone: "warn",
              },
        error: (e) => (stopped() ? STOPPED : `Could not check ${d.hostname}, ${errText(e, "the API did not answer")}`),
      })
      .catch(() => {});
  };

  /** A few at a time so the resolver is not flooded. */
  const recheckAll = () => {
    if (checkingAll) return;
    // A row already being checked on its own is left to that check.
    const list = visible.filter((d) => !inflight.current.has(d.id));
    if (!list.length) return;
    setCheckingAll(true);
    void cf.reload();
    const run = (async () => {
      let failed = 0;
      let off = 0;
      for (let i = 0; i < list.length && !stopped(); i += 4) {
        const batch = list.slice(i, i + 4).filter((d) => !inflight.current.has(d.id));
        const ids = batch.map((d) => d.id);
        setBusy(ids, true);
        const out = await Promise.allSettled(batch.map(lookup));
        setBusy(ids, false);
        const fresh = out.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
        merge(fresh);
        failed += out.length - fresh.length;
        off += fresh.filter((n) => n.dns.status !== "ok").length;
      }
      if (stopped()) throw new Error("Stopped");
      if (failed) throw new Error(`${failed.toLocaleString("en-US")} of ${plural(list.length, "lookup")} failed`);
      return { n: list.length, off };
    })().finally(() => {
      if (!stopped()) setCheckingAll(false);
    });
    void toast
      .promise(run, {
        loading: `Checking ${plural(list.length, "domain")}`,
        description: note("Looking up each domain’s DNS records"),
        success: ({ n, off }) =>
          off
            ? { title: `${off.toLocaleString("en-US")} of ${plural(n, "domain")} ${off === 1 ? "does" : "do"} not point here`, tone: "warn" }
            : n === 1
              ? "The domain points here"
              : `All ${n.toLocaleString("en-US")} domains point here`,
        error: (e) => (stopped() ? STOPPED : errText(e, "Could not recheck the domains")),
      })
      .catch(() => {});
  };

  /** Throws after toasting, so the confirm stays open for another try. Closing "Confirm it is you" keeps it open without a toast. */
  const remove = async (d: DomainRow) => {
    if (live) {
      const r = await elevate(() => callJson(`/api/domains/${encodeURIComponent(d.id)}${keepRecord ? "?keepRecord=1" : ""}`, { method: "DELETE" }), { what: "Removing a domain" });
      if (!r.ok) {
        if (!isStepUpCancel(r)) toast.error("Could not remove the domain", { description: describe([d.hostname, r.error]) });
        throw new Error(r.error);
      }
    }
    const at = visible.findIndex((x) => x.id === d.id);
    nextAfterRemove.current = (visible[at + 1] ?? visible[at - 1])?.id ?? null;
    setItems((xs) => xs.filter((x) => x.id !== d.id));
    toast.success("Domain removed", { description: note(`${d.hostname}, from ${d.projectSlug} / ${d.appDisplayName ?? d.appName}`) });
  };

  /** After a removal: the neighbouring row's hostname, else the search, else the page title. */
  const focusAfterRemove = () => {
    const id = nextAfterRemove.current;
    const row = id ? document.querySelector<HTMLElement>(`[data-domain="${CSS.escape(id)}"] .dm-host`) : null;
    return row ?? document.querySelector<HTMLElement>(".rd-tools input");
  };

  const added = (d: DomainRow, recordMade = false) => {
    setItems((xs) => [...xs, d]);
    setAdding(false);
    setQuery("");
    toast.success(d.test ? "Test domain added" : "Domain added", { description: note(`${d.hostname} on ${d.projectSlug} / ${d.appDisplayName ?? d.appName}${d.test ? ", its certificate is on the way" : recordMade ? ", with its record on Cloudflare" : ", create its DNS record next"}`) });
    void cf.reload();
  };

  /** Throws after toasting, so the confirm stays open for another try. */
  const writeRecord = async (d: DomainRow, body: { proxied: boolean; replace?: string[] }) => {
    const r = await elevate(() => callJson<{ state: CfHostState }>(`/api/domains/${encodeURIComponent(d.id)}/cloudflare`, { method: "POST", body }), { what: "Changing a Cloudflare record" });
    if (!r.ok) {
      if (!isStepUpCancel(r)) toast.error("Could not change the record", { description: describe([d.hostname, r.error]) });
      void cf.reload();
      throw new Error(r.error);
    }
    cf.put(d.id, r.data.state);
    toast.success(body.replace?.length ? "Record replaced on Cloudflare" : "Record created on Cloudflare", { description: note(d.hostname) });
    recheck(d);
  };

  const data = initial.data;
  // With nothing added yet the counts would read "0 domains across 0 projects", so the lead says what the page is for.
  const lead =
    data && items.length
      ? `${plural(items.length, "domain")} across ${plural(new Set(items.map((d) => d.projectSlug)).size, "project")}, ${issues ? `${issues} need${issues === 1 ? "s" : ""} attention` : "every one healthy"}.`
      : "Every hostname this server answers, with its certificate and DNS.";

  return (
    <>
      <Topbar trail={["Domains"]} notices={notices} now={now} />
      <main className="page" id="main" tabIndex={-1}>
        <SectionHead
          level={1}
          title="Domains"
          lead={lead}
          actions={
            data && can.manage ? (
              <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
                <Icon name="plus" />
                Add domain
              </button>
            ) : null
          }
        />
        <Rule />

        {!data ? (
          <NoSource error={initial.error} />
        ) : items.length === 0 ? (
          <div className="card">
            <Empty
              icon="globe"
              title="No domains yet"
              body={
                can.manage
                  ? "Add a hostname, point its DNS at this server, and Dockify issues the certificate."
                  : "Hostnames show up here once an admin adds them."
              }
            />
          </div>
        ) : (
          <>
            <div className="toolbar rd-tools">
              <SearchField value={query} onChange={setQuery} label="Search domains" placeholder="Search hostnames, projects and apps" />
              <Segmented
                label="Filter domains"
                value={filter}
                onChange={setFilter}
                options={filterOptions<Filter>([
                  { value: "all", label: "All", count: items.length },
                  {
                    value: "issues",
                    label: "Needs attention",
                    tone: issues ? (flagged.some((d) => issueTone(d, now, cf.stateOf(d.id)) === "bad") ? "bad" : "warn") : "idle",
                    count: issues,
                  },
                ])}
              />
              {can.manage ? (
                <PendingButton className="btn dm-recheck-all" onClick={recheckAll} pending={checkingAll} disabled={!visible.length}>
                  Recheck all
                </PendingButton>
              ) : null}
              <ResultCount count={visible.length} one="domain" query={query} />
            </div>
            <Rule />

            {visible.length === 0 ? (
              <div className="card">
                {filter === "issues" && !query.trim() ? (
                  <Empty icon="checkCircle" title="No domains need attention" body="Every certificate is active and every record points at this server." />
                ) : (
                  <Empty
                    icon="search"
                    title="No domains match"
                    body={query.trim() ? `Nothing matches “${query.trim()}”. Try a hostname, project or app name.` : "Try a different search or show every domain."}
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
                )}
              </div>
            ) : (
              <section className="rd-list" aria-label="Domains">
                <DomainHead target />
                <ul className="dm-rows">
                  {visible.map((d, i) => {
                    const busy = checking.has(d.id);
                    const cfState = cf.stateOf(d.id);
                    return (
                      <DomainLine
                        key={d.id}
                        d={d}
                        now={now}
                        target={target}
                        checking={busy}
                        showTarget
                        dnsNote={cfRowNote(cfState)}
                        recordsDone={cfState?.managed === true && cfState.correct}
                        extra={
                          cfState && cfState.findings.some((f) => f.code !== "no_zone") || cfState?.records.length ? (
                            <div className="dm-fix">
                              <CfStatePanel state={cfState} canWrite={can.manage} onCreate={() => setWriting({ domain: d, state: cfState })} onFix={() => setWriting({ domain: d, state: cfState })} />
                            </div>
                          ) : null
                        }
                        delay={Math.min(i, 12) * 30}
                        actions={
                          can.manage ? (
                            <>
                              <PendingButton
                                className="btn btn-sm btn-icon"
                                aria-label={`Recheck DNS for ${d.hostname}`}
                                data-tip={busy ? "Checking" : "Recheck DNS"}
                                pending={busy}
                                icon="refresh"
                                onClick={() => recheck(d)}
                              />
                              <button
                                type="button"
                                className="btn btn-sm btn-icon btn-quiet-danger"
                                aria-label={`Remove ${d.hostname}`}
                                onClick={() => {
                                  setKeepRecord(false);
                                  setRemoving(d);
                                }}
                              >
                                <Icon name="trash" />
                              </button>
                            </>
                          ) : null
                        }
                      />
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
        <Spacer end />
      </main>

      {adding ? (
        <AddDomainDialog targets={targets} vercelApps={(o?.resources ?? []).filter((r) => r.onVercel).length} existing={items} target={target} live={live} cloudflare={cf.data?.connected === true} onClose={() => setAdding(false)} onAdded={added} />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        tone="danger"
        title="Remove domain"
        body={
          removing ? (
            <div className="rd-fields">
              <p className="dlg-text">
                <b className="rd-strong">{removing.hostname}</b> stops answering for {removing.projectSlug} / {removing.appDisplayName ?? removing.appName} and its certificate is deleted.{" "}
                {cf.stateOf(removing.id)?.records.some((r) => r.ours) ? "" : "DNS records are left as they are."}
              </p>
              {cf.stateOf(removing.id)?.records.some((r) => r.ours) ? (
                <div className="cf-proxy">
                  <span className="two">
                    <span className="two-main">Remove its Cloudflare record too</span>
                    <span className="two-sub">{keepRecord ? "The record stays on Cloudflare." : "Only the record Dockify made. Nothing else in the zone changes."}</span>
                  </span>
                  <Switch checked={!keepRecord} onChange={(v) => setKeepRecord(!v)} label="Remove its Cloudflare record too" />
                </div>
              ) : null}
            </div>
          ) : null
        }
        confirmLabel="Remove domain"
        confirmIcon="trash"
        onConfirm={() => (removing ? remove(removing) : undefined)}
        returnFocus={focusAfterRemove}
      />
      <CfRecordDialog open={writing !== null} state={writing?.state ?? null} onClose={() => setWriting(null)} onConfirm={(body) => (writing ? writeRecord(writing.domain, body) : undefined)} />
    </>
  );
}
