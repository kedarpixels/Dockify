"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { IconCard } from "@/components/icons/icon-card";
import { START_COMMAND_HINT } from "@/components/new-app/build-fields";
import { IMAGE_REF } from "@/components/new-app/spec";
import { BRANCH_MESSAGE, BRANCH_NAME } from "@/lib/validation";
import { envName } from "@/components/ui/env-tag";
import { Field, TextInput } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { SkelRows } from "@/components/ui/skeleton";
import { sourceOf, type AppSource } from "@/lib/app-source";
import { report } from "@/lib/feedback";
import { appTitle } from "@/lib/format";
import type { AppConfig, AppDetail, AppSettings } from "@/lib/pages/project-detail";
import { useCan } from "@/lib/viewer";
import { mutate } from "@/components/project-detail/controls";
import { useLeaveGuard } from "@/components/ui/leave-guard";
import { DangerZone, DeleteDialog, isManaged, KIND_LABEL } from "@/components/project-detail/shared";
import { NameSection } from "./name-section";
import { VersionSection } from "./version-section";
import { HealthSection, LimitsSection, ReleaseSection, SaveRow, TargetSection, useReportDirty, type DirtyReport } from "./settings-sections";
import { TabCard, TabFailed } from "./states";
import { useAppTab } from "./use-tab";

/* The app's settings: its name, build and run, the icon, health check, resource limits, release command, the
   deploy target for frontends, then the danger zone (the project settings order: identity first).
   An app on Vercel keeps only what does something for it: the branch, the icon, the deploy target
   and the danger zone. Nothing runs here, so the rest waits, saved, for a move back to this server.
   Each card saves on its own, so one bad field never blocks another card's save. Build and run is
   part of the app itself; the rest is the app's config (GET and PATCH /api/v1/apps/:id/config).
   While any card holds unsaved edits, closing the tab or following a link off the page asks first
   (the shared useLeaveGuard, as on the Settings page). */

/** image and branch change what the app runs; the rest is how it runs. */
type BuildDraft = { builder: string; installCommand: string; buildCommand: string; startCommand: string; dockerfilePath: string; port: string; image: string; branch: string };

const BUILDER_OPTIONS: Array<{ value: "auto" | "dockerfile" | "railpack"; label: string; hint: string }> = [
  { value: "auto", label: "Automatic", hint: "The repository’s Dockerfile when it has one, else Railpack" },
  { value: "dockerfile", label: "Dockerfile", hint: "Fails when there is none" },
  { value: "railpack", label: "Railpack", hint: "Ignores any Dockerfile" },
];

/** The port each service image listens on, as the placeholder; an app built here defaults to 3000. */
const PORT_HINT: Partial<Record<AppDetail["kind"], string>> = { postgres: "5432", redis: "6379", s3: "9000" };

const toBuild = (app: AppDetail, settings: AppSettings = app.settings): BuildDraft => ({
  builder: settings.builder ?? "auto",
  installCommand: settings.installCommand ?? "",
  buildCommand: settings.buildCommand,
  startCommand: settings.startCommand,
  dockerfilePath: settings.dockerfilePath,
  port: settings.port === null ? "" : String(settings.port),
  image: app.image ?? "",
  branch: app.branch ?? "",
});

function buildErrors(d: BuildDraft, source: AppSource) {
  const e: Partial<Record<keyof BuildDraft, string>> = {};
  const port = d.port.trim();
  const file = d.dockerfilePath.trim();
  if (port && !(/^\d+$/.test(port) && +port >= 1 && +port <= 65535)) e.port = "A whole number from 1 to 65535";
  if (file && (file.startsWith("/") || file.includes(".."))) e.dockerfilePath = "A path inside the repository";
  if (source === "image" && !IMAGE_REF.test(d.image.trim())) e.image = "An image reference, like ghcr.io/acme/web:1.2";
  if (source === "git" && d.branch.trim() && !BRANCH_NAME.test(d.branch.trim())) e.branch = BRANCH_MESSAGE;
  return e;
}

/**
 * On Vercel the branch is the one build setting that still acts: a deploy target asks Vercel to build
 * it, and the mirror uses it to place a preview when several apps link one project.
 */
