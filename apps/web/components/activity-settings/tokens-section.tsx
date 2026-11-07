"use client";

import { useState } from "react";
import { createToken, revokeToken } from "@/app/(console)/settings/actions";
import { Icon } from "@/components/icon";
import { RowMenu } from "@/components/project-extras/row-menu";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/chip";
import { CopyBox } from "@/components/ui/copy-box";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { Field, TextInput } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { When } from "@/components/ui/when";
import { describe, report } from "@/lib/feedback";
import { useTimeFormat } from "@/lib/time-prefs";
import type { ApiToken, TokenGrant, TokenScope } from "@/lib/pages/activity-settings";
import { Group, settle, Until } from "./form";
import type { SectionProps } from "./settings-view";
import type { Elevate } from "@/components/step-up/step-up";
import { displayNameProblem } from "@/lib/validation";

const SCOPES: Array<{ id: TokenScope; label: string; hint: string }> = [
  { id: "read", label: "Read-only", hint: "Reads projects, apps, deployments and logs. Changes nothing." },
  { id: "deploy", label: "Deploy", hint: "Read, plus start, redeploy and roll back deployments. Right for CI." },
  { id: "admin", label: "Admin", hint: "Everything you can do, including variables, domains and the team." },
];
const SCOPE_LABEL = Object.fromEntries(SCOPES.map((s) => [s.id, s.label])) as Record<TokenScope, string>;

const EXPIRY: Array<{ value: string; label: string }> = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
];

/** This dashboard's own origin, for the example request. */
const origin = () => (typeof window === "undefined" ? "" : window.location.origin);

