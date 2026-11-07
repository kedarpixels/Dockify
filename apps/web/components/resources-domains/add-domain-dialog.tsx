"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { AppIcon } from "@/components/icons/app-icon";
import { Dialog } from "@/components/ui/dialog";
import { envName } from "@/components/ui/env-tag";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { elevate } from "@/components/step-up/step-up";
import type { CfHostState, CfLookup } from "@/lib/dashboard-domain";
import { cleanHost } from "@/lib/dashboard-domain";
import { isStepUpCancel } from "@/lib/step-up";
import { PendingButton } from "@/components/ui/pending";
import { Select, type SelectOption } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { callJson } from "@/lib/client-api";
import { resolvesItself } from "@/lib/dashboard-domain";
import type { DomainTargets } from "@/lib/domain-targets";
import { projectsShowingEnvironments } from "@/lib/environments";
import { appTitle } from "@/lib/format";
import type { DomainRow } from "@/lib/pages/resources-domains";
import type { Resource } from "@/lib/types";
import { CfRecords, HostPicker, useCloudflareZones } from "./cloudflare";
import { useTestDomainOffer } from "./test-domain";
import { DnsRecords, recordFor, recordsFor, type DnsRecord } from "./shared";

const HOST_RE = /^(?=.{4,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

/** The preview's new row: it lives in local state only, never reaching an API. */
function previewDomain(host: string, target: Resource, test = false): DomainRow {
  return {
    id: `local_${Date.now().toString(36)}`,
    hostname: host,
    appId: target.id,
    appName: target.name,
    ...(target.displayName ? { appDisplayName: target.displayName } : {}),
    projectSlug: target.projectSlug,
    environment: target.environment,
    tls: { status: "pending", issuer: null, expiresAt: null },
    dns: { status: "unchecked", resolved: [], checkedAt: null, detail: null },
    probe: { status: "untried", detail: null, checkedAt: null },
    test,
    createdAt: new Date().toISOString(),
  };
}

/** Two steps: the hostname and its app, then the DNS records to create before the certificate can issue. */
export function AddDomainDialog({
  targets,
  existing,
  target: to,
  live,
  cloudflare = false,
  vercelApps = 0,
  onClose,
  onAdded,
}: {
  targets: Resource[];
  /** Apps left out of `targets` because Vercel serves them: the hint says where their domains go. */
  vercelApps?: number;
  existing: DomainRow[];
  /** Where the records point: the server's addresses, or the tunnel. */
  target: DomainTargets;
  live: boolean;
  /** Cloudflare is connected: pick from its zones, and offer to create the record. */
  cloudflare?: boolean;
  onClose: () => void;
  onAdded: (d: DomainRow, recordMade?: boolean) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [hostname, setHostname] = useState("");
  const [appId, setAppId] = useState(targets[0]?.id ?? "");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const zones = useCloudflareZones(cloudflare);
  const [lookup, setLookup] = useState<CfHostState | null>(null);
  const [create, setCreate] = useState(true);
  const [proxied, setProxied] = useState(false);
  const offer = useTestDomainOffer();
  const [testing, setTesting] = useState(false);
  const stepBody = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  // The key that changed the step unmounts with it, so focus lands on the new step's first control.
  useEffect(() => {
    if (moved.current) stepBody.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, [step]);
  const go = (to: 1 | 2) => {
    moved.current = true;
    setStep(to);
  };

  const host = cleanHost(hostname);
  const target = targets.find((t) => t.id === appId);
  const shows = useMemo(() => projectsShowingEnvironments(targets), [targets]);

  const hostError = !host
    ? "Enter a hostname"
    : !HOST_RE.test(host)
      ? "Use a full hostname such as app.example.com"
      : existing.some((d) => d.hostname === host)
        ? `${host} is already on this server`
        : null;
  // One option per app, "project / app" with the environment as the hint, grouped by project.
  const appOptions = useMemo<SelectOption<string>[]>(
    () =>
      [...targets]
        .sort((x, y) => x.projectSlug.localeCompare(y.projectSlug) || appTitle(x).localeCompare(appTitle(y)) || (x.environment === "production" ? -1 : 1))
        .map((t) => ({ value: t.id, label: `${t.projectSlug} / ${appTitle(t)}`, hint: shows(t.projectSlug) ? envName(t.environment) : undefined, glyph: <AppIcon id={t.id} kind={t.kind} /> })),
    [targets, shows],
  );
  const rec = recordFor(host);
  const tunnel = to.ingress === "cloudflare_tunnel";
  // A CNAME to the apex works when the apex already points at this server.
  const apexHere = !tunnel && !rec.isApex && existing.some((d) => d.hostname === rec.apex && d.dns.status === "ok");

  const next = () => {
    setTouched(true);
    if (hostError || !target) return;
    go(2);
    if (!cloudflare) return;
    // What Cloudflare holds at this name, for the second step. Its answer never holds the step up.
    setLookup(null);
    void callJson<CfLookup>(`/api/domains/cloudflare/lookup?hostname=${encodeURIComponent(host)}`).then((r) => {
      if (r.ok) setLookup(r.data.state);
    });
  };

  // On a press only: each one is a certificate from Let's Encrypt. The API makes up the name.
  const addTestDomain = async () => {
    if (!target || testing || busy) return;
    if (!live) {
      onAdded(previewDomain(`${target.name}-a1b2c3.${offer?.suffix ?? "sslip.io"}`, target, true));
      return;
    }
    setTesting(true);
    const r = await callJson<DomainRow>("/api/domains/test", { method: "POST", body: { appId: target.id } });
    setTesting(false);
    if (r.ok && r.data?.id) {
      onAdded(r.data, true);
      return;
    }
    toast.error("Could not add a test domain", { description: r.ok ? "The API sent no domain" : r.error });
  };

  const add = async () => {
    if (!target || busy) return;
    const wantRecord = offerCreate && create;
    if (!live) {
      onAdded(previewDomain(host, target), wantRecord);
      return;
    }
    setBusy(true);
    const r = await callJson<DomainRow>("/api/domains", { method: "POST", body: { hostname: host, appId: target.id } });
    if (r.ok && r.data?.id) {
      if (!wantRecord) {
        onAdded(r.data);
        return;
      }
      const added = r.data;
      // The domain is added either way; a record that fails is created from its row afterwards.
      const rec = await elevate(() => callJson(`/api/domains/${encodeURIComponent(added.id)}/cloudflare`, { method: "POST", body: { proxied } }), { what: "Creating a Cloudflare record" });
      if (!rec.ok && !isStepUpCancel(rec)) toast.error("Domain added, but its record was not created", { description: rec.error });
      onAdded(added, rec.ok);
      return;
    }
    toast.error("Could not add the domain", { description: r.ok ? "The API sent no domain" : r.error });
    setBusy(false);
  };

  // On a managed zone with nothing at the name, Dockify offers to add it. In a tunnel it does so on add.
  const offerCreate = !tunnel && !!lookup?.managed && !lookup.records.length && !!lookup.expected;
  // The records the mode needs (an A, and an AAAA with IPv6; or the tunnel's CNAME), then the apex alternative.
  const base = recordsFor(host, to);
  const records: DnsRecord[] = [...base, ...(apexHere && base.length ? [{ type: "CNAME", name: rec.name, value: rec.apex, alt: true }] : [])];

  return (
    <Dialog
      open
      icon="globe"
      title={step === 1 ? "Add domain" : "Point DNS at this server"}
      sub={step === 1 ? "Step 1 of 2, hostname and app" : `Step 2 of 2, DNS ${base.length > 1 ? "records" : "record"}`}
      onClose={onClose}
      onSubmit={step === 1 ? next : () => void add()}
      busy={busy}
      footer={
        <>
          {step === 1 ? (
            <>
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={!targets.length}>
                Continue
                <Icon name="arrowRight" size={16} className="ic-trail" />
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => go(1)} disabled={busy}>
                Back
              </button>
              <PendingButton type="submit" className="btn btn-primary" pending={busy} icon="plus">
                Add domain
              </PendingButton>
            </>
          )}
        </>
      }
    >
      {step === 1 ? (
        <div ref={stepBody} className="rd-fields">
          <HostPicker value={hostname} onChange={setHostname} zones={zones} error={touched ? hostError : null} />
          <Field
            label="Target app"
            hint={`${target ? `Traffic goes to ${target.projectSlug} / ${appTitle(target)}${shows(target.projectSlug) ? ` in ${envName(target.environment)}` : ""}.` : "No app can take a domain yet."}${vercelApps ? " Apps on Vercel are not listed: add their domains on Vercel." : ""}`}
          >
            {(ids) => (
              <Select
                ids={ids}
                label="Target app"
                value={appId || null}
                options={appOptions}
                onChange={setAppId}
                placeholder="No app available"
                disabled={!targets.length}
                search={appOptions.length > 8 ? "Search apps" : undefined}
              />
            )}
          </Field>
          {offer?.available && target && (target.kind === "frontend" || target.kind === "backend") ? (
            <div className="cf-proxy dm-test-offer">
              <span className="two">
                <span className="two-main">No domain yet?</span>
                <span className="two-sub">A test address on sslip.io with HTTPS and nothing to set up, for trying things out. Use your own domain for real traffic.</span>
              </span>
              <PendingButton className="btn" pending={testing} onClick={() => void addTestDomain()}>
                Use a free test domain
              </PendingButton>
            </div>
          ) : null}
        </div>
      ) : (
        <div ref={stepBody} className="rd-fields">
          {lookup?.managed && lookup.records.length ? (
            lookup.correct ? (
              <Callout tone="ok" icon="checkCircle">
                The record is on Cloudflare already, and points here.
              </Callout>
            ) : (
              <>
                <Callout tone="warn" icon="alert">
                  {host} already has {lookup.records.length > 1 ? "records" : "a record"} on Cloudflare. Dockify leaves {lookup.records.length > 1 ? "them" : "it"} alone; fix {lookup.records.length > 1 ? "them" : "it"} from the domain&rsquo;s row once it is added.
                </Callout>
                <CfRecords records={lookup.records} />
              </>
            )
          ) : null}
          {offerCreate ? (
            <>
              <div className="cf-proxy">
                <span className="two">
                  <span className="two-main">Create the record on Cloudflare</span>
                  <span className="two-sub">
                    A record, {host} to {lookup.expected?.content}, in {lookup.zone?.name}.
                  </span>
                </span>
                <Switch checked={create} onChange={setCreate} label="Create the record on Cloudflare" />
              </div>
              {create ? (
                <div className="cf-proxy">
                  <span className="two">
                    <span className="two-main">Through Cloudflare&rsquo;s proxy</span>
                    <span className="two-sub">{proxied ? "SSL/TLS must be Full. Full (strict) works once the certificate is active." : "DNS only: visitors reach this server directly."}</span>
                  </span>
                  <Switch checked={proxied} onChange={setProxied} label="Through Cloudflare's proxy" />
                </div>
              ) : null}
            </>
          ) : null}
          {resolvesItself(host) ? (
            <p className="dlg-text">sslip.io answers for this address by itself, so there is no record to create. The certificate is requested once it is added.</p>
          ) : lookup?.managed && (lookup.records.length || (offerCreate && create)) ? null : records.length ? (
            <>
              <p className="dlg-text">
                {tunnel
                  ? `Create this record where ${rec.apex} is managed, proxied through Cloudflare. The domain serves once it resolves.`
                  : `Create ${base.length > 1 ? "these records" : "this record"} where ${rec.apex} is managed. The certificate is requested once the domain points here.`}
              </p>
              <DnsRecords records={records} />
            </>
          ) : (
            <p className="dlg-text">Point {host} at this server where {rec.apex} is managed. The certificate is requested once the domain points here.</p>
          )}
          {offerCreate || resolvesItself(host) ? null : <p className="fld-note">
            {tunnel
              ? "With Cloudflare connected and this zone managed, Dockify creates the record itself. It checks the record on its own."
              : "Behind Cloudflare the record can be proxied, with SSL/TLS on Full: Full (strict) works once the certificate is active, Flexible never does. Dockify checks the record on its own."}
          </p>}
        </div>
      )}
    </Dialog>
  );
}
