"use client";

import { useState } from "react";
import { Empty } from "@/components/ui/empty";
import { Chip } from "@/components/ui/chip";
import { Dialog } from "@/components/ui/dialog";
import { Field, TextInput } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { report } from "@/lib/feedback";
import type { Registry, RegistryInput, RegistryKind } from "@/lib/pages/integrations";
import { FormKeys, Hint, IntegrationCard, ItemRow, ListDialog, RemoveDialog, useCrudCard } from "./card";
import { intFetch, listing, upsert, type Setter } from "./client";
import { plural } from "@/lib/format";
import { useStepUp } from "@/components/step-up/step-up";

/* Credentials Dockify logs in with before it pulls a private image. */

const KINDS: Record<RegistryKind, { label: string; host: string | null; user: string; token: string }> = {
  ghcr: { label: "GitHub Container Registry", host: "ghcr.io", user: "Your GitHub user or organization.", token: "A classic token with the read:packages scope." },
  dockerhub: { label: "Docker Hub", host: "docker.io", user: "Your Docker Hub username.", token: "A personal access token with read access, from Account settings." },
  custom: { label: "Custom registry", host: null, user: "The registry login.", token: "The password or token for that login." },
};

const SHORT: Record<RegistryKind, string> = { ghcr: "GHCR", dockerhub: "Docker Hub", custom: "Custom" };

type Draft = { kind: RegistryKind; host: string; username: string; token: string };

const blank: Draft = { kind: "ghcr", host: "", username: "", token: "" };

function RegistryForm({ editing, onSaved, onBack, preview }: { editing: Registry | null; onSaved: (r: Registry) => void; onBack: () => void; preview: boolean }) {
  const { elevate } = useStepUp();
  const [draft, setDraft] = useState<Draft>(editing ? { kind: editing.kind, host: editing.kind === "custom" ? editing.host : "", username: editing.username, token: "" } : blank);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const k = KINDS[draft.kind];
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const errors = {
    host: draft.kind === "custom" && !/^[a-z0-9.-]+\.[a-z]{2,}(:\d{1,5})?$/i.test(draft.host.trim()) ? "Enter the host, like registry.example.com" : null,
    username: draft.username.trim() ? null : "Enter the username",
    token: !editing && !draft.token.trim() ? "Paste the token" : null,
  };
  const valid = Object.values(errors).every((e) => !e);
  const shown = (e: string | null) => (tried ? e : null);

  const submit = async () => {
    setTried(true);
    if (!valid || busy) return;
    setBusy(true);
    const body: RegistryInput = { kind: draft.kind, host: draft.kind === "custom" ? draft.host.trim() : undefined, username: draft.username.trim(), token: draft.token.trim() || undefined };
    const r = editing
      ? await elevate(() => intFetch<Registry>(`/registries/${encodeURIComponent(editing.id)}`, { method: "PATCH", body }), { what: "Changing a registry login" })
      : await elevate(() => intFetch<Registry>("/registries", { method: "POST", body }), { what: "Adding a registry" });
    setBusy(false);
    report(r, { success: editing ? "Registry saved" : "Registry added", error: editing ? "Could not save the registry" : "Could not add the registry", what: r.ok ? `${r.data.host}, ${r.data.username}` : undefined, preview });
    if (r.ok) onSaved(editing ? { ...r.data, tokenHint: r.data.tokenHint || editing.tokenHint, addedAt: editing.addedAt } : r.data);
  };

  return (
    <Dialog
      open
      onClose={onBack}
      title={editing ? "Edit registry" : "Add registry"}
      sub={editing ? editing.host : "Pull private images"}
      icon="box"
      busy={busy}
      onSubmit={() => void submit()}
      footer={
        <FormKeys onCancel={onBack} busy={busy} icon={editing ? "check" : "plus"}>
          {editing ? "Save" : "Add registry"}
        </FormKeys>
      }
    >
      <Field label="Registry">
        {(ids) => (
          <Select
            ids={ids}
            label="Registry"
            value={draft.kind}
            onChange={(kind) => set({ kind })}
            options={(Object.keys(KINDS) as RegistryKind[]).map((id) => ({ value: id, label: KINDS[id].label, hint: KINDS[id].host ?? undefined }))}
            disabled={editing !== null}
          />
        )}
      </Field>
      {draft.kind === "custom" ? (
        <Field label="Host" hint="Without https://. Add the port when it is not 443." error={shown(errors.host)}>
          {(ids) => <TextInput ids={ids} spellCheck={false} autoCapitalize="off" placeholder="registry.example.com" value={draft.host} onChange={(e) => set({ host: e.target.value })} />}
        </Field>
      ) : null}
      <div className="int-form-grid">
        <Field label="Username" hint={k.user} error={shown(errors.username)}>
          {(ids) => <TextInput ids={ids} spellCheck={false} autoCapitalize="off" autoComplete="off" value={draft.username} onChange={(e) => set({ username: e.target.value })} data-autofocus />}
        </Field>
        <Field label="Token" hint={editing ? `Leave empty to keep the token ending ${editing.tokenHint}. A new host or username needs it again.` : k.token} error={shown(errors.token)}>
          {(ids) => <TextInput ids={ids} type="password" autoComplete="off" spellCheck={false} value={draft.token} onChange={(e) => set({ token: e.target.value })} />}
        </Field>
      </div>
    </Dialog>
  );
}