type Reach = "" | "all" | "selected";
// Nothing is picked at first, so the Select shows its grey placeholder instead of a fake value.
const REACH: Array<{ value: Exclude<Reach, "">; label: string }> = [
  { value: "all", label: "All projects" },
  { value: "selected", label: "Selected projects" },
];
const REACH_HINT: Record<Reach, string> = {
  "": "A token reaches only the projects you choose here. There is no default.",
  all: "Every project on this server, including ones created later.",
  selected: "The token cannot see any other project.",
};
const parseSlugs = (text: string): string[] => [
  ...new Set(
    text
      .toLowerCase()
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

/** The named projects for a row: up to three by name, then a count. */
function projectsLabel(t: ApiToken): string {
  const list = t.projects ?? [];
  if (list.length === 0) return "No projects";
  return list.length <= 3 ? list.join(", ") : `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`;
}

const WEEK_MS = 7 * 86_400_000;

/**
 * One token as a 56px table row: the name over a mono chip of the stored prefix plus one fixed
 * ellipsis (never a dot per hidden character) and its created time; the scope chip (Admin a touch
 * stronger) and any grant over the projects it reaches; last use over expiry, warn under 7 days;
 * then the more key with Revoke, the same as Team. Narrow columns stack it.
 */
function TokenRow({ t, now, onRevoke }: { t: ApiToken; now: number; onRevoke: () => void }) {
  const left = t.expiresAt === null ? Infinity : Date.parse(t.expiresAt) - now;
  const expired = left <= 0;
  const soon = !expired && left < WEEK_MS;
  return (
    <li className="set-tk-row">
      <span className="two set-tk-main">
        <span className="two-main set-tm-title">
          <span className="set-tk-name">
            {t.name}
          </span>
          {expired ? (
            <Chip size="xs" tone="bad">
              Expired
            </Chip>
          ) : null}
        </span>
        <span className="two-sub set-tm-sub">
          <code className="set-tk-prefix">
            <span className="sr">Token starting </span>
            {t.prefix}
            {"…"}
          </code>
          <When iso={t.createdAt} now={now} prefix="Created" className="set-keep" />
        </span>
      </span>
      <span className="two set-tk-acc">
        <span className="two-main set-tk-chips">
          <Chip size="xs" className={t.scope === "admin" ? "set-tk-admin" : undefined} icon={t.scope === "admin" ? <Icon name="shield" size={12} /> : undefined}>
            {SCOPE_LABEL[t.scope]}
          </Chip>
          {t.grants?.map((g) => (
            <Chip key={g} size="xs" tip="Can change plain variables through the API">
              {g}
            </Chip>
          ))}
        </span>
        <span className="two-sub set-tk-reach">
          {t.allProjects ? (
            <>
              <Icon name="globe" size={14} />
              All projects
            </>
          ) : (
            projectsLabel(t)
          )}
        </span>
      </span>
      <span className="two set-tk-use">
        <span className="set-tk-used">
          <When iso={t.lastUsedAt} now={now} prefix="Used" fallback="Never used" tipAlign="end" />
        </span>
        <span className="two-sub">
          {t.expiresAt ? (
            <Until iso={t.expiresAt} now={now} prefix="Expires" tipAlign="end" className={expired ? "tone-bad" : soon ? "tone-warn" : undefined} />
          ) : (
            "Never expires"
          )}
        </span>
      </span>
      <span className="set-tm-end">
        <RowMenu label={`More for ${t.name}`} items={[{ label: "Revoke token", icon: "trash", bad: true, onSelect: onRevoke }]} />
      </span>
    </li>
  );
}

/**
 * The new token form, then its one-time secret. Mounted only while open: the secret is shown once
 * and must not stay in memory after Done. `projects` lists this instance's project names, picked
 * with checkboxes; without them (the list did not load) the names are typed, comma-separated.
 */
function CreateDialog({
  onClose,
  onCreated,
  preview,
  elevate,
  projects,
  admin,
}: {
  onClose: () => void;
  onCreated: (t: ApiToken) => void;
  preview: boolean;
  elevate: Elevate;
  projects: string[];
  /** A Viewer may mint read tokens only (the API refuses the rest), so only Read-only is offered. */
  admin: boolean;
}) {
  const time = useTimeFormat();
  const [name, setName] = useState("");
  const scopes = admin ? SCOPES : SCOPES.filter((x) => x.id === "read");
  const [scope, setScope] = useState<TokenScope>(admin ? "deploy" : "read");
  const [expiry, setExpiry] = useState("90");
  // The project scope is a deliberate choice: nothing is selected until the creator picks.
  const [reach, setReach] = useState<Reach>("");
  const [picked, setPicked] = useState<string[]>([]);
  const [slugText, setSlugText] = useState("");
  const [envWrite, setEnvWrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reachError, setReachError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [made, setMade] = useState<ApiToken | null>(null);

  const listed = projects.length > 0;
  const slugs = listed ? picked : parseSlugs(slugText);
  const reachChosen = reach === "all" || (reach === "selected" && slugs.length > 0);
  const grants: TokenGrant[] = scope === "admin" && envWrite ? ["env:write"] : [];
  const toggle = (slug: string, on: boolean) => {
    setPicked((p) => (on ? [...p, slug] : p.filter((x) => x !== slug)));
    setReachError(null);
  };

  // Never disabled: a press with something missing says what it is, under its field.
  const submit = async () => {
    if (busy || secret) return;
    const nameProblem = displayNameProblem(name, { empty: "Give the token a name" });
    if (nameProblem) return setError(nameProblem);
    if (!reachChosen) return setReachError(reach === "selected" ? "Choose at least one project" : "Choose which projects the token may reach");
    setBusy(true);
    const res = await settle(elevate(() => createToken({ name, scope, expiresInDays: expiry === "never" ? null : Number(expiry), projects: reach === "all" ? "all" : slugs, grants }), { what: "Creating a token" }));
    setBusy(false);
    // Input problems stay under the field. The secret shows once in this dialog, so the toast
    // only confirms; it needs no "View" action.
    if (!res.ok) return /project/i.test(res.error) ? setReachError(res.error) : setError(res.error);
    toast.success("Token created", { description: describe(`${res.data.token.name}, ${SCOPE_LABEL[res.data.token.scope]}`, { preview }) });
    setSecret(res.data.secret);
    setMade(res.data.token);
    onCreated(res.data.token);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      icon="key"
      title={secret ? "Copy your new token" : "New API token"}
      onSubmit={() => void submit()}
      footer={
        secret ? (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            <Icon name="check" />
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <PendingButton type="submit" className="btn btn-primary" pending={busy} icon="plus">
              Create token
            </PendingButton>
          </>
        )
      }
    >
      {secret ? (
        <>
          <Callout tone="warn" icon="alert">
            This is the only time the token is shown. Dockify keeps a hash, not the token.
          </Callout>
          {made ? (
            <dl className="as-facts">
              <div className="kv">
                <dt className="kv-label">Name</dt>
                <dd className="kv-value">{made.name}</dd>
              </div>
              <div className="kv">
                <dt className="kv-label">Scope</dt>
                <dd className="kv-value">{SCOPE_LABEL[made.scope]}</dd>
              </div>
              <div className="kv">
                <dt className="kv-label">Projects</dt>
                <dd className="kv-value">{made.allProjects ? "All projects" : (made.projects ?? []).join(", ") || "None"}</dd>
              </div>
              {made.grants?.length ? (
                <div className="kv">
                  <dt className="kv-label">Grants</dt>
                  <dd className="kv-value">{made.grants.join(", ")}</dd>
                </div>
              ) : null}
              <div className="kv">
                <dt className="kv-label">Expires</dt>
                <dd className="kv-value num">{made.expiresAt ? time.abs(made.expiresAt) : "Never"}</dd>
              </div>
            </dl>
          ) : null}
          <div className="fld">
            <span className="fld-label">Token</span>
            <CopyBox value={secret} what="token" code />
          </div>
          <div className="fld">
            <span className="fld-label">Example request</span>
            <CopyBox value={`curl -H "Authorization: Bearer ${secret}" ${origin()}/api/v1/projects`} what="example request" code />
            <p className="fld-note">Send the token in the Authorization header on every request.</p>
          </div>
        </>
      ) : (
        <>
          <Field label="Name" hint="What uses it, so you know what breaks if you revoke it." error={error}>
            {(ids) => (
              <TextInput
                ids={ids}
                value={name}
                maxLength={64}
                placeholder="github-actions"
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                data-autofocus
              />
            )}
          </Field>
          <Field label="Scope" hint={SCOPES.find((s) => s.id === scope)?.hint}>
            {(ids) => <Select ids={ids} label="Scope" value={scope} onChange={setScope} options={scopes.map((s) => ({ value: s.id, label: s.label }))} />}
          </Field>
          <Field label="Projects" hint={REACH_HINT[reach]} error={reachError}>
            {(ids) => (
              <Select
                ids={ids}
                label="Projects"
                value={reach || null}
                placeholder="Choose which projects"
                onChange={(v) => {
                  setReach(v);
                  setReachError(null);
                }}
                options={REACH}
              />
            )}
          </Field>
          {reach === "selected" ? (
            listed ? (
              <fieldset className="as-pick">
                <legend className="sr">Projects the token may reach</legend>
                {projects.map((slug) => (
                  <label key={slug} className="as-pick-row">
                    <input type="checkbox" checked={picked.includes(slug)} onChange={(e) => toggle(slug, e.target.checked)} />
                    <span className="as-pick-name">{slug}</span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <Field label="Project names" hint="Comma-separated, as they appear in the project list.">
                {(ids) => (
                  <TextInput
                    ids={ids}
                    value={slugText}
                    maxLength={600}
                    placeholder="shop, blog"
                    onChange={(e) => {
                      setSlugText(e.target.value);
                      setReachError(null);
                    }}
                  />
                )}
              </Field>
            )
          ) : null}
          {scope === "admin" ? (
            <div className="int-switch-row">
              <span className="two">
                <label htmlFor="tok-env-write" className="two-main">
                  Allow variable changes
                </label>
                <span className="two-sub">
                  The token can add and change plain variables through the API. It still cannot read or change secrets, or set keys that change how the process starts,
                  such as NODE_OPTIONS.
                </span>
              </span>
              <Switch id="tok-env-write" checked={envWrite} onChange={setEnvWrite} />
            </div>
          ) : null}
          <Field label="Expires after" hint={expiry === "never" ? "A token that never expires keeps working until you revoke it." : undefined}>
            {(ids) => <Select ids={ids} label="Expires after" value={expiry} onChange={setExpiry} options={EXPIRY} />}
          </Field>
        </>
      )}
    </Dialog>
  );
}

/** Tokens act immediately (create, revoke), so this section never has a save bar. */
export function TokensSection({ data, update, now, preview, elevate, projects }: SectionProps) {
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);

  // A failed revoke toasts and keeps the question open, so trying again is one click.
  const revoke = async () => {
    if (!revoking) return;
    const res = report(await settle(revokeToken(revoking.id)), { success: "Token revoked", error: "Could not revoke token", what: revoking.name, preview });
    if (!res.ok) throw new Error(res.error);
    update({ tokens: data.tokens.filter((t) => t.id !== revoking.id) });
  };

  return (
    <Group
      id="set-tokens"
      icon="key"
      title="API tokens"
      sub="For scripts and CI, acting as you within its scope and projects"
      actions={
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
          <Icon name="plus" />
          New token
        </button>
      }
    >
      {data.tokens.length === 0 ? (
        <Empty size="sm" icon="key" title="No API tokens yet" body="Create one to deploy from CI or script against the Dockify API." />
      ) : (
        <>
          <div className="set-tk-head" aria-hidden="true">
            <span>Token</span>
            <span>Access</span>
            <span>Usage</span>
            <span />
          </div>
          <ul className="set-tm-list" aria-label="API tokens">
            {data.tokens.map((t) => (
              <TokenRow key={t.id} t={t} now={now} onRevoke={() => setRevoking(t)} />
            ))}
          </ul>
        </>
      )}
      {creating ? (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(t) => update({ tokens: [t, ...data.tokens] })}
          preview={preview}
          elevate={elevate}
          projects={projects}
          admin={data.me.role === "admin"}
        />
      ) : null}
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={revoke}
        tone="danger"
        title="Revoke token"
        body={`Anything using ${revoking?.name ?? "this token"} stops working at once. This cannot be undone.`}
        confirmLabel="Revoke token"
        confirmIcon="trash"
        returnFocus={() => document.getElementById("set-tokens")}
      />
    </Group>
  );
}
