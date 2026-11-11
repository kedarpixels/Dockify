"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CardTitle } from "@/components/card-title";
import { IconCard } from "@/components/icons/icon-card";
import { EnvironmentsCard } from "@/components/project-extras/environments";
import { PreviewSettingsCard } from "@/components/project-extras/previews";
import { StatusPageCard } from "@/components/project-extras/status-page";
import { Callout } from "@/components/ui/callout";
import { Field, TextInput } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { report } from "@/lib/feedback";
import { plural } from "@/lib/format";
import type { ProjectDetail, ProjectExtras } from "@/lib/pages/project-detail";
import { useCan } from "@/lib/viewer";
import { useLeaveGuard } from "@/components/ui/leave-guard";
import { mutate, ToggleRow } from "./controls";
import { DangerZone, DeleteDialog } from "./shared";
import { hasUnsafeText, UNSAFE_TEXT_MESSAGE } from "@/lib/validation";

/* The cards after the first read the project extras, which load on the client; each shows its own loading and error state. */

const nameError = (name: string) => (!name ? "Enter a name" : name.length > 64 ? "Keep it under 64 characters" : hasUnsafeText(name) ? UNSAFE_TEXT_MESSAGE : null);

export function ProjectSettings({
  p,
  onSaved,
  extras,
  extrasLoading,
  extrasError,
  now,
  onPatch,
  onOpenPreviews,
  onReload,
  onDirty,
}: {
  p: ProjectDetail;
  onSaved: (next: ProjectDetail) => void;
  extras: ProjectExtras | null;
  extrasLoading: boolean;
  extrasError?: string;
  now: number;
  onPatch: (fn: (d: ProjectExtras) => ProjectExtras) => void;
  onOpenPreviews: () => void;
  /** Reloads the extras, for answers the page cannot merge (a DNS check, an environment added or removed). */
  onReload?: () => void;
  onDirty?: (dirty: boolean) => void;
}) {
  const router = useRouter();
  const can = useCan();
  const [name, setName] = useState(p.name);
  const [autoDeploy, setAutoDeploy] = useState(p.autoDeploy);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [del, setDel] = useState(false);

  const nameErr = nameError(name.trim());
  const dirty = name.trim() !== p.name || autoDeploy !== p.autoDeploy;
  const invalid = Boolean(nameErr);
  const guard = useLeaveGuard(dirty);
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);

  const reset = (from: ProjectDetail) => {
    setName(from.name);
    setAutoDeploy(from.autoDeploy);
    setTried(false);
  };

  const save = async () => {
    setTried(true);
    if (invalid || busy || !can.manage) return;
    setBusy(true);
    // Branches are saved per environment in the Environments card, so this card never sends them.
    const patch = { name: name.trim(), autoDeploy };
    const r = report(await mutate({ type: "project.patch", slug: p.slug, patch }), { success: "Settings saved", error: "Could not save settings", what: p.slug });
    setBusy(false);
    if (!r.ok) return;
    const next = { ...p, ...patch };
    // The form takes the trimmed values it saved, so it reads clean again.
    reset(next);
    onSaved(next);
  };

  const remove = async () => {
    const r = report(await mutate({ type: "project.delete", slug: p.slug, confirm: p.slug }), {
      success: "Project deleted",
      error: "Could not delete the project",
      what: `${p.slug}, ${plural(p.apps.length, "app")}`,
    });
    if (r.ok) router.push("/projects");
    return r.ok;
  };

  return (
    <div className="pd-stack">
      <section className="card" aria-labelledby="pd-set-title">
        <div className="card-hd">
          <CardTitle id="pd-set-title" icon="settings" title="Name and auto-deploy" sub="The status page title and when pushes deploy" />
        </div>
        <form
          className="pd-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {can.manage ? null : <Callout tone="info">Only an admin can change these settings.</Callout>}
          <Field label="Name" error={tried ? nameErr : null} hint={`Titles the public status page. The dashboard and its links use the slug, ${p.slug}, which stays the same.`}>
            {(ids) => <TextInput ids={ids} value={name} maxLength={80} readOnly={!can.manage} onChange={(e) => setName(e.target.value)} />}
          </Field>

          <ToggleRow
            title="Auto-deploy"
            body="Build and deploy on every push to an app’s branch. Off means deploys run only when started by hand."
            checked={autoDeploy}
            onChange={setAutoDeploy}
            disabled={!can.manage}
          />

          {can.manage ? (
            <div className="pd-form-ft">
              <button type="button" className="btn" disabled={!dirty || busy} onClick={() => reset(p)}>
                Discard
              </button>
              <PendingButton type="submit" className="btn" pending={busy} disabled={!dirty}>
                Save changes
              </PendingButton>
            </div>
          ) : null}
        </form>
        {guard}
      </section>

      <IconCard target={{ target: "project", slug: p.slug }} name={p.slug} where={p.slug} now={now} />

      <EnvironmentsCard p={p} previews={extras?.previews?.settings ?? null} onChange={onSaved} onOpenPreviews={onOpenPreviews} onReload={onReload} />

      <PreviewSettingsCard
        p={p}
        state={extras?.previews ?? null}
        error={extras?.previewsError ?? extrasError}
        loading={extrasLoading}
        now={now}
        onSaved={(settings) => onPatch((d) => ({ ...d, previews: d.previews && { ...d.previews, settings } }))}
        onReload={onReload}
      />

      <StatusPageCard
        slug={p.slug}
        state={extras?.statusPage ?? null}
        error={extras?.statusPageError ?? extrasError}
        loading={extrasLoading}
        onChange={(statusPage) => onPatch((d) => ({ ...d, statusPage }))}
      />

      <DangerZone
        rows={[
          {
            title: "Delete project",
            body: `Stops and removes ${plural(p.apps.length, "app")}, their volumes, ${plural(p.domains.length, "domain")} and every variable. Database backups stay until you delete them on the Backups page.`,
            action: "Delete project",
            onAction: () => setDel(true),
          },
        ]}
      />

      <DeleteDialog
        open={del}
        onClose={() => setDel(false)}
        name={p.slug}
        title={`Delete ${p.slug}`}
        body="This removes the project and everything it runs. It cannot be undone."
        action="Delete project"
        onConfirm={remove}
      />
    </div>
  );
}