export function RegistriesCard({ value, onChange, preview }: { value: Registry[]; onChange: Setter<Registry[]>; preview: boolean }) {
  const { elevate } = useStepUp();
  const card = useCrudCard<Registry>(value.length > 0);

  const remove = async (reg: Registry) => {
    const r = await elevate(() => intFetch<{ ok: true }>(`/registries/${encodeURIComponent(reg.id)}`, { method: "DELETE" }), { what: "Removing a registry" });
    report(r, { success: "Registry removed", error: "Could not remove the registry", what: reg.host, preview });
    if (!r.ok) throw new Error(r.error);
    onChange((list) => list.filter((x) => x.id !== reg.id));
  };

  const status = !value.length ? "disconnected" : value.some((r) => r.error) ? "error" : "connected";
  const failing = value.find((r) => r.error);

  return (
    <>
      <IntegrationCard
        id="int-registries"
        icon="box"
        name="Container registries"
        purpose="Pull private images."
        status={status}
        meta={failing ? `${failing.host}: ${failing.error}` : value.length ? listing([...new Set(value.map((r) => (r.kind === "custom" ? r.host : SHORT[r.kind])))]) : null}
      >
        <button type="button" className="btn btn-sm" onClick={card.start}>
          {value.length ? "Manage" : "Connect"}
        </button>
      </IntegrationCard>

      <ListDialog open={card.listOpen} onClose={card.close} onAdd={card.add} addLabel="Add registry" title="Container registries" sub={value.length ? plural(value.length, "registry", "registries") : "Pull private images"} icon="box">
        {!value.length ? (
          <Empty icon="box" title="No registries yet" body="Public images pull without one. Add a registry to pull private images from GHCR, Docker Hub or your own." />
        ) : (
          <ul className="soft-list int-list">
            {value.map((r) => (
              <ItemRow
                key={r.id}
                icon="box"
                title={
                  <>
                    <span className="ellipsis" title={r.host}>
                      {r.host}
                    </span>
                    <Chip size="xs" tone={r.error ? "bad" : undefined}>
                      {r.error ? "Error" : SHORT[r.kind]}
                    </Chip>
                  </>
                }
                sub={
                  <span className="int-sub-line">
                    {r.error ? <span className="tone-bad">{r.error}</span> : <span>{r.username}</span>}
                    <Hint hint={r.tokenHint} what={`${r.host} token`} />
                  </span>
                }
              >
                <button type="button" className="btn btn-xs" aria-label={`Edit ${r.host}`} onClick={() => card.edit(r)}>
                  Edit
                </button>
                <button type="button" className="btn btn-xs" aria-label={`Remove ${r.host}`} onClick={() => card.setRemoving(r)}>
                  Remove
                </button>
              </ItemRow>
            ))}
          </ul>
        )}
      </ListDialog>

      {card.form ? (
        <RegistryForm
          key={card.form.editing?.id ?? "new"}
          editing={card.form.editing}
          preview={preview}
          onBack={card.back}
          onSaved={(saved) => {
            onChange((list) => upsert(list, saved));
            card.toList();
          }}
        />
      ) : null}

      {/* Adding the login again undoes it, so no typed name: that guard is for losing data. */}
      <RemoveDialog
        row={card.removing}
        onClose={() => card.setRemoving(null)}
        title="Remove registry"
        body={card.removing ? `Dockify forgets the login for ${card.removing.host}. Apps that pull private images from it fail their next deploy until it is added again.` : undefined}
        label="Remove registry"
        onRemove={remove}
      />
    </>
  );
}
