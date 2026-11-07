"use client";

import { useId, useRef, useState } from "react";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { StatusChip } from "@/components/ui/chip";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { EnvTag, envName } from "@/components/ui/env-tag";
import { Field, TextInput } from "@/components/ui/field";
import { BranchRef } from "@/components/ui/git-ref";
import { PendingButton } from "@/components/ui/pending";
import { Select } from "@/components/ui/select";
import { report } from "@/lib/feedback";
import { plural } from "@/lib/format";
import { githubRepo } from "@/lib/git-links";
import type { PreviewSettings, ProjectDetail } from "@/lib/pages/project-detail";
import { BRANCH_MESSAGE, BRANCH_NAME } from "@/lib/validation";
import { NO_ACCESS_TIP, useCan } from "@/lib/viewer";
import { send } from "./api";

/* Environments: one row per environment with the branch that deploys to it, its app count, an
   inline branch editor and remove. Production always stays; an environment with apps cannot be
   removed until they move or go. The preview row stands for pull request previews and links to
   their settings. Add environment can copy another environment's variables. A Viewer sees the
   table with its keys dimmed; their tips say why. */

const NAME_MAX = 32;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const branchError = (b: string) => (!b ? "Enter a branch" : !BRANCH_NAME.test(b) ? BRANCH_MESSAGE : null);

function nameError(n: string, taken: string[]) {
  if (!n) return "Enter a name";
  if (!NAME.test(n)) return `Use lowercase letters, numbers and hyphens, up to ${NAME_MAX} characters, starting with a letter`;
  if (n === "preview") return "Preview is kept for pull request previews";
  if (taken.includes(n)) return `${envName(n)} already exists`;
  return null;
}

function EnvRow({ p, name, branch, onSaved, onRemove }: { p: ProjectDetail; name: string; branch: string; onSaved: (branch: string) => void; onRemove: () => void }) {
  const can = useCan();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(branch);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const reasonId = useId();
  const apps = p.apps.filter((a) => a.environment === name).length;
  const err = branchError(value.trim());
  const prod = name === "production";
  const label = envName(name);

  const save = async () => {
    setTried(true);
    if (err || busy) return;
    const next = value.trim();
    if (next === branch) return setEditing(false);
    setBusy(true);
    const r = report(await send({ type: "environment.branch", slug: p.slug, name, branch: next }), {
      success: "Branch saved",
      error: "Could not save the branch",
      what: `${p.slug} / ${label} now deploys from ${next}`,
    });
    setBusy(false);
    if (!r.ok) return;
    onSaved(next);
    setEditing(false);
  };

  // Why the remove key cannot be used: said in its tip, and read with its name.
  const blocked = !can.manage ? NO_ACCESS_TIP : prod ? "Production cannot be removed" : apps ? `Move or delete its ${plural(apps, "app")} first` : null;

  return (
    <li className="px-env-row">
      <span className="px-env-name">
        <EnvTag env={name} />
      </span>
      <span className="px-env-branch">
        {editing ? (
          <span
            className="px-env-edit"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setEditing(false);
              } else if (e.key === "Enter") {
                e.preventDefault();
                void save();
              }
            }}
          >
            <span className="pd-lead-field">
              <Icon name="branch" size={14} />
              <TextInput
                aria-label={`${label} branch`}
                data-size="sm"
                value={value}
                autoFocus
                spellCheck={false}
                invalid={tried && Boolean(err)}
                onChange={(e) => setValue(e.target.value)}
              />
            </span>
            {tried && err ? (
              <span className="px-env-err" role="alert">
                {err}
              </span>
            ) : null}
          </span>
        ) : (
          <BranchRef repo={githubRepo(p.repo?.url)} branch={branch} iconSize={14} className="px-env-ref" />
        )}
      </span>
      <span className="px-env-apps num">{apps ? plural(apps, "app") : <span className="none">No apps</span>}</span>
      <span className="px-env-acts">
        {editing ? (
          <>
            <PendingButton className="btn btn-xs btn-icon btn-primary" aria-label="Save branch" data-tip="Save, Enter" pending={busy} icon="check" onClick={() => void save()} />
            <button type="button" className="btn btn-xs btn-icon" aria-label="Cancel" data-tip="Cancel, Esc" data-tip-align="end" disabled={busy} onClick={() => setEditing(false)}>
              <Icon name="close" />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-xs btn-icon"
              aria-label={`Edit the ${label} branch`}
              aria-disabled={!can.manage || undefined}
              data-tip={can.manage ? undefined : NO_ACCESS_TIP}
              onClick={
                can.manage
                  ? () => {
                      setValue(branch);
                      setTried(false);
                      setEditing(true);
                    }
                  : undefined
              }
            >
              <Icon name="edit" />
            </button>
            {/* Focusable even when it cannot be used, so its tip says why to the keyboard too. */}
            <button
              type="button"
              className="btn btn-xs btn-icon btn-quiet-danger"
              aria-label={`Remove ${label}`}
              aria-disabled={blocked ? true : undefined}
              aria-describedby={blocked ? reasonId : undefined}
              data-tip={blocked ?? undefined}
              data-tip-align="end"
              onClick={blocked ? undefined : onRemove}
            >
              <Icon name="trash" />
            </button>
            {blocked ? (
              <span id={reasonId} className="sr">
                {blocked}
              </span>
            ) : null}
          </>
        )}
      </span>
    </li>
  );
}

