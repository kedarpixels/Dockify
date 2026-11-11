"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/icon";
import { Callout } from "@/components/ui/callout";
import { StatusChip } from "@/components/ui/chip";
import { CopyButton } from "@/components/ui/copy-button";
import { cx } from "@/components/ui/cx";
import { EnvTag, useRowEnv } from "@/components/ui/env-tag";
import { IconTile } from "@/components/ui/icon-tile";
import { When } from "@/components/ui/when";
import type { Tone } from "@/lib/derive";
import { plural, timeAgo } from "@/lib/format";
import { useTimeFormat } from "@/lib/time-prefs";
import { useHydrated } from "@/lib/hooks";
import type { DomainTargets } from "@/lib/domain-targets";
import type { DomainRow as DomainData, TlsStatus } from "@/lib/pages/resources-domains";

/** The tip reads UTC until hydrated, as `When` does. */
export function Stamp({ iso, tip, className, children }: { iso: string; tip?: string; className?: string; children: React.ReactNode }) {
  const time = useTimeFormat();
  const hydrated = useHydrated();
  const at = time.abs(iso, { utc: !hydrated && !time.prefs.timeZone });
  return (
    <time dateTime={iso} className={cx("when num", className)} data-tip={tip ? `${tip} ${at}` : at} suppressHydrationWarning>
      {children}
    </time>
  );
}

/** A certificate this close to expiry is flagged, even though renewal normally runs on its own. */
const EXPIRY_WARN_DAYS = 14;

const DAY = 86_400_000;

/** The project page knows no DNS state and leaves out the project, which would only repeat the page. */
export interface DomainView {
  id: string;
  hostname: string;
  appId: string;
  appName: string;
  appDisplayName?: string;
  projectSlug?: string;
  environment: string;
  tls: { status: TlsStatus; issuer?: string | null; expiresAt: string | null };
  /** Absent where the page has no DNS lookup to show. */
  dns?: DomainData["dns"];
  /** What asking the domain itself found, for records that name a proxy. */
  probe?: DomainData["probe"];
  /** A free test domain Dockify generated: there is no record to set. */
  test?: boolean;
  /** The app's port. Null: no route exists until there is one. Absent where the page does not know. */
  appPort?: number | null;
  createdAt?: string;
}

/** The record to create: "@" for an apex, the labels left of the registered name otherwise. */
export function recordFor(hostname: string) {
  const labels = hostname.split(".");
  const apex = labels.slice(-2).join(".");
  return { apex, name: labels.length > 2 ? labels.slice(0, -2).join(".") : "@", isApex: labels.length <= 2 };
}

/** Direct mode: an A record, and an AAAA when the server has IPv6. Tunnel mode: a proxied CNAME. Empty when the target is not known. */
export function recordsFor(hostname: string, t: DomainTargets): DnsRecord[] {
  const { name } = recordFor(hostname);
  if (t.ingress === "cloudflare_tunnel") return t.tunnelTarget ? [{ type: "CNAME", name, value: t.tunnelTarget }] : [];
  return [...(t.ipv4 ? [{ type: "A", name, value: t.ipv4 }] : []), ...(t.ipv6 ? [{ type: "AAAA", name, value: t.ipv6 }] : [])];
}

