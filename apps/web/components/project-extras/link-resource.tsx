"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { AppIcon } from "@/components/icons/app-icon";
import { ENV_KEY } from "@/components/project-detail/dotenv";
import { cx } from "@/components/ui/cx";
import { Dialog } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { envName } from "@/components/ui/env-tag";
import { Field, TextInput } from "@/components/ui/field";
import { GroupHead } from "@/components/ui/group-head";
import { Select } from "@/components/ui/select";
import { appTitle, plural } from "@/lib/format";
import type { AppSummary, EnvRef, EnvTarget, StatefulKind } from "@/lib/pages/project-detail";
import { FIELD_NAME, isService, KIND_NAME, REF_FIELDS } from "./env-refs";
import { TARGET_LABEL } from "./env-model";

// Each pick becomes a reference, staged like any other edit and resolved on the server at deploy
// time. Services in another environment cannot be picked: each environment has its own private network.

export interface LinkPick {
  key: string;
  ref: EnvRef;
  target: EnvTarget;
}

interface FieldRow {
  field: EnvRef["field"];
  key: string;
  on: boolean;
}

const TARGETS: Array<{ value: EnvTarget; label: string }> = [
  { value: "runtime", label: TARGET_LABEL.runtime },
  { value: "build", label: TARGET_LABEL.build },
  { value: "both", label: TARGET_LABEL.both },
];

type Service = AppSummary & { kind: StatefulKind };

const rowsFor = (svc: Service | undefined): FieldRow[] => (svc ? REF_FIELDS[svc.kind].map((f) => ({ field: f.field, key: f.key, on: f.linked })) : []);

function keyProblem(key: string, seen: Set<string>) {
  if (!key) return "Enter a key";
  if (key.length > 128 || !ENV_KEY.test(key)) return "Use letters, numbers and underscores, not starting with a number";
  if (seen.has(key)) return "Used twice in this link";
  return null;
}