function VercelBranchSection({ app, mode, multiEnv, onDirty }: { app: AppDetail; mode: "follow" | "deploy" | undefined; multiEnv: boolean; onDirty?: DirtyReport }) {
  const router = useRouter();
  const can = useCan();
  const saved = app.branch ?? "";
  const [base, setBase] = useState(saved);
  const [branch, setBranch] = useState(saved);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const value = branch.trim();
  const error = value && !BRANCH_NAME.test(value) ? BRANCH_MESSAGE : null;
  const dirty = value !== base;
  useReportDirty(dirty, onDirty);

  const save = async () => {
    setTried(true);
    if (!can.manage || error || busy) return;
    setBusy(true);
    const r = report(await mutate({ type: "app.settings", id: app.id, settings: app.settings, source: { branch: value || null } }), {
      success: "Branch saved",
      error: "Could not save the branch",
      what: `${app.projectSlug} / ${appTitle(app)}`,
    });
    setBusy(false);
    if (!r.ok) return;
    setTried(false);
    setBase(value);
    // The page still holds the old branch; reading it again keeps the field right after a tab switch.
    router.refresh();
  };

  return (
    <TabCard id="at-build-title" icon="code" title="Branch" sub={mode === "deploy" ? "What Vercel builds when you press Deploy" : "Which previews show here when several apps link one Vercel project"}>
      <form
        className="pd-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Branch" error={tried ? error : null} hint={multiEnv ? `Leave empty to follow the ${envName(app.environment)} environment’s branch.` : "Leave empty to follow the project’s branch."}>
          {(ids) => <TextInput ids={ids} className="pd-mono" value={branch} placeholder="main" spellCheck={false} readOnly={!can.manage} onChange={(e) => setBranch(e.target.value)} />}
        </Field>
        <SaveRow
          dirty={dirty}
          busy={busy}
          onDiscard={() => {
            setBranch(base);
            setTried(false);
          }}
        />
      </form>
    </TabCard>
  );
}