/** Switches to hours inside the last two days and minutes inside the last hour, so it visibly ticks as expiry nears. */
function expiresIn(iso: string, now: number) {
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return "Unknown";
  if (ms <= 0) return `Expired ${timeAgo(iso, now)}`;
  if (ms >= 2 * DAY) return `${plural(Math.floor(ms / DAY), "day")} left`;
  if (ms >= 3_600_000) return `${Math.floor(ms / 3_600_000)}h left`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m left`;
}

/** A certificate is only asked for once the domain points here, so until then a pending one reads Waiting for DNS. */
export function tlsState(tls: DomainView["tls"], now: number, dns?: DomainData["dns"]["status"]): { label: string; tone: Tone } {
  if (tls.status === "pending") return dns && dns !== "ok" ? { label: "Waiting for DNS", tone: "pending" } : { label: "Pending", tone: "pending" };
  if (tls.status === "failed") return { label: "Failed", tone: "bad" };
  if (tls.expiresAt) {
    const at = Date.parse(tls.expiresAt);
    // Whole days left, counted down: 13.9 days left reads as 13.
    const n = Math.floor((at - now) / DAY);
    if (at <= now) return { label: "Expired", tone: "bad" };
    if (n < 1) return { label: "Expires today", tone: "warn" };
    if (n <= EXPIRY_WARN_DAYS) return { label: `Expires in ${plural(n, "day")}`, tone: "warn" };
  }
  return { label: "Active", tone: "ok" };
}

const DNS_STATE: Record<DomainData["dns"]["status"], { label: string; tone: Tone }> = {
  ok: { label: "Points here", tone: "ok" },
  mismatch: { label: "Points elsewhere", tone: "bad" },
  missing: { label: "No record", tone: "warn" },
  unchecked: { label: "Not checked", tone: "idle" },
};

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  /** An alternative to the records above it, marked "or". */
  alt?: boolean;
}

/** A record marked `alt`, or with `or` every row after the first, is an alternative. */
export function DnsRecords({ records, or = false, label = "DNS records to create" }: { records: DnsRecord[]; or?: boolean; label?: string }) {
  return (
    <div className="dm-recs" role="table" aria-label={label}>
      <div className="dm-rec dm-rec-hd" role="row">
        <span role="columnheader">Type</span>
        <span role="columnheader">Name</span>
        <span role="columnheader">Value</span>
      </div>
      {records.map((r, i) => (
        <div key={`${r.type}-${i}`} className="dm-rec" role="row">
          <span role="cell" className="dm-rec-type">
            {r.alt || (or && i) ? <span className="dm-rec-or">or</span> : null}
            {r.type}
          </span>
          <span role="cell" className="dm-rec-val">
            <span className="num dm-rec-text">{r.name}</span>
            <CopyButton value={r.name} what={`${r.type} name`} />
          </span>
          <span role="cell" className="dm-rec-val">
            <span className="num dm-rec-text">{r.value}</span>
            <CopyButton value={r.value} what={`${r.type} value`} align="end" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** The worker checks a waiting domain again on its own, less often as it ages; the row's Recheck key asks at once. */
function DnsFix({ d, dns, probe, records, tunnel }: { d: DomainView; dns: DomainData["dns"]; probe?: DomainData["probe"]; records: DnsRecord[]; tunnel: boolean }) {
  const rec = recordFor(d.hostname);
  const found = dns.resolved.filter((r) => !r.startsWith("cname:")).join(", ");
  const why = dns.detail ? (
    <>{dns.detail}</>
  ) : dns.status === "mismatch" ? (
    <>
      Resolves to <b className="num rd-strong">{found || "another address"}</b>, not this server.
    </>
  ) : dns.status === "missing" ? (
    <>No record found yet.</>
  ) : (
    <>Not checked yet.</>
  );
  const set = records.length ? (
    <>
      {" "}
      Set {records.length > 1 ? "these records" : "this record"}
      {tunnel ? ", proxied," : ""} where {rec.apex} is managed.
    </>
  ) : null;
  const asked = probe?.status === "failed" && probe.detail ? probe.detail : null;
  return (
    <div className="dm-fix" role="group" aria-label={`Waiting for DNS, ${d.hostname}`}>
      <Callout tone={dns.status === "mismatch" ? "bad" : dns.status === "missing" ? "warn" : undefined} icon={dns.status === "unchecked" ? "info" : "alert"}>
        {why}
        {set} Dockify checks again on its own.
      </Callout>
      {records.length ? <DnsRecords records={records} label={`DNS records for ${d.hostname}`} /> : null}
      {asked ? (
        <p className="dm-probe">
          <Icon name="globe" size={16} />
          <span>{asked}</span>
        </p>
      ) : null}
    </div>
  );
}

// An app with no port gets no route, whatever the DNS says. Never folded away: this is why the
// domain answers nothing. Dockify takes the port from the running image when it says one.
function NoPortNote({ d }: { d: DomainView }) {
  return (
    <div className="dm-fix" role="status">
      <Callout tone="warn" icon="alert">
        <b>No route yet: {d.appDisplayName ?? d.appName} has no port.</b> Dockify reads it from the running image. If this stays, set the port in the app&rsquo;s Settings, then deploy it again.
      </Callout>
    </div>
  );
}

function TestDomainNote() {
  return (
    <div className="dm-fix">
      <Callout icon="info">A free test domain on sslip.io: for trying things out, with nothing to set up. Its certificate comes from Let&rsquo;s Encrypt, which needs sslip.io to answer, so if it stays pending sslip.io may be down. Use your own domain for real traffic.</Callout>
    </div>
  );
}

export function DomainHead({ target = false, dns = true }: { target?: boolean; dns?: boolean }) {
  return (
    <div className="dm-head" aria-hidden="true">
      <span className="dm-col-host">{target ? "Hostname and target" : "Hostname"}</span>
      <span className="dm-col-tls">TLS</span>
      <span className="dm-col-exp">Expires</span>
      <span className="dm-col-dns">{dns ? "DNS" : null}</span>
      <span className="dm-col-act" />
    </div>
  );
}

/** Given `target`, a domain that does not point here reads Waiting for DNS and unfolds why and the records it needs. */
export function DomainRow({
  d,
  now,
  target,
  checking = false,
  showTarget = false,
  actions,
  delay = 0,
  dnsNote,
  extra,
  recordsDone = false,
  project,
}: {
  d: DomainView;
  now: number;
  target?: DomainTargets;
  checking?: boolean;
  showTarget?: boolean;
  actions?: React.ReactNode;
  delay?: number;
  /** A line under the DNS chip, such as how Cloudflare carries the name. */
  dnsNote?: string | null;
  /** More to unfold under the row, such as what Cloudflare says. */
  extra?: React.ReactNode;
  /** The record is right where it is managed, so the panel does not ask for it again. */
  recordsDone?: boolean;
  /** The project the row belongs to when `d` does not name it (a project's own page). */
  project?: string;
}) {
  const named = useRowEnv()(d.projectSlug ?? project ?? "", d.environment);
  const dns = d.dns;
  // A test domain has no DNS to wait for on the owner's side: its certificate is simply pending.
  const tls = tlsState(d.tls, now, d.test ? undefined : dns?.status);
  const fix = dns && dns.status !== "ok" && target ? { dns, records: recordsDone || d.test ? [] : recordsFor(d.hostname, target), tunnel: target.ingress === "cloudflare_tunnel" } : null;
  const [open, setOpen] = useState(false);
  // A recheck that fixes the record drops the fold, so a later break starts folded again.
  if (open && !fix && !extra && !(d.test && d.tls.status !== "active")) setOpen(false);
  const fixId = `dm-fix-${d.id}`;
  const testNote = d.test && d.tls.status !== "active" ? <TestDomainNote /> : null;
  const expand = fix || extra || testNote ? (
    <button
      type="button"
      className="btn btn-sm btn-icon dm-expand"
      aria-label={open ? `Hide the DNS details for ${d.hostname}` : `Show the DNS details for ${d.hostname}`}
      aria-expanded={open}
      aria-controls={fixId}
      onClick={() => setOpen((o) => !o)}
    >
      <Icon name="chevronDown" />
    </button>
  ) : null;

  return (
    <li className="reveal" style={{ animationDelay: `${delay}ms` }} data-domain={d.id}>
      <div className="dm-row">
        <span className="dm-col-host">
          <IconTile>
            <Icon name={d.tls.status === "active" ? "lock" : "globe"} />
          </IconTile>
          <span className="two">
            <a href={`https://${d.hostname}`} target="_blank" rel="noreferrer" className="two-main num dm-host">
              {d.hostname}
            </a>
            {showTarget ? (
              // Production is the default and says nothing in a row, nor does a project with one
              // environment; any other environment follows a comma.
              <span className="two-sub rd-sub">
                <span>
                  <Link href={`/apps/${d.appId}`} className="dm-app">
                    {d.projectSlug ? `${d.projectSlug} / ${d.appDisplayName ?? d.appName}` : (d.appDisplayName ?? d.appName)}
                  </Link>
                  {named ? "," : null}
                </span>
                {named ? <EnvTag env={d.environment} compact /> : null}
                {d.test ? <span className="dm-test-tag">Test domain</span> : null}
              </span>
            ) : d.createdAt ? (
              <span className="two-sub rd-sub">
                <When iso={d.createdAt} now={now} prefix="Added" className="num" />
                {d.test ? <span className="dm-test-tag">Test domain</span> : null}
              </span>
            ) : null}
          </span>
        </span>
        <span className="dm-col-tls">
          <StatusChip tone={tls.tone} tip={d.tls.issuer ? `Issued by ${d.tls.issuer}` : undefined}>
            {tls.label}
          </StatusChip>
        </span>
        <span className="dm-col-exp">
          {d.tls.expiresAt ? (
            <span className="two">
              <Stamp iso={d.tls.expiresAt} className={`dm-main${tls.tone === "warn" ? " tone-warn" : tls.tone === "bad" ? " tone-bad" : ""}`}>
                {expiresIn(d.tls.expiresAt, now)}
              </Stamp>
              <span className="two-sub">Renews automatically</span>
            </span>
          ) : (
            <span className="two">
              <span className="dm-main none">No certificate</span>
              <span className="two-sub">{d.tls.status === "failed" ? "Issuance failed" : dns?.status === "ok" || d.test ? "Being issued" : "Once DNS points here"}</span>
            </span>
          )}
        </span>
        {dns ? (
          <span className="dm-col-dns">
            {/* The lookup's age rides in the tip, so the row keeps the 56px of every two-line row. */}
            <StatusChip
              tone={DNS_STATE[dns.status].tone}
              tip={checking ? "Checking now" : dns.checkedAt ? `Checked ${timeAgo(dns.checkedAt, now)}` : "Never checked"}
            >
              {DNS_STATE[dns.status].label}
            </StatusChip>
            {dnsNote ? <span className="dm-dns-note">{dnsNote}</span> : null}
          </span>
        ) : null}
        {expand || actions ? (
          <span className="dm-col-act">
            {expand}
            {actions}
          </span>
        ) : null}
      </div>
      {d.appPort === null ? <NoPortNote d={d} /> : null}
      {fix || extra || testNote ? (
        <div id={fixId} className="dm-fold" data-open={open} inert={!open}>
          <div className="dm-fold-inner">
            {fix ? <DnsFix d={d} dns={fix.dns} probe={d.probe} records={fix.records} tunnel={fix.tunnel} /> : null}
            {testNote}
            {extra}
          </div>
        </div>
      ) : null}
    </li>
  );
}
