"use client";

import { useRef, useState } from "react";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { GroupHead } from "@/components/ui/group-head";
import { SkelRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { When } from "@/components/ui/when";
import { describe, report } from "@/lib/feedback";
import type { CloudflareIntegration, CloudflareZone } from "@/lib/pages/integrations";
import { Facts, FormKeys, Hint, IntegrationCard, ProviderDialog, TokenField, Unavailable, useProviderCard, useTokenForm } from "./card";
import { ExternalLink } from "@/components/ui/external-link";
import { intFetch, type Setter } from "./client";
import { useStepUp } from "@/components/step-up/step-up";

/* Each zone opts in on its own switch, which flips at once and rolls back if the API refuses. */

function ConnectForm({ onDone, onCancel, preview }: { onDone: (v: CloudflareIntegration) => void; onCancel: () => void; preview: boolean }) {
  const { elevate } = useStepUp();
  const form = useTokenForm();
  const { busy } = form;

  const submit = async () => {
    if (!form.begin()) return;
    const r = await elevate(() => intFetch<CloudflareIntegration>("/cloudflare", { method: "POST", body: { token: form.token.trim() } }), { what: "Connecting Cloudflare" });
    form.setBusy(false);
    report(r, { success: "Cloudflare connected", error: "Could not connect Cloudflare", what: r.ok ? r.data.account.name : undefined, preview });
    if (r.ok) onDone(r.data);
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Connect Cloudflare"
      sub="Create DNS records and certificates automatically"
      icon="cloud"
      size="sm"
      busy={busy}
      onSubmit={() => void submit()}
      footer={
        <FormKeys onCancel={onCancel} busy={busy} icon="link">
          Connect
        </FormKeys>
      }
    >
      <TokenField
        label="API token"
        form={form}
        hint={
          <>
            Create one at <ExternalLink href="https://dash.cloudflare.com/profile/api-tokens">dash.cloudflare.com</ExternalLink> with permission to edit DNS on the zones Dockify
            should manage (in Cloudflare: Zone, DNS, Edit). Add Zone, Zone Settings, Read so Dockify can warn about SSL/TLS modes that break a domain, and Account, Cloudflare Tunnel, Edit if this server runs behind a tunnel.
          </>
        }
      />
    </Dialog>
  );
}

function ZoneRow({ zone, busy, onToggle }: { zone: CloudflareZone; busy: boolean; onToggle: (next: boolean) => void }) {
  const id = `int-zone-${zone.id}`;
  return (
    <li className="soft-row int-row int-toggle" data-hover="true">
      <span className="two">
        <label htmlFor={id} className="two-main int-row-title">
          {zone.name}
        </label>
        <span className="two-sub">{zone.status === "pending" ? "Nameservers pending. " : ""}Manage DNS for domains in this zone</span>
      </span>
      <Switch id={id} checked={zone.managed} disabled={busy} onChange={onToggle} />
    </li>
  );
}

export function CloudflareCard({ value, onChange, now, preview }: { value: CloudflareIntegration | null; onChange: Setter<CloudflareIntegration | null>; now: number; preview: boolean }) {
  const { elevate } = useStepUp();
  const { open, setOpen, leaving, setLeaving, list: zones, setList: setZones, load, openManage } = useProviderCard<CloudflareZone>(value !== null, "/cloudflare/zones", (list) => onChange((v) => v && { ...v, zones: list.length, managed: list.filter((z) => z.managed).length }));

  // Two writes for one zone can land out of order, so a zone waits for its answer. A ref, read
  // synchronously: a second click can come before the state has rendered.
  const inFlight = useRef(new Set<string>());
  const [switching, setSwitching] = useState<ReadonlySet<string>>(() => new Set());
  const mark = (id: string, on: boolean) => {
    if (on) inFlight.current.add(id);
    else inFlight.current.delete(id);
    setSwitching(new Set(inFlight.current));
  };

  const flip = (id: string, managed: boolean) => {
    setZones((s) => (s.state === "ready" ? { ...s, list: s.list.map((z) => (z.id === id ? { ...z, managed } : z)) } : s));
    onChange((v) => v && { ...v, managed: Math.max(0, v.managed + (managed ? 1 : -1)) });
  };

  const toggle = async (zone: CloudflareZone, managed: boolean) => {
    if (inFlight.current.has(zone.id)) return;
    mark(zone.id, true);
    flip(zone.id, managed);
    const r = await elevate(() => intFetch<CloudflareZone>(`/cloudflare/zones/${encodeURIComponent(zone.id)}`, { method: "PATCH", body: { managed } }), { what: "Changing who manages this zone's DNS" });
    mark(zone.id, false);
    if (r.ok) {
      toast.success(managed ? "DNS managed by Dockify" : "DNS left to you", { description: describe(zone.name, { preview }) });
    } else {
      flip(zone.id, !managed);
      toast.error("Could not change the zone", { description: r.error });
    }
  };

  const disconnect = async () => {
    const r = await elevate(() => intFetch<{ ok: true }>("/cloudflare", { method: "DELETE" }), { what: "Disconnecting Cloudflare" });
    report(r, { success: "Cloudflare disconnected", error: "Could not disconnect Cloudflare", what: value?.account.name, preview });
    if (!r.ok) throw new Error(r.error);
    onChange(null);
    setZones({ state: "idle" });
    setOpen(false);
  };

  const status = !value ? "disconnected" : value.error ? "error" : "connected";

  return (
    <>
      <IntegrationCard
        id="int-cloudflare"
        icon="cloud"
        name="Cloudflare"
        purpose="Create DNS records and certificates automatically."
        status={status}
        meta={value ? (value.error ?? `${value.managed} of ${value.zones} ${value.zones === 1 ? "zone" : "zones"} managed`) : null}
      >
        <button type="button" className="btn btn-sm" onClick={openManage}>
          {value ? "Manage" : "Connect"}
        </button>
      </IntegrationCard>

      {open && !value ? (
        <ConnectForm
          preview={preview}
          onCancel={() => setOpen(false)}
          onDone={(v) => {
            onChange(v);
            void load();
          }}
        />
      ) : null}

      <ProviderDialog open={open && value !== null} onClose={() => setOpen(false)} onDisconnect={() => setLeaving(true)} title="Cloudflare" sub={value?.account.name} icon="cloud" error={value?.error}>
        {value ? (
          <>
            <Facts
              items={[
                { label: "Account", value: value.account.name },
                { label: "Token", value: <Hint hint={value.tokenHint} what="Cloudflare token" /> },
                { label: "Connected", value: <When iso={value.connectedAt} now={now} /> },
              ]}
            />
            <GroupHead label="Zones" icon="globe" count={zones.state === "ready" ? zones.list.length : undefined} noun="zone" />
            {zones.state === "error" ? (
              <Unavailable icon="globe" title="Zones are unavailable" error={zones.error} onRetry={() => void load()} />
            ) : zones.state !== "ready" ? (
              <SkelRows rows={4} height={56} template="minmax(0,1fr) 36px" cols={[{ w: "50%", lines: 2 }, 36]} label="Loading zones" />
            ) : !zones.list.length ? (
              <Empty icon="globe" title="No zones yet" body="This token cannot see any zone. Give it permission to edit DNS on the zones Dockify should manage." />
            ) : (
              <ul className="soft-list int-list">
                {zones.list.map((z) => (
                  <ZoneRow key={z.id} zone={z} busy={switching.has(z.id)} onToggle={(v) => void toggle(z, v)} />
                ))}
              </ul>
            )}
          </>
        ) : null}
      </ProviderDialog>

      {/* Connecting again undoes it, so the default key, with no glyph: nothing is deleted. */}
      <ConfirmDialog
        open={leaving}
        onClose={() => setLeaving(false)}
        title="Disconnect Cloudflare"
        body="Dockify forgets the token and stops managing DNS. Records it already created stay in Cloudflare."
        confirmLabel="Disconnect Cloudflare"
        onConfirm={disconnect}
      />
    </>
  );
}