function BuildSection({ app, multiEnv, onSaved, onDirty }: { app: AppDetail; multiEnv: boolean; onSaved: (s: AppSettings) => void; onDirty?: DirtyReport }) {
  const router = useRouter();
  const can = useCan();
  const [draft, setDraft] = useState(() => toBuild(app));
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  // The image and branch a save just stored. The page's own copy is older until it is read again,
  // and the form must compare against what the server holds, or it reads unsaved.
  const [stored, setStored] = useState<{ from: string; image: string; branch: string } | null>(null);
  const served = `${app.image ?? ""}|${app.branch ?? ""}`;
  const source = sourceOf(app);
  const errs = buildErrors(draft, source);
  const err = (k: keyof BuildDraft) => (tried ? (errs[k] ?? null) : null);
  const base = { ...toBuild(app), ...(stored?.from === served ? { image: stored.image, branch: stored.branch } : {}) };
  const dirty = (Object.keys(draft) as Array<keyof BuildDraft>).some((k) => draft[k].trim() !== base[k]);
  useReportDirty(dirty, onDirty);
  const managed = source === "managed";
  const set = (k: keyof BuildDraft) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  const save = async () => {
    setTried(true);
    if (!can.manage || Object.keys(errs).length || busy) return;
    const settings: AppSettings = {
      ...app.settings,
      ...(source === "git" ? { builder: draft.builder as NonNullable<AppSettings["builder"]>, installCommand: draft.installCommand.trim(), buildCommand: draft.buildCommand.trim() } : {}),
      startCommand: draft.startCommand.trim(),
      dockerfilePath: draft.dockerfilePath.trim(),
      port: draft.port.trim() ? Number(draft.port) : null,
    };
    // Only a changed source is sent: an image app's image, a git app's branch (blank follows the environment's).
    const image = draft.image.trim();
    const branch = draft.branch.trim();
    const sourcePatch =
      source === "image" && image !== base.image ? { image } : source === "git" && branch !== base.branch ? { branch: branch || null } : undefined;
    setBusy(true);
    const r = report(await mutate({ type: "app.settings", id: app.id, settings, ...(sourcePatch ? { source: sourcePatch } : {}) }), {
      success: "Settings saved",
      error: "Could not save settings",
      what: `${app.projectSlug} / ${appTitle(app)}, applies on the next deploy`,
    });
    setBusy(false);
    if (!r.ok) return;
    setTried(false);
    setDraft({ ...toBuild(app, settings), image, branch });
    setStored({ from: served, image, branch });
    onSaved(settings);
    // The settings ride in the page's override; the source does not, so the page reads it again.
    if (sourcePatch) router.refresh();
  };

  return (
    <TabCard
      id="at-build-title"
      icon="code"
      title={managed ? "Service" : "Build and run"}
      sub={
        managed
          ? `${app.image ? `Runs ${app.image}` : `Managed ${KIND_LABEL[app.kind]}`}, there is no build step`
          : source === "git"
            ? "Built from the repository. Changes apply on the next deploy."
            : "Runs a published image. Changes apply on the next deploy."
      }
    >
      <form
        className="pd-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {source === "image" ? (
          <Field label="Image" error={err("image")} hint="Pulled again and pinned by digest on the next deploy.">
            {(ids) => <TextInput ids={ids} className="pd-mono" value={draft.image} placeholder="ghcr.io/acme/web:1.2" spellCheck={false} readOnly={!can.manage} onChange={set("image")} />}
          </Field>
        ) : null}
        {source === "git" ? (
          <>
            <Field label="Branch" error={err("branch")} hint={multiEnv ? `Leave empty to follow the ${envName(app.environment)} environment’s branch.` : "Leave empty to follow the project’s branch."}>
              {(ids) => <TextInput ids={ids} className="pd-mono" value={draft.branch} placeholder="main" spellCheck={false} readOnly={!can.manage} onChange={set("branch")} />}
            </Field>
            <Field label="Builder" hint={BUILDER_OPTIONS.find((o) => o.value === draft.builder)?.hint}>
              {(ids) => <Select ids={ids} label="Builder" value={draft.builder as (typeof BUILDER_OPTIONS)[number]["value"]} disabled={!can.manage} onChange={(builder) => setDraft((d) => ({ ...d, builder }))} options={BUILDER_OPTIONS.map(({ value, label }) => ({ value, label }))} />}
            </Field>
            {draft.builder !== "railpack" ? (
              <Field label="Dockerfile path" error={err("dockerfilePath")} hint="Relative to the root directory, then the repository. Leave empty for Dockerfile.">
                {(ids) => <TextInput ids={ids} className="pd-mono" value={draft.dockerfilePath} placeholder="Dockerfile" spellCheck={false} readOnly={!can.manage} onChange={set("dockerfilePath")} />}
              </Field>
            ) : null}
            {draft.builder !== "dockerfile" ? (
              <>
                <Field label="Install command" hint={draft.builder === "auto" ? "Without a Dockerfile only. Blank uses what is detected." : "Blank uses what is detected."}>
                  {(ids) => <TextInput ids={ids} className="pd-mono" value={draft.installCommand} placeholder={can.manage ? "npm ci" : "Hidden"} spellCheck={false} readOnly={!can.manage} onChange={set("installCommand")} />}
                </Field>
                <Field label="Build command" hint={draft.builder === "auto" ? "Without a Dockerfile only. Blank uses what is detected." : "Blank uses what is detected."}>
                  {(ids) => <TextInput ids={ids} className="pd-mono" value={draft.buildCommand} placeholder={can.manage ? "npm run build" : "Hidden"} spellCheck={false} readOnly={!can.manage} onChange={set("buildCommand")} />}
                </Field>
              </>
            ) : null}
          </>
        ) : null}
        {managed ? null : (
          <Field label="Start command" error={err("startCommand")} hint={START_COMMAND_HINT}>
            {(ids) => <TextInput ids={ids} className="pd-mono" value={draft.startCommand} placeholder={can.manage ? "node server.js" : "Hidden"} spellCheck={false} readOnly={!can.manage} onChange={set("startCommand")} />}
          </Field>
        )}
        <div className="pd-pair">
          <Field label="Port" error={err("port")} hint={managed ? "The port the container listens on. Leave empty for the image default." : "The port the container listens on."}>
            {(ids) => <TextInput ids={ids} className="num" inputMode="numeric" value={draft.port} placeholder={PORT_HINT[app.kind] ?? "3000"} readOnly={!can.manage} onChange={set("port")} />}
          </Field>
        </div>
        <SaveRow
          dirty={dirty}
          busy={busy}
          onDiscard={() => {
            setDraft(base);
            setTried(false);
          }}
        />
      </form>
    </TabCard>
  );
}

/** The cards that report unsaved edits, by name. */
type CardKey = "name" | "build" | "health" | "limits" | "release" | "target";
const CARDS: CardKey[] = ["name", "build", "health", "limits", "release", "target"];

