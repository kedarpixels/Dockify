"use client";

import Link from "next/link";
import { Icon, type IconName } from "@/components/icon";
import { AppIcon } from "@/components/icons/app-icon";
import { KIND_LABEL } from "@/components/project-detail/shared";
import { Callout } from "@/components/ui/callout";
import { envName } from "@/components/ui/env-tag";
import { Field, TextInput } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { IconTile } from "@/components/ui/icon-tile";
import { Select } from "@/components/ui/select";
import { showsEnvironments } from "@/lib/environments";
import type { ProjectEnvironment } from "@/lib/pages/project-detail";
import type { AppKind } from "@/lib/types";
import { ChoiceCards, type CardOption } from "./choice";
import type { ContextState } from "./client";
import { conflictLine, type DetailsDraft } from "./draft";
import type { AppSpec, DeployTarget, LinkConflict, RunKind } from "./spec";

/*
 * Step 3, shared by every source: what is about to be created in one soft line, then the name,
 * the environment, the kind, and for a frontend built from a repository, where it deploys. A
 * Postgres or Redis also lists the environment's apps, each with a checkbox: a checked app gets
 * DATABASE_URL or REDIS_URL, linked to the new service.
 */

const RUN_KINDS: RunKind[] = ["frontend", "backend", "bot"];

/** "Link to apps", for a new Postgres or Redis. */
export interface LinkStep {
  /** DATABASE_URL or REDIS_URL. */
  key: string;
  /** The apps that can be linked: the ones that run code in the chosen environment. */
  apps: Array<{ id: string; name: string; kind: AppKind }>;
  /** The API's conflict, narrowed to the apps still checked. Null when there is none. */
  conflict: LinkConflict | null;
}