export function LinkResourceDialog({
  open,
  onClose,
  slug,
  environment,
  where,
  apps,
  taken,
  forApp,
  onLink,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  /** Only its services can be picked. */
  environment: string;
  /** The scope, for the sub line: "Production, shared" or "Production, api". */
  where: string;
  apps: AppSummary[];
  /** Keys already set in the scope: linking one replaces its value. */
  taken: string[];
  /** The app whose own variables these are; a service created from here starts linked to it. */
  forApp?: string;
  onLink: (picks: LinkPick[]) => void;
}) {
  const services = useMemo(() => apps.filter((a): a is Service => isService(a.kind)), [apps]);
  const groups = useMemo(() => {
    const names = [...new Set([environment, ...services.map((s) => s.environment)])];
    return names.map((env) => ({ env, items: services.filter((s) => s.environment === env) })).filter((g) => g.items.length);
  }, [services, environment]);
  const first = services.find((s) => s.environment === environment);
  const [picked, setPicked] = useState<string | null>(first?.id ?? null);
  const [rows, setRows] = useState<FieldRow[]>(() => rowsFor(first));
  const [target, setTarget] = useState<EnvTarget>("runtime");
  const [tried, setTried] = useState(false);

  const svc = services.find((s) => s.id === picked);
  const chosen = rows.filter((r) => r.on);
  const problems = useMemo(() => {
    const seen = new Set<string>();
    return rows.map((r) => {
      if (!r.on) return null;
      const p = keyProblem(r.key, seen);
      seen.add(r.key);
      return p;
    });
  }, [rows]);
  const invalid = problems.some(Boolean);

  const pick = (id: string) => {
    setPicked(id);
    setRows(rowsFor(services.find((s) => s.id === id)));
    setTried(false);
  };

  const edit = (i: number, patch: Partial<FieldRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = () => {
    setTried(true);
    if (!svc || !chosen.length || invalid) return;
    onLink(chosen.map((r) => ({ key: r.key, ref: { resourceId: svc.id, field: r.field }, target })));
  };

  const count = chosen.length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      icon="link"
      title="Link a service"
      sub={`Adds variables in ${where} that read a service’s credentials at deploy time.`}
      onSubmit={submit}
      footer={
        services.length ? (
          <>
            <span className="dlg-note">Nothing is sent until you apply</span>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!svc || !count}>
              <Icon name="link" />
              {count ? `Link ${plural(count, "variable")}` : "Link variables"}
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        )
      }
    >
      {services.length === 0 ? (
        <Empty
          icon="database"
          title="No services in this project"
          body="Add Postgres or Redis with New app, and pick the apps it links to as you create it."
          action={
            // The project page opens New app on its "Database or service" step for this address,
            // with the app these variables belong to already checked under "Link to apps".
            <Link href={`/projects/${encodeURIComponent(slug)}?new=service${forApp ? `&for=${encodeURIComponent(forApp)}` : ""}`} className="btn btn-sm" onClick={onClose}>
              New app
            </Link>
          }
        />
      ) : (
        <div className="px-link">
          <div role="radiogroup" aria-label="Service">
            {groups.map((g) => {
              const reachable = g.env === environment;
              return (
                <section key={g.env} aria-label={envName(g.env)}>
                  {groups.length > 1 ? <GroupHead as="h4" label={reachable ? envName(g.env) : `${envName(g.env)}, another network`} count={g.items.length} noun="service" /> : null}
                  <ul className="px-link-list">
                    {g.items.map((s) => (
                      <li key={s.id}>
                        <label
                          className={cx("px-link-opt", picked === s.id && "surface-key-picked")}
                          data-on={picked === s.id || undefined}
                          data-off={!reachable || undefined}
                        >
                          <AppIcon id={s.id} kind={s.kind} size="md" />
                          <span className="two">
                            <span className="two-main">
                              {slug} / {appTitle(s)}
                            </span>
                            {/* A renamed service: the name its connection details use, the host a linked app dials. */}
                            <span className="two-sub">
                              {reachable ? KIND_NAME[s.kind] : `${KIND_NAME[s.kind]}, apps in ${envName(environment)} cannot reach it`}
                              {s.displayName ? `, host ${s.name}` : null}
                            </span>
                          </span>
                          <input type="radio" name="px-link-svc" className="radio" checked={picked === s.id} disabled={!reachable} onChange={() => pick(s.id)} />
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>

          {svc ? (
            <fieldset className="px-link-fields">
              <legend className="px-link-legend">Variables</legend>
              {rows.map((r, i) => {
                const error = tried || r.key !== "" ? problems[i] : null;
                const replaces = r.on && !error && taken.includes(r.key);
                return (
                  <div key={r.field} className="px-link-field" data-on={r.on || undefined}>
                    <input type="checkbox" checked={r.on} aria-label={`Link ${r.key || r.field}`} onChange={(e) => edit(i, { on: e.target.checked })} />
                    <span className="px-link-key">
                      <TextInput
                        aria-label={`Name for ${r.field}`}
                        value={r.key}
                        invalid={Boolean(r.on && error)}
                        disabled={!r.on}
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={128}
                        onChange={(e) => edit(i, { key: e.target.value.toUpperCase().replace(/\s/g, "_") })}
                      />
                      {r.on && error ? (
                        <span className="px-link-msg tone-bad" role="alert">
                          {error}
                        </span>
                      ) : replaces ? (
                        <span className="px-link-msg">Replaces the value set now</span>
                      ) : null}
                    </span>
                    <span className="px-link-what">{FIELD_NAME[r.field]}</span>
                  </div>
                );
              })}
            </fieldset>
          ) : null}

          <Field label="Used at" hint="The value stays masked, and a rotated password reaches the app on its next deploy.">
            {(ids) => <Select ids={ids} label="Used at" value={target} options={TARGETS} onChange={setTarget} />}
          </Field>
        </div>
      )}
    </Dialog>
  );
}