export function SettingsTab({
  app,
  multiEnv,
  now,
  onSaved,
  onRenamed,
  onDirty,
}: {
  app: AppDetail;
  /** Whether the project shows its environments (lib/environments.ts). */
  multiEnv: boolean;
  now: number;
  onSaved: (s: AppSettings) => void;
  /** A saved rename: the display name now shown (null shows the name). */
  onRenamed: (displayName: string | null) => void;
  /** Whether any card holds unsaved edits, for a page that switches tabs in place. */
  onDirty?: (dirty: boolean) => void;
}) {
  const router = useRouter();
  const can = useCan();
  const q = useAppTab<AppConfig>(app.id, "config");
  const [del, setDel] = useState(false);
  const [dirty, setDirty] = useState<Partial<Record<CardKey, boolean>>>({});
  const config = q.data;
  const setConfig = (next: AppConfig) => q.patch(() => next);
  // The fresh config first: saving the deploy target changes which cards apply at once.
  const target = config?.target ?? app.target;
  const hosted = target?.kind === "vercel";
  const branchAlone = hosted && sourceOf(app) === "git";

  // One stable reporter per card, so a card's effect runs only when its own edits change.
  const markDirty = useCallback((key: CardKey, d: boolean) => setDirty((m) => (Boolean(m[key]) === d ? m : { ...m, [key]: d })), []);
  const reporters = useMemo(() => Object.fromEntries(CARDS.map((k) => [k, (d: boolean) => markDirty(k, d)])) as Record<CardKey, DirtyReport>, [markDirty]);
  const anyDirty = Object.values(dirty).some(Boolean);
  const guard = useLeaveGuard(anyDirty);
  useEffect(() => {
    onDirty?.(anyDirty);
  }, [anyDirty, onDirty]);

  const remove = async () => {
    const r = report(await mutate({ type: "app.delete", id: app.id, confirm: app.name }), {
      success: "App deleted",
      error: "Could not delete the app",
      what: `${app.projectSlug} / ${appTitle(app)}`,
    });
    if (r.ok) router.push(`/projects/${app.projectSlug}`);
    return r.ok;
  };

  return (
    <div className="pd-stack">
      {/* Identity first, as on the project's settings. The Name card carries the tab's one note for a Viewer. */}
      <NameSection app={app} onRenamed={onRenamed} onDirty={reporters.name} />
      {!hosted ? <BuildSection app={app} multiEnv={multiEnv} onSaved={onSaved} onDirty={reporters.build} /> : branchAlone ? <VercelBranchSection app={app} mode={target?.mode} multiEnv={multiEnv} onDirty={reporters.build} /> : null}
      <IconCard target={{ target: "app", id: app.id }} name={appTitle(app)} where={`${app.projectSlug} / ${appTitle(app)}`} kind={app.kind} url={app.url} now={now} />
      {config ? (
        <>
          {hosted ? null : (
            <>
              <HealthSection app={app} config={config} onSaved={setConfig} onDirty={reporters.health} />
              <LimitsSection app={app} config={config} onSaved={setConfig} onDirty={reporters.limits} />
              {can.manage && (app.kind === "postgres" || app.kind === "redis") ? <VersionSection app={app} /> : null}
              {isManaged(app) ? null : <ReleaseSection app={app} config={config} onSaved={setConfig} onDirty={reporters.release} />}
            </>
          )}
          {config.target && config.vercel ? <TargetSection app={app} config={config} now={now} onSaved={setConfig} onDirty={reporters.target} /> : null}
        </>
      ) : (
        <TabCard id="at-cfg-title" icon={hosted ? "deploy" : "activity"} title={hosted ? "Deploy target" : "Health, limits and release"} sub="Loading this app’s runtime config">
          {q.loading ? (
            <SkelRows rows={4} height={56} template="minmax(0,1fr) minmax(0,1fr)" cols={[{ w: "50%", lines: 2 }, { w: "40%", lines: 2 }]} />
          ) : (
            <TabFailed error={q.error} onRetry={q.reload} what="This app’s runtime config" />
          )}
        </TabCard>
      )}
      {/* The shared DangerZone renders nothing for a Viewer, so its delete can only open for an admin. */}
      <DangerZone
        rows={[
          {
            title: "Delete app",
            body: hosted
              ? `Removes ${appTitle(app)} and its deployment list from Dockify. Nothing changes on Vercel, and project variables are kept.`
              : `Stops ${appTitle(app)}, removes its container and volumes, and detaches its domains. Project variables are kept, and its backups stay until you delete them on the Backups page.`,
            action: "Delete app",
            onAction: () => setDel(true),
          },
        ]}
      />
      <DeleteDialog
        open={del}
        onClose={() => setDel(false)}
        name={app.name}
        title={`Delete ${appTitle(app)}`}
        body={`This removes ${appTitle(app)} from ${app.projectSlug}${multiEnv ? ` / ${envName(app.environment)}` : ""}. It cannot be undone.`}
        action="Delete app"
        onConfirm={remove}
      />
      {guard}
    </div>
  );
}
