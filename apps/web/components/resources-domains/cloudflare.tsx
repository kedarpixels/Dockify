"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, TextInput } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { Select, type SelectOption } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { callJson } from "@/lib/client-api";
import { cleanHost, joinHost, recordMode, SSL_LABEL, type CfDomains, type CfHostState, type CfRecord } from "@/lib/dashboard-domain";
import type { CloudflareZone } from "@/lib/pages/integrations";

// Dockify writes to Cloudflare only on an explicit press. Fix removes exactly the records on the
// screen, and the API refuses if Cloudflare holds anything else by then. Only switched-on zones are touched.

/** Admins only. */
export function useCloudflareDomains(enabled: boolean) {
  const [data, setData] = useState<CfDomains | null>(null);
  const [loading, setLoading] = useState(enabled);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!enabled) return;
    const mine = ++seq.current;
    setLoading(true);
    const r = await callJson<CfDomains>("/api/domains/cloudflare");
    if (mine !== seq.current) return;
    setLoading(false);
    setData(r.ok ? r.data : { connected: true, items: [], error: r.error });
  }, [enabled]);
  useEffect(() => {
    // Read once on open, in the background: a slow Cloudflare never holds the list up.
    void Promise.resolve().then(reload);
    const stop = seq;
    return () => void ++stop.current;
  }, [reload]);
  const stateOf = useCallback((domainId: string) => data?.items.find((i) => i.domainId === domainId)?.state ?? null, [data]);
  const put = useCallback((domainId: string, state: CfHostState) => {
    setData((d) => d && { ...d, items: d.items.some((i) => i.domainId === domainId) ? d.items.map((i) => (i.domainId === domainId ? { domainId, state } : i)) : [...d.items, { domainId, state }] });
  }, []);
  return { data, loading, reload, stateOf, put };
}

export function cfRowNote(s: CfHostState | null): string | null {
  if (!s?.managed) return null;
  const r = s.records[0];
  if (!r) return "No Cloudflare record";
  return recordMode(r);
}

const TONE = { bad: "bad", warn: "warn", info: undefined } as const;