export function EnvironmentsCard({
  p,
  previews,
  onChange,
  onOpenPreviews,
}: {
  p: ProjectDetail;
  /** Null while loading or when the API did not answer; the preview row then reads Unknown. */
  previews: PreviewSettings | null;
  onChange: (next: ProjectDetail) => void;
  onOpenPreviews: () => void;
}) {
  const can = useCan();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", branch: "", copyFrom: "none" });
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  /** The removed row's place, so the focus lands on the row that takes it. */
  const removedAt = useRef(0);
  const taken = p.environments.map((e) => e.name);
  const nameErr = nameError(form.name.trim(), taken);
  const branchErr = branchError(form.branch.trim());

  const open = () => {
    setForm({ name: "", branch: "", copyFrom: "none" });
    setTried(false);
    setAdding(true);
  };

  const add = async () => {
    setTried(true);
    if (nameErr || branchErr || busy) return;
    const name = form.name.trim();
    const branch = form.branch.trim();
    setBusy(true);
    const r = report(await send({ type: "environment.add", slug: p.slug, name, branch, copyFrom: form.copyFrom === "none" ? undefined : form.copyFrom }), {
      success: "Environment added",
      error: "Could not add the environment",
      what: `${p.slug} / ${envName(name)} from ${branch}${form.copyFrom === "none" ? "" : `, variables copied from ${envName(form.copyFrom)}`}`,
    });
    setBusy(false);
    if (!r.ok) return;
    onChange({ ...p, environments: [...p.environments, { name, branch }] });
    setAdding(false);
  };

  const remove = async (name: string) => {
    const r = report(await send({ type: "environment.remove", slug: p.slug, name, confirm: name }), {
      success: "Environment removed",
      error: "Could not remove the environment",
      what: `${p.slug} / ${envName(name)} and its variables`,
    });
    if (!r.ok) throw new Error(r.error);
    onChange({ ...p, environments: p.environments.filter((e) => e.name !== name) });
  };

  /** After a removal: the first key of the row now in the removed one's place (the next environment, or the preview row). */
  const afterRemove = () => {
    const rows = list.current?.querySelectorAll<HTMLElement>(":scope > li");
    const row = rows?.length ? rows[Math.min(removedAt.current, rows.length - 1)] : undefined;
    return row?.querySelector<HTMLElement>("button, a[href]") ?? document.getElementById("px-envs-title");
  };

  const prState = previews === null ? { tone: "idle" as const, label: "Unknown" } : previews.enabled ? { tone: "ok" as const, label: "On" } : { tone: "idle" as const, label: "Off" };

  return (
    <section className="card" aria-labelledby="px-envs-title">
      <div className="card-hd">
        <CardTitle id="px-envs-title" icon="layers" title="Environments" sub="Each one gets its own variables, domains and isolated network" />
        {can.manage ? (
          <button type="button" className="btn btn-sm" onClick={open}>
            Add environment
          </button>
        ) : null}
      </div>
      <div className="px-envs-wrap">
        <div className="px-env-row px-env-head" aria-hidden="true">
          <span>Environment</span>
          <span>Branch</span>
          <span>Apps</span>
          <span />
        </div>
        <ul ref={list} className="px-envs" aria-label="Environments">
          {p.environments.map((e, i) => (
            <EnvRow
              key={e.name}
              p={p}
              name={e.name}
              branch={e.branch}
              onSaved={(branch) => onChange({ ...p, environments: p.environments.map((x) => (x.name === e.name ? { ...x, branch } : x)) })}
              onRemove={() => {
                removedAt.current = i;
                setRemoving(e.name);
              }}
            />
          ))}
          <li className="px-env-row" data-kind="preview">
            <span className="px-env-name">
              <EnvTag env="preview" />
            </span>
            <span className="px-env-branch">
              <span className="px-env-ref">
                <Icon name="merge" size={14} />
                <span className="ellipsis">Pull requests to {p.defaultBranch}</span>
              </span>
            </span>
            <span className="px-env-apps">
              <StatusChip tone={prState.tone}>{prState.label}</StatusChip>
            </span>
            <span className="px-env-acts">
              <button type="button" className="btn btn-xs" onClick={onOpenPreviews}>
                Configure
              </button>
            </span>
          </li>
        </ul>
      </div>

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        icon="layers"
        title="Add environment"
        sub={`Gives ${p.slug} a separate set of variables, domains and an isolated network, deployed from its own branch.`}
        busy={busy}
        onSubmit={() => void add()}
        footer={
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </button>
            <PendingButton type="submit" className="btn btn-primary" pending={busy} icon="plus">
              Add environment
            </PendingButton>
          </>
        }
      >
        <div className="px-form">
          <Field label="Name" hint="Used in hostnames and logs, for example staging." error={tried ? nameErr : null}>
            {(ids) => (
              <TextInput
                ids={ids}
                value={form.name}
                data-autofocus
                spellCheck={false}
                maxLength={NAME_MAX}
                placeholder="staging"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value.toLowerCase().replace(/\s/g, "-") }))}
              />
            )}
          </Field>
          <Field label="Branch" hint="A push to this branch deploys every app in the environment." error={tried ? branchErr : null}>
            {(ids) => (
              <span className="pd-lead-field">
                <Icon name="branch" size={14} />
                <TextInput ids={ids} value={form.branch} spellCheck={false} placeholder="staging" onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value }))} />
              </span>
            )}
          </Field>
          <Field label="Copy variables from" hint="Secrets are copied on the server; they never pass through the browser.">
            {(ids) => (
              <Select
                ids={ids}
                label="Copy variables from"
                value={form.copyFrom}
                options={[{ value: "none", label: "Start empty" }, ...p.environments.map((e) => ({ value: e.name, label: envName(e.name) }))]}
                onChange={(copyFrom) => setForm((f) => ({ ...f, copyFrom }))}
              />
            )}
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        tone="danger"
        title={`Remove ${removing ? envName(removing) : "environment"}`}
        body={`Deletes ${removing ? envName(removing) : "it"} from ${p.slug} with all of its variables and overrides. Its branch stops deploying.`}
        confirmLabel="Remove environment"
        confirmIcon="trash"
        confirmText={removing ?? undefined}
        onConfirm={() => (removing ? remove(removing) : undefined)}
        returnFocus={afterRemove}
      />
    </section>
  );
}
