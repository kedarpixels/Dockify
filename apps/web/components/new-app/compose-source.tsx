"use client";

import { Icon } from "@/components/icon";
import { AppIcon } from "@/components/icons/app-icon";
import { KIND_LABEL } from "@/components/project-detail/shared";
import { Empty } from "@/components/ui/empty";
import { Field, TextArea } from "@/components/ui/field";
import { GroupHead } from "@/components/ui/group-head";
import { Select } from "@/components/ui/select";
import { COMPOSE_EXAMPLE, type ComposeResult } from "./compose";
import type { ComposeDraft, Errors } from "./draft";
import type { RunKind } from "./spec";

/*
 * Step 2 for a Compose import: paste the file, then review what it maps to. Each importable
 * service is a checkbox row (image apps also pick their kind), skipped services say why, and every
 * refused or dropped setting is listed, so nothing is left out silently.
 */

const RUN_KINDS: RunKind[] = ["frontend", "backend", "bot"];

export function ComposeSource({
  draft,
  set,
  plan,
  errors,
  showErrors,
}: {
  draft: ComposeDraft;
  set: (fn: (d: ComposeDraft) => ComposeDraft) => void;
  /** The parsed plan for the current text, or null while typing settles. */
  plan: ComposeResult | null;
  errors: Errors;
  showErrors: boolean;
}) {
  const ok = plan?.ok ? plan.plan : null;
  // A parse error shows as soon as the text settles; "pick one" waits for Continue.
  const error = plan && !plan.ok ? plan.error : showErrors ? errors.compose : undefined;
  const toggle = (service: string, on: boolean) =>
    set((d) => ({ ...d, excluded: on ? d.excluded.filter((s) => s !== service) : [...d.excluded, service] }));
  const refused = ok?.warnings.filter((w) => w.refused) ?? [];
  const dropped = ok?.warnings.filter((w) => !w.refused) ?? [];

  return (
    <div className="na-stack">
      <Field
        label="docker-compose.yml"
        error={error}
        hint={
          <>
            Parsed in your browser. Host ports, privileged mode, capabilities, the host network and bind mounts are never imported.{" "}
            {draft.text ? null : (
              <button type="button" className="na-link" onClick={() => set((d) => ({ ...d, text: COMPOSE_EXAMPLE }))}>
                Paste an example
              </button>
            )}
          </>
        }
      >
        {(ids) => (
          <TextArea
            ids={ids}
            data-autofocus
            autoFocus
            rows={10}
            className="mono na-yaml"
            spellCheck={false}
            autoComplete="off"
            placeholder={"services:\n  web:\n    image: ghcr.io/owner/web:1.0"}
            value={draft.text}
            onChange={(e) => set((d) => ({ ...d, text: e.target.value }))}
          />
        )}
      </Field>

      {!draft.text.trim() ? null : ok && ok.apps.length + ok.skipped.length > 0 ? (
        <div className="na-plan">
          {ok.apps.length ? (
            <section aria-label="Apps to create">
              <GroupHead as="h4" label="Apps to create" count={ok.apps.length - ok.apps.filter((a) => draft.excluded.includes(a.service)).length} noun="app" />
              <ul className="soft-list">
                {ok.apps.map((a) => {
                  const on = !draft.excluded.includes(a.service);
                  const kind = a.spec.source.type === "image" ? (draft.kinds[a.service] ?? (a.spec.kind as RunKind)) : a.spec.kind;
                  return (
                    <li key={a.service} className="na-svc" data-off={!on || undefined}>
                      <label className="na-svc-main">
                        <input type="checkbox" checked={on} onChange={(e) => toggle(a.service, e.target.checked)} />
                        <AppIcon kind={kind} size="md" />
                        <span className="two">
                          <span className="two-main na-svc-name">{a.spec.name}</span>
                          <span className="two-sub na-svc-sub">{a.summary}</span>
                        </span>
                      </label>
                      {a.spec.source.type === "image" ? (
                        <Select<RunKind>
                          label={`Kind of ${a.spec.name}`}
                          size="sm"
                          align="end"
                          className="na-svc-kind"
                          disabled={!on}
                          value={kind as RunKind}
                          onChange={(k) => set((d) => ({ ...d, kinds: { ...d.kinds, [a.service]: k } }))}
                          options={RUN_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k], glyph: <AppIcon kind={k} /> }))}
                        />
                      ) : (
                        <span className="na-svc-tag">{KIND_LABEL[kind]}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {ok.skipped.length ? (
            <section aria-label="Skipped services">
              <GroupHead as="h4" label="Skipped" count={ok.skipped.length} noun="service" />
              <ul className="na-issues">
                {ok.skipped.map((s) => (
                  <li key={s.service}>
                    <Icon name="minus" size={14} />
                    <span>
                      <b className="na-issue-svc">{s.service}</b>, {lowerFirst(s.reason)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {refused.length + dropped.length ? (
            <section aria-label="Not imported">
              <GroupHead as="h4" label="Not imported" count={refused.length + dropped.length} noun="setting" />
              <ul className="na-issues">
                {[...refused, ...dropped].map((w, i) => (
                  <li key={i}>
                    <Icon name={w.refused ? "alert" : "info"} size={14} className={w.refused ? "tone-warn" : undefined} />
                    <span>
                      {w.service ? (
                        <>
                          <b className="na-issue-svc">{w.service}</b>,{" "}
                        </>
                      ) : null}
                      {w.service ? lowerFirst(w.text) : w.text}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : ok ? (
        <Empty icon="layers" title="No services to import" body="The file has a services: section, but none of its services can run here." />
      ) : null}
    </div>
  );
}

/** "Builds from source" reads "builds from source" after a service name and a comma. Names keep their capital. */
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) && !/^(Dockify|Postgres|Redis|MinIO)/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
