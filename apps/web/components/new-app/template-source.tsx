"use client";

import { useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { AppIcon } from "@/components/icons/app-icon";
import { Callout } from "@/components/ui/callout";
import { Empty } from "@/components/ui/empty";
import { envName } from "@/components/ui/env-tag";
import { Field, SearchField, TextInput } from "@/components/ui/field";
import { GroupHead } from "@/components/ui/group-head";
import { IconTile } from "@/components/ui/icon-tile";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { SkelRows } from "@/components/ui/skeleton";
import { showsEnvironments } from "@/lib/environments";
import { plural } from "@/lib/format";
import type { ProjectEnvironment } from "@/lib/pages/project-detail";
import { TEMPLATE_ICONS } from "./template-icons";
import type { TemplateDraft, TemplateRow } from "./template-spec";

// The list comes from the release's own catalog and holds no secret: a generated value reads
// "generated secret" here, and only the server ever makes one.

function TemplateIcon({ row, size }: { row: Pick<TemplateRow, "icon" | "name">; size: "md" | "lg" }) {
  const d = TEMPLATE_ICONS[row.icon];
  const px = size === "lg" ? 20 : 16;
  return (
    <IconTile size={size}>
      {d ? (
        <svg viewBox="0 0 24 24" width={px} height={px} fill="currentColor" aria-hidden="true">
          <path d={d} />
        </svg>
      ) : (
        <Icon name="box" size={px} />
      )}
    </IconTile>
  );
}

export function TemplatePicker({ state, onPick, retry }: { state: { rows: TemplateRow[] | null; error: string | null }; onPick: (row: TemplateRow) => void; retry: () => void }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return state.rows ?? [];
    return (state.rows ?? []).filter((r) => `${r.name} ${r.summary} ${r.category}`.toLowerCase().includes(needle));
  }, [q, state.rows]);
  if (state.error) {
    return (
      <Callout tone="warn" icon="alert" action={<button type="button" className="btn btn-sm" onClick={retry}>Try again</button>}>
        {state.error}
      </Callout>
    );
  }
  if (!state.rows) return <SkelRows rows={6} height={72} template="minmax(0, 1fr)" cols={[{ w: "60%", lines: 2 }]} />;
  return (
    <div className="na-stack">
      <div className="na-tpl-search">
        <SearchField value={q} onChange={setQ} label="Search templates" placeholder="Search templates" slash={false} />
      </div>
      {shown.length ? (
        <ul className="na-cards" data-layout="grid" aria-label="Templates">
          {shown.map((r) => (
            <li key={r.id}>
              <button type="button" className="na-card tile-host" onClick={() => onPick(r)}>
                <TemplateIcon row={r} size="lg" />
                <span className="two">
                  <span className="two-main">{r.name}</span>
                  <span className="two-sub">{r.summary}</span>
                </span>
                <Icon name="chevronRight" className="na-card-go" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon="search" title="No template matches" body="Try another word, or use Docker image or Compose import." />
      )}
    </div>
  );
}

function WhatRuns({ row, base, hostname }: { row: TemplateRow; base: string; hostname: string }) {
  const nameOf = (service: string, primary: boolean) => (primary ? base : `${base}-${service}`);
  const total = row.apps.reduce((n, a) => n + a.memoryMb, 0);
  return (
    <section aria-label="What will run">
      <GroupHead as="h4" label="What will run" count={row.apps.length} noun="app" />
      <ul className="na-tpl-apps">
        {row.apps.map((a) => (
          <li key={a.service} className="na-tpl-app">
            <div className="na-tpl-head">
              <AppIcon kind={a.kind} size="md" />
              <span className="two">
                <span className="two-main na-svc-name">{nameOf(a.service, a.primary)}</span>
                <span className="two-sub na-svc-sub mono">{a.managed ? `${a.managed}, managed by Dockify, backed up` : a.image}</span>
              </span>
            </div>
            <dl className="na-tpl-facts">
              <div><dt>Memory</dt><dd>{a.memoryMb.toLocaleString("en-US")} MB</dd></div>
              {a.port ? <div><dt>Port</dt><dd>{a.port}{a.primary && hostname ? `, served at ${hostname}` : a.primary ? "" : ", private"}</dd></div> : null}
              {a.command ? <div><dt>Command</dt><dd className="mono">{a.command}</dd></div> : null}
              {a.volumes.map((v) => <div key={v.path}><dt>Volume</dt><dd className="mono">{v.path}</dd></div>)}
            </dl>
            {a.env.length ? (
              <details className="na-tpl-env">
                <summary>{plural(a.env.length, "variable")}</summary>
                <dl>
                  {a.env.map((e) => (
                    <div key={e.key}>
                      <dt className="mono">{e.key}</dt>
                      <dd className={e.secret ? undefined : "mono"}>{e.shows}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="fld-note">{total.toLocaleString("en-US")} MB of memory reserved in total. Each image is pulled by its tag, and its digest is recorded on the first pull.</p>
    </section>
  );
}

export function TemplateReview({
  row, draft, set, environments, environment, onEnvironment, nameError, hostError, inputErrors, testDomain,
}: {
  row: TemplateRow;
  draft: TemplateDraft;
  set: (fn: (d: TemplateDraft) => TemplateDraft) => void;
  environments: ProjectEnvironment[];
  environment: string;
  onEnvironment: (name: string) => void;
  nameError?: string;
  hostError?: string;
  inputErrors: Record<string, string | undefined>;
  testDomain: boolean;
}) {
  const options = [
    ...(testDomain ? [{ value: "test" as const, label: "Free test domain" }] : []),
    { value: "custom" as const, label: "My domain" },
    ...(row.needsDomain ? [] : [{ value: "none" as const, label: "Later" }]),
  ];
  const hostname = draft.domain === "custom" ? draft.hostname.trim() : draft.domain === "test" ? "a free test domain" : "";
  return (
    <div className="na-stack">
      <div className="na-summary">
        <TemplateIcon row={row} size="md" />
        <span className="two">
          <span className="two-main">{row.name}</span>
          <span className="two-sub na-summary-line">
            {row.license}.{" "}
            <a className="na-link" href={row.docs} target="_blank" rel="noreferrer noopener">
              Docs
            </a>
          </span>
        </span>
      </div>

      <div className="na-pair">
        <Field label="Name" error={nameError} hint="The other apps add their role to it.">
          {(ids) => <TextInput ids={ids} data-autofocus value={draft.name} spellCheck={false} autoComplete="off" onChange={(e) => set((d) => ({ ...d, name: e.target.value.toLowerCase() }))} />}
        </Field>
        {showsEnvironments(environments) ? (
          <Field label="Environment">
            {(ids) => <Select ids={ids} label="Environment" value={environment} onChange={onEnvironment} options={environments.map((e) => ({ value: e.name, label: envName(e.name), hint: e.branch, icon: "branch" }))} />}
          </Field>
        ) : null}
      </div>

      <div className="fld">
        <span className="fld-label">Domain</span>
        <Segmented label="Domain" value={draft.domain} onChange={(v) => set((d) => ({ ...d, domain: v }))} options={options} />
        {draft.domain === "test" ? <p className="fld-note">A name of this server on sslip.io, with its own certificate. Good for trying it out.</p> : null}
        {draft.domain === "none" ? <p className="fld-note">It runs without an address until you add one on its Domains tab.</p> : null}
      </div>
      {draft.domain === "custom" ? (
        <Field label="Hostname" error={hostError} hint="Point its DNS at this server. The certificate follows.">
          {(ids) => <TextInput ids={ids} className="mono" value={draft.hostname} placeholder="app.example.com" spellCheck={false} autoComplete="off" onChange={(e) => set((d) => ({ ...d, hostname: e.target.value }))} />}
        </Field>
      ) : null}

      {row.inputs.map((i) => (
        <Field key={i.key} label={i.label} hint={i.hint} error={inputErrors[i.key]}>
          {(ids) => (
            <TextInput ids={ids} type={i.type === "email" ? "email" : "text"} value={draft.inputs[i.key] ?? ""} spellCheck={false} autoComplete="off" onChange={(e) => set((d) => ({ ...d, inputs: { ...d.inputs, [i.key]: e.target.value } }))} />
          )}
        </Field>
      ))}

      <Callout tone="info" icon="info">
        <b className="pd-strong">On the first visit.</b> {row.firstRun}
      </Callout>

      <WhatRuns row={row} base={draft.name || row.id} hostname={hostname} />
    </div>
  );
}
