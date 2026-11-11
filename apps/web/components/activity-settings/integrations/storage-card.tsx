"use client";

import { useState } from "react";
import { Empty } from "@/components/ui/empty";
import { Chip } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";
import { Field, TextInput } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { When } from "@/components/ui/when";
import { describe, errText, report } from "@/lib/feedback";
import type { StorageDestination, StorageInput, StorageProvider } from "@/lib/pages/integrations";
import { FormKeys, Hint, IntegrationCard, ItemRow, ListDialog, RemoveDialog, useCrudCard } from "./card";
import { intFetch, intOrThrow, upsert, type Setter } from "./client";
import { plural } from "@/lib/format";
import { useStepUp } from "@/components/step-up/step-up";

/* S3-compatible buckets that database backups upload to. A test writes, reads and deletes a small object. */

const PROVIDERS: Record<StorageProvider, { label: string; endpoint: string; region: string }> = {
  r2: { label: "Cloudflare R2", endpoint: "https://<account id>.r2.cloudflarestorage.com", region: "auto" },
  s3: { label: "AWS S3", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1" },
  minio: { label: "MinIO", endpoint: "https://minio.example.com", region: "us-east-1" },
  custom: { label: "S3-compatible", endpoint: "https://s3.example.com", region: "us-east-1" },
};

type Draft = { name: string; provider: StorageProvider; endpoint: string; bucket: string; region: string; accessKey: string; secretKey: string; isDefault: boolean };

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function StorageForm({ editing, first, onSaved, onBack, preview }: { editing: StorageDestination | null; first: boolean; onSaved: (d: StorageDestination) => void; onBack: () => void; preview: boolean }) {
  const { elevate } = useStepUp();
  const [draft, setDraft] = useState<Draft>(
    editing
      ? { name: editing.name, provider: editing.provider, endpoint: editing.endpoint, bucket: editing.bucket, region: editing.region, accessKey: "", secretKey: "", isDefault: editing.isDefault }
      : { name: PROVIDERS.r2.label, provider: "r2", endpoint: "", bucket: "", region: PROVIDERS.r2.region, accessKey: "", secretKey: "", isDefault: first },
  );
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const p = PROVIDERS[draft.provider];
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  // A provider switch carries its own defaults, unless the operator already typed their own.
  const pickProvider = (provider: StorageProvider) =>
    setDraft((d) => {
      const was = PROVIDERS[d.provider];
      return {
        ...d,
        provider,
        name: !d.name.trim() || d.name === was.label ? PROVIDERS[provider].label : d.name,
        region: !d.region.trim() || d.region === was.region ? PROVIDERS[provider].region : d.region,
      };
    });

  const errors = {
    name: draft.name.trim() ? null : "Give the destination a name",
    endpoint: /^https?:\/\/[^\s/<>]+\/?$/.test(draft.endpoint.trim()) ? null : "Enter the endpoint as a URL",
    bucket: /^[a-z0-9][a-z0-9.-]{1,62}$/.test(draft.bucket.trim()) ? null : "Use the bucket name, in lowercase",
    region: /^[\w-]{1,40}$/.test(draft.region.trim()) ? null : "Enter the region, or auto",
    accessKey: !editing && !draft.accessKey.trim() ? "Paste the access key" : null,
    secretKey: !editing && !draft.secretKey.trim() ? "Paste the secret key" : null,
  };
  const valid = Object.values(errors).every((e) => !e);
  const shown = (e: string | null) => (tried ? e : null);

  const submit = async () => {
    setTried(true);
    if (!valid || busy) return;
    setBusy(true);
    const body: StorageInput = {
      name: draft.name.trim(),
      provider: draft.provider,
      endpoint: draft.endpoint.trim(),
      bucket: draft.bucket.trim(),
      region: draft.region.trim(),
      accessKey: draft.accessKey.trim() || undefined,
      secretKey: draft.secretKey.trim() || undefined,
      isDefault: draft.isDefault,
    };
    const r = editing
      ? await elevate(() => intFetch<StorageDestination>(`/storage/${encodeURIComponent(editing.id)}`, { method: "PATCH", body }), { what: "Changing a backup destination" })
      : await elevate(() => intFetch<StorageDestination>("/storage", { method: "POST", body }), { what: "Adding a backup destination" });
    setBusy(false);
    report(r, {
      success: editing ? "Destination saved" : "Destination added",
      error: editing ? "Could not save the destination" : "Could not add the destination",
      what: r.ok ? `${r.data.name}, ${r.data.bucket}` : undefined,
      preview,
    });
    if (r.ok)
      onSaved(editing ? { ...r.data, accessKeyHint: r.data.accessKeyHint || editing.accessKeyHint, secretKeyHint: r.data.secretKeyHint || editing.secretKeyHint } : r.data);
  };

  const keep = (hint: string) => `Leave empty to keep the key ending ${hint}. A new endpoint needs both keys again.`;

  return (
    <Dialog
      open
      onClose={onBack}
      title={editing ? "Edit destination" : "Add destination"}
      sub={editing ? editing.name : "Where backups are stored"}
      icon="archive"
      size="lg"
      busy={busy}
      onSubmit={() => void submit()}
      footer={
        <FormKeys onCancel={onBack} busy={busy} icon={editing ? "check" : "plus"}>
          {editing ? "Save" : "Add destination"}
        </FormKeys>
      }
    >
      <div className="int-form-grid">
        <Field label="Provider">
          {(ids) => (
            <Select
              ids={ids}
              label="Provider"
              value={draft.provider}
              onChange={pickProvider}
              options={(Object.keys(PROVIDERS) as StorageProvider[]).map((id) => ({ value: id, label: PROVIDERS[id].label }))}
            />
          )}
        </Field>
        <Field label="Name" hint="How backups and schedules refer to it." error={shown(errors.name)}>
          {(ids) => <TextInput ids={ids} maxLength={60} value={draft.name} onChange={(e) => set({ name: e.target.value })} />}
        </Field>
      </div>
      <Field label="Endpoint" hint={draft.provider === "r2" ? "From the R2 overview, under S3 API." : "The S3 API URL, without the bucket."} error={shown(errors.endpoint)}>
        {(ids) => <TextInput ids={ids} type="url" inputMode="url" spellCheck={false} placeholder={p.endpoint} value={draft.endpoint} onChange={(e) => set({ endpoint: e.target.value })} data-autofocus />}
      </Field>
      <div className="int-form-grid">
        <Field label="Bucket" error={shown(errors.bucket)}>
          {(ids) => <TextInput ids={ids} spellCheck={false} autoCapitalize="off" placeholder="dockify-backups" value={draft.bucket} onChange={(e) => set({ bucket: e.target.value })} />}
        </Field>
        <Field label="Region" hint={draft.provider === "r2" ? "R2 uses auto." : undefined} error={shown(errors.region)}>
          {(ids) => <TextInput ids={ids} spellCheck={false} autoCapitalize="off" placeholder={p.region} value={draft.region} onChange={(e) => set({ region: e.target.value })} />}
        </Field>
        <Field label="Access key" hint={editing ? keep(editing.accessKeyHint) : undefined} error={shown(errors.accessKey)}>
          {(ids) => <TextInput ids={ids} type="password" autoComplete="off" spellCheck={false} value={draft.accessKey} onChange={(e) => set({ accessKey: e.target.value })} />}
        </Field>
        <Field label="Secret key" hint={editing ? keep(editing.secretKeyHint) : undefined} error={shown(errors.secretKey)}>
          {(ids) => <TextInput ids={ids} type="password" autoComplete="off" spellCheck={false} value={draft.secretKey} onChange={(e) => set({ secretKey: e.target.value })} />}
        </Field>
      </div>
      <div className="int-switch-row">
        <span className="two">
          <label htmlFor="int-storage-default" className="two-main">
            Default destination
          </label>
          <span className="two-sub">New backup schedules upload here.</span>
        </span>
        <Switch id="int-storage-default" checked={draft.isDefault} onChange={(v) => set({ isDefault: v })} disabled={editing?.isDefault === true} />
      </div>
    </Dialog>
  );
}

export function StorageCard({ value, onChange, now, preview }: { value: StorageDestination[]; onChange: Setter<StorageDestination[]>; now: number; preview: boolean }) {
  const { elevate } = useStepUp();
  const card = useCrudCard<StorageDestination>(value.length > 0);
  const [testing, setTesting] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);

  // Saving one as the default clears the flag everywhere else, as the API does.
  const put = (d: StorageDestination) =>
    onChange((list) => {
      const next = upsert(list, d);
      return d.isDefault ? next.map((x) => (x.id === d.id ? x : { ...x, isDefault: false })) : next;
    });

  const test = async (d: StorageDestination) => {
    if (testing) return;
    setTesting(d.id);
    try {
      await toast.promise(intOrThrow(intFetch<{ latencyMs: number }>(`/storage/${encodeURIComponent(d.id)}/test`, { method: "POST" })), {
        loading: "Testing connection",
        description: `${d.name}, ${d.bucket}`,
        success: (r) => ({ title: "Connection works", description: describe([`${d.name}, ${d.bucket}`, `Answered in ${r.latencyMs.toLocaleString("en-US")} ms`], { preview }) }),
        error: (e) => ({ title: "Connection failed", description: describe([`${d.name}, ${d.bucket}`, errText(e)]) }),
      });
      onChange((list) => list.map((x) => (x.id === d.id ? { ...x, lastTestedAt: new Date().toISOString(), error: null } : x)));
    } catch {
      // The toast carries the failure.
    } finally {
      setTesting(null);
    }
  };

  const makeDefault = async (d: StorageDestination) => {
    if (moving) return;
    setMoving(d.id);
    const r = await elevate(() => intFetch<unknown>(`/storage/${encodeURIComponent(d.id)}`, { method: "PATCH", body: { isDefault: true } }), { what: "Changing the default destination" });
    setMoving(null);
    report(r, { success: "Default destination changed", error: "Could not change the default", what: `New schedules upload to ${d.name}`, preview });
    if (r.ok) put({ ...d, isDefault: true });
  };

  const remove = async (d: StorageDestination) => {
    const r = await elevate(() => intFetch<{ ok: true }>(`/storage/${encodeURIComponent(d.id)}`, { method: "DELETE" }), { what: "Removing a backup destination" });
    report(r, { success: "Destination removed", error: "Could not remove the destination", what: d.name, preview });
    if (!r.ok) throw new Error(r.error);
    onChange((list) => list.filter((x) => x.id !== d.id));
  };

  const status = !value.length ? "disconnected" : value.some((d) => d.error) ? "error" : "connected";
  const def = value.find((d) => d.isDefault);
  const failing = value.find((d) => d.error);

  return (
    <>
      <IntegrationCard
        id="int-storage"
        icon="archive"
        name="Backup storage"
        purpose="Where backups are stored."
        status={status}
        meta={failing ? `${failing.name}: ${failing.error}` : def ? `${def.name}, ${def.bucket}` : value.length ? plural(value.length, "destination") : null}
      >
        <button type="button" className="btn btn-sm" onClick={card.start}>
          {value.length ? "Manage" : "Connect"}
        </button>
      </IntegrationCard>

      <ListDialog open={card.listOpen} onClose={card.close} onAdd={card.add} addLabel="Add destination" title="Backup storage" sub={value.length ? plural(value.length, "destination") : "Where backups are stored"} icon="archive">
        {!value.length ? (
          <Empty icon="archive" title="No destinations yet" body="Backups stay on this server until you add an S3-compatible bucket, such as Cloudflare R2." />
        ) : (
          <ul className="soft-list int-list">
            {value.map((d) => (
              <ItemRow
                key={d.id}
                icon="archive"
                title={
                  <>
                    <span className="ellipsis" title={d.name}>
                      {d.name}
                    </span>
                    {d.isDefault ? <Chip size="xs">Default</Chip> : null}
                    {d.error ? (
                      <Chip size="xs" tone="bad">
                        Error
                      </Chip>
                    ) : null}
                  </>
                }
                sub={
                  <span className="int-sub-line">
                    <span className="int-wrap">
                      {d.bucket}, {hostOf(d.endpoint)}
                    </span>
                    {d.error ? <span className="tone-bad">{d.error}</span> : <When iso={d.lastTestedAt} now={now} prefix="Tested" fallback="Never tested" />}
                    <Hint hint={d.secretKeyHint} what={`${d.name} secret key`} />
                  </span>
                }
              >
                <PendingButton className="btn btn-xs" aria-label={`Test connection to ${d.name}`} onClick={() => void test(d)} pending={testing === d.id} disabled={testing !== null && testing !== d.id}>
                  Test connection
                </PendingButton>
                {d.isDefault ? null : (
                  <PendingButton className="btn btn-xs" aria-label={`Make default: ${d.name}`} onClick={() => void makeDefault(d)} pending={moving === d.id} disabled={moving !== null && moving !== d.id}>
                    Make default
                  </PendingButton>
                )}
                <button type="button" className="btn btn-xs" aria-label={`Edit ${d.name}`} onClick={() => card.edit(d)}>
                  Edit
                </button>
                <button type="button" className="btn btn-xs" aria-label={`Remove ${d.name}`} onClick={() => card.setRemoving(d)}>
                  Remove
                </button>
              </ItemRow>
            ))}
          </ul>
        )}
      </ListDialog>

      {card.form ? (
        <StorageForm
          key={card.form.editing?.id ?? "new"}
          editing={card.form.editing}
          first={!value.length}
          preview={preview}
          onBack={card.back}
          onSaved={(d) => {
            put(d);
            card.toList();
          }}
        />
      ) : null}

      {/* The backups stay in the bucket and adding it again undoes this, so no typed name. */}
      <RemoveDialog
        row={card.removing}
        onClose={() => card.setRemoving(null)}
        title="Remove destination"
        body={
          card.removing
            ? `Dockify stops uploading to ${card.removing.bucket}. Backups already there stay in the bucket.${card.removing.isDefault && value.length > 1 ? " Pick another default afterwards." : ""}`
            : undefined
        }
        label="Remove destination"
        onRemove={remove}
      />
    </>
  );
}