export function CfStatePanel({
  state,
  canWrite,
  onCreate,
  onFix,
  busy = false,
}: {
  state: CfHostState;
  canWrite: boolean;
  onCreate?: () => void;
  onFix?: () => void;
  busy?: boolean;
}) {
  const needsRecord = state.managed && !state.records.length && !state.findings.some((f) => f.code === "dns_denied");
  const wrong = state.managed && state.records.length > 0 && !state.correct;
  return (
    <div className="cf-state" role="group" aria-label={`Cloudflare, ${state.hostname}`}>
      {state.managed ? (
        <dl className="cf-facts">
          <div>
            <dt>Zone</dt>
            <dd className="num">{state.zone?.name}</dd>
          </div>
          {state.sslMode ? (
            <div>
              <dt>SSL/TLS</dt>
              <dd>{SSL_LABEL[state.sslMode]}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {state.records.length ? <CfRecords records={state.records} /> : null}
      {state.findings.map((f) => (
        <Callout
          key={f.code}
          tone={TONE[f.tone]}
          icon={f.tone === "info" ? "info" : "alert"}
          action={
            canWrite && f.code === "no_record" && needsRecord && onCreate ? (
              <PendingButton className="btn btn-sm" pending={busy} onClick={onCreate}>
                Create the record
              </PendingButton>
            ) : canWrite && f.code === "wrong_target" && wrong && onFix ? (
              <PendingButton className="btn btn-sm" pending={busy} onClick={onFix}>
                Fix the record
              </PendingButton>
            ) : undefined
          }
        >
          {f.text}
        </Callout>
      ))}
      {canWrite && wrong && onFix && !state.findings.some((f) => f.code === "wrong_target") ? (
        <div className="cf-actions">
          <PendingButton className="btn btn-sm" pending={busy} onClick={onFix}>
            Fix the record
          </PendingButton>
        </div>
      ) : null}
    </div>
  );
}

export function CfRecords({ records, label = "Records on Cloudflare" }: { records: CfRecord[]; label?: string }) {
  return (
    <div className="dm-recs cf-recs" role="table" aria-label={label}>
      <div className="dm-rec dm-rec-hd" role="row">
        <span role="columnheader">Type</span>
        <span role="columnheader">Points to</span>
        <span role="columnheader">Mode</span>
      </div>
      {records.map((r) => (
        <div key={r.id} className="dm-rec" role="row">
          <span role="cell" className="dm-rec-type">
            {r.type}
          </span>
          <span role="cell" className="dm-rec-val">
            <span className="num dm-rec-text">{r.content}</span>
          </span>
          <span role="cell" className="cf-rec-mode">
            {recordMode(r)}
            {r.ours ? <span className="cf-ours">Made by Dockify</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The go-ahead for a write that removes records names each one. In direct mode a proxied name asks which way it should be carried. */
export function CfRecordDialog({
  open,
  state,
  onClose,
  onConfirm,
}: {
  open: boolean;
  state: CfHostState | null;
  onClose: () => void;
  onConfirm: (body: { proxied: boolean; replace?: string[] }) => unknown;
}) {
  const [proxied, setProxied] = useState(false);
  const tunnel = state?.expected?.proxied === true;
  const replacing = state?.records ?? [];
  const exp = state?.expected;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      tone={replacing.length ? "danger" : "default"}
      title={replacing.length ? "Replace the record" : "Create the record"}
      sub={state?.hostname}
      body={
        state && exp ? (
          <div className="rd-fields">
            {replacing.length ? (
              <>
                <p className="dlg-text">Dockify removes {replacing.length > 1 ? "these records" : "this record"} from Cloudflare first. Anything else at this name stays. If the records have changed by then, nothing happens.</p>
                <CfRecords records={replacing} label="Records to remove" />
              </>
            ) : null}
            <p className="dlg-text">
              {replacing.length ? "Then it creates" : "Dockify creates"} {exp.type.startsWith("A") ? "an" : "a"} {exp.type} record, <b className="num rd-strong">{state.hostname}</b> to <b className="num rd-strong">{exp.content}</b>
              {tunnel ? ", proxied through Cloudflare." : "."}
            </p>
            {!tunnel ? (
              <div className="cf-proxy">
                <span className="two">
                  <span className="two-main">Through Cloudflare&rsquo;s proxy</span>
                  <span className="two-sub">{proxied ? "SSL/TLS must be Full. Full (strict) works once the certificate is active." : "DNS only: visitors reach this server directly."}</span>
                </span>
                <Switch checked={proxied} onChange={setProxied} label="Through Cloudflare's proxy" />
              </div>
            ) : null}
          </div>
        ) : null
      }
      confirmLabel={replacing.length ? "Replace the record" : "Create the record"}
      onConfirm={() => onConfirm({ proxied, ...(replacing.length ? { replace: replacing.map((r) => r.id) } : {}) })}
    />
  );
}

/** Empty when Cloudflare is not connected. */
export function useCloudflareZones(enabled: boolean) {
  const [zones, setZones] = useState<CloudflareZone[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let on = true;
    void callJson<CloudflareZone[] | { data?: CloudflareZone[] }>("/api/integrations/cloudflare/zones").then((r) => {
      if (!on || !r.ok) return;
      setZones(Array.isArray(r.data) ? r.data : (r.data?.data ?? []));
    });
    return () => {
      on = false;
    };
  }, [enabled]);
  return zones;
}

/** With no managed zone it is the plain field, and the picker never shows. */
export function HostPicker({
  value,
  onChange,
  zones,
  error,
  label = "Hostname",
  hint = "Apex or subdomain, without https://",
  placeholder = "app.example.com",
  namePlaceholder = "app",
}: {
  value: string;
  onChange: (host: string) => void;
  zones: CloudflareZone[];
  error?: string | null;
  label?: string;
  hint?: string;
  placeholder?: string;
  namePlaceholder?: string;
}) {
  const managed = zones.filter((z) => z.managed);
  const [typing, setTyping] = useState(false);
  // Zones arrive after the field does: what was typed meanwhile stays a typed hostname.
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState("");
  const [zone, setZone] = useState<string | null>(null);
  const picked = zone ?? managed[0]?.name ?? null;
  if (!managed.length || typing || (value && !picking)) {
    return (
      <Field
        label={label}
        hint={
          managed.length ? (
            <button
              type="button"
              className="cf-switch"
              onClick={() => {
                setTyping(false);
                setPicking(true);
                setName("");
                onChange("");
              }}
            >
              Pick from Cloudflare instead
            </button>
          ) : (
            hint
          )
        }
        error={error}
      >
        {(ids) => (
          <TextInput ids={ids} className="num" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode="url" data-autofocus />
        )}
      </Field>
    );
  }
  const options: SelectOption<string>[] = managed.map((z) => ({ value: z.name, label: z.name, hint: z.status === "pending" ? "Nameservers pending" : undefined }));
  const others = zones.length - managed.length;
  const send = (n: string, z: string | null) => {
    setPicking(true);
    if (z) onChange(n.trim() ? joinHost(n, z) : "");
  };
  return (
    <div className="cf-pick">
      <Field label="Name" hint="A subdomain, or @ for the zone itself" error={error}>
        {(ids) => (
          <TextInput
            ids={ids}
            className="num"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              send(e.target.value, picked);
            }}
            placeholder={namePlaceholder}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            data-autofocus
          />
        )}
      </Field>
      <Field label="Zone" hint={others ? `${others === 1 ? "1 more zone is not managed. Turn it" : `${others} more zones are not managed. Turn them`} on in Settings, Integrations.` : undefined}>
        {(ids) => (
          <Select
            ids={ids}
            label="Zone"
            value={picked}
            options={options}
            onChange={(z) => {
              setZone(z);
              send(name, z);
            }}
            search={options.length > 8 ? "Search zones" : undefined}
          />
        )}
      </Field>
      <button
        type="button"
        className="cf-switch"
        onClick={() => {
          setTyping(true);
          onChange(cleanHost(joinHost(name, picked ?? "")));
        }}
      >
        <Icon name="edit" size={14} />
        Type a hostname instead
      </button>
    </div>
  );
}