export function DetailsStep({
  draft,
  set,
  environments,
  summary,
  /** The apps a Compose import creates; absent for a single app. */
  many,
  nameError,
  manyError,
  showKind,
  showTarget,
  link,
  ctx,
  testDomain,
}: {
  draft: DetailsDraft;
  set: (fn: (d: DetailsDraft) => DetailsDraft) => void;
  environments: ProjectEnvironment[];
  summary: { icon: IconName; title: string; line: string };
  many?: AppSpec[];
  nameError?: string;
  manyError?: string;
  showKind: boolean;
  showTarget: boolean;
  /** A new Postgres or Redis only. */
  link?: LinkStep;
  ctx: ContextState;
  /** The free test domain's choice, when this server can offer one and this app can use it. */
  testDomain?: { on: boolean; set: (on: boolean) => void };
}) {
  const vercel = ctx.state === "ready" ? ctx.data.vercel : null;
  const targets: CardOption<DeployTarget>[] = [
    { value: "server", icon: "server", title: "This server", body: "Builds and serves here, behind your domains and TLS." },
    {
      value: "vercel",
      icon: "vercel",
      title: "Vercel",
      body: vercel
        ? `Follows a project on ${vercel.team ?? vercel.account}: pick it in the app’s Settings. Nothing is sent to Vercel.`
        : ctx.state === "loading"
          ? "Checking the Vercel connection."
          : "Connect Vercel in Settings, Integrations first.",
      disabled: !vercel,
    },
  ];

  return (
    <div className="na-stack">
      <div className="na-summary">
        <IconTile size="md">
          <Icon name={summary.icon} />
        </IconTile>
        <span className="two">
          <span className="two-main">{summary.title}</span>
          <span className="two-sub na-summary-line">{summary.line}</span>
        </span>
      </div>

      {many ? (
        <div className="fld" data-invalid={manyError ? true : undefined}>
          <span className="fld-label">Apps</span>
          <ul className="na-names" aria-label="Apps to create">
            {many.map((a) => (
              <li key={a.name} className="na-name">
                <AppIcon kind={a.kind} />
                {a.name}
              </li>
            ))}
          </ul>
          {manyError ? (
            <p className="fld-note fld-error" role="alert">
              {manyError}
            </p>
          ) : (
            <p className="fld-note">Each gets its own container and internal hostname{showsEnvironments(environments) ? ` in ${envName(draft.environment)}` : ""}.</p>
          )}
        </div>
      ) : (
        <Field label="Name" error={nameError} hint="Used for its container and internal hostname.">
          {(ids) => (
            <TextInput
              ids={ids}
              data-autofocus
              autoComplete="off"
              spellCheck={false}
              placeholder="api"
              value={draft.name}
              onChange={(e) => set((d) => ({ ...d, named: true, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32) }))}
            />
          )}
        </Field>
      )}

      <div className="na-pair">
        {showsEnvironments(environments) ? (
          <Field label="Environment">
            {(ids) => (
              <Select
                ids={ids}
                label="Environment"
                className="na-sel"
                value={draft.environment}
                onChange={(environment) => set((d) => ({ ...d, environment }))}
                options={environments.map((e) => ({ value: e.name, label: envName(e.name), hint: e.branch, icon: "branch" }))}
              />
            )}
          </Field>
        ) : null}
        {showKind ? (
          <Field label="Kind">
            {(ids) => (
              <Select<RunKind>
                ids={ids}
                label="Kind"
                className="na-sel"
                value={draft.kind ?? "backend"}
                onChange={(kind) => set((d) => ({ ...d, kind }))}
                options={RUN_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k], glyph: <AppIcon kind={k} /> }))}
              />
            )}
          </Field>
        ) : null}
      </div>

      {showTarget ? (
        <fieldset className="na-group">
          <legend className="na-legend">Deploy to</legend>
          <ChoiceCards label="Deploy to" options={targets} value={draft.target} onChange={(target) => set((d) => ({ ...d, target }))} />
          {draft.target === "vercel" ? (
            <p className="fld-note">Dockify shows the project’s deployments and logs here, and changes nothing on Vercel.</p>
          ) : !vercel && ctx.state !== "loading" ? (
            <p className="fld-note">
              Want Vercel for this frontend? <Link href="/settings?section=integrations">Connect it in Settings</Link>, then pick it here.
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {testDomain && draft.target === "server" ? (
        <div className="cf-proxy">
          <span className="two">
            <span className="two-main">Use a free test domain</span>
            <span className="two-sub">A test address on sslip.io with HTTPS and nothing to set up, for trying things out. Use your own domain for real traffic.</span>
          </span>
          <Switch checked={testDomain.on} onChange={testDomain.set} label="Use a free test domain" />
        </div>
      ) : null}

      {link ? <LinkApps link={link} draft={draft} set={set} many={showsEnvironments(environments)} /> : null}
    </div>
  );
}

/**
 * The environment's apps, each with a checkbox; none is checked unless New app was opened from
 * one. A checked app's line says what it gets, or, after the API answered a conflict, what it has.
 */
function LinkApps({ link, draft, set, many }: { link: LinkStep; draft: DetailsDraft; set: (fn: (d: DetailsDraft) => DetailsDraft) => void; many: boolean }) {
  const env = many ? envName(draft.environment) : "this project";
  const service = draft.name || "the new service";
  const toggle = (id: string, on: boolean) => set((d) => ({ ...d, links: on ? [...d.links.filter((x) => x !== id), id] : d.links.filter((x) => x !== id) }));
  const held = new Map(link.conflict?.apps.map((a) => [a.id, a]));
  return (
    <fieldset className="na-group">
      <legend className="na-legend">Link to apps</legend>
      {link.apps.length ? (
        <ul className="soft-list" aria-label={`Apps in ${env}`}>
          {link.apps.map((a) => {
            const on = draft.links.includes(a.id);
            const has = on ? held.get(a.id) : undefined;
            const sub = has ? (has.shared ? `Gets ${link.key} from the shared variables` : `Has its own ${link.key}`) : on ? `Gets ${link.key}` : KIND_LABEL[a.kind];
            // Unchecked is where every row starts, so it is not dimmed the way a left out Compose service is.
            return (
              <li key={a.id} className="na-svc">
                <label className="na-svc-main">
                  <input type="checkbox" checked={on} onChange={(e) => toggle(a.id, e.target.checked)} />
                  <AppIcon id={a.id} kind={a.kind} size="md" />
                  <span className="two">
                    <span className="two-main na-svc-name">{a.name}</span>
                    <span className="two-sub na-svc-sub">{sub}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="fld-note">No apps in {env} to link yet. Link it to an app later from that app’s Variables tab.</p>
      )}
      {link.conflict ? (
        <Callout tone="warn" icon="alert" role="alert">
          {conflictLine(link.conflict, service, many ? draft.environment : null)}
        </Callout>
      ) : link.apps.length ? (
        <p className="fld-note">
          A checked app gets {link.key}, filled in with this service’s credentials when the app deploys. It reaches a running app on its next deploy.
        </p>
      ) : null}
    </fieldset>
  );
}
