"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { GroupHead } from "@/components/ui/group-head";
import { Callout } from "@/components/ui/callout";
import { envName } from "@/components/ui/env-tag";
import { Secret } from "@/components/ui/secret";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { showsEnvironments } from "@/lib/environments";
import { describe, errText } from "@/lib/feedback";
import { isStepUpCancel } from "@/lib/step-up";
import type { VercelImportInput, VercelImportResult, VercelProject, VercelTarget } from "@/lib/pages/integrations";
import { plural } from "@/lib/format";
import { FormKeys } from "./card";
import { intFetch, listing } from "./client";
import { useStepUp } from "@/components/step-up/step-up";

/*
 * Import one Vercel project's variables and domains into a Dockify environment: pick where they
 * land and which Vercel environment they come from, look over what moves (values stay masked, the
 * browser never holds them), then confirm.
 */

/** A Dockify project and its environments, the places an import can land. */
export interface ImportTarget {
  slug: string;
  environments: string[];
}

const TARGETS: Array<{ value: VercelTarget; label: string }> = [
  { value: "production", label: "Production" },
  { value: "preview", label: "Preview" },
  { value: "development", label: "Development" },
];

/** Production pairs with production; any other Dockify environment reads Vercel's preview set. */
const targetFor = (environment: string): VercelTarget => (environment === "production" ? "production" : "preview");

/** "inkwell-web" lands in "inkwell" when that project exists. */
function guessProject(name: string, targets: ImportTarget[]) {
  const lower = name.toLowerCase();
  return targets.find((t) => lower === t.slug || lower.startsWith(`${t.slug}-`))?.slug ?? targets[0]?.slug ?? null;
}

export function VercelImportDialog({
  project,
  targets,
  onClose,
  preview,
}: {
  project: VercelProject | null;
  targets: ImportTarget[];
  onClose: () => void;
  preview: boolean;
}) {
  const { elevate } = useStepUp();
  const router = useRouter();
  const [shownFor, setShownFor] = useState<string | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<string | null>(null);
  const [target, setTarget] = useState<VercelTarget>("production");
  const [busy, setBusy] = useState(false);

  // A fresh pick every time a project opens, guessed from its name.
  if (!project && shownFor !== null) setShownFor(null);
  if (project && project.id !== shownFor) {
    setShownFor(project.id);
    const s = guessProject(project.name, targets);
    const envs = targets.find((t) => t.slug === s)?.environments ?? [];
    const e = envs.includes("production") ? "production" : (envs[0] ?? null);
    setSlug(s);
    setEnvironment(e);
    setTarget(targetFor(e ?? "production"));
  }

  const envs = targets.find((t) => t.slug === slug)?.environments ?? [];
  const vars = project ? project.env.filter((v) => v.targets.includes(target)) : [];
  // The API leaves out Vercel's own addresses; the list says what will really move.
  const domains = (project?.domains ?? []).filter((d) => !d.endsWith(".vercel.app"));
  const ready = Boolean(project && slug && environment && (vars.length || domains.length));

  const pickProject = (s: string) => {
    setSlug(s);
    const next = targets.find((t) => t.slug === s)?.environments ?? [];
    const e = environment && next.includes(environment) ? environment : next.includes("production") ? "production" : (next[0] ?? null);
    setEnvironment(e);
    if (e) setTarget(targetFor(e));
  };

  const run = async () => {
    if (!project || !slug || !environment || busy) return;
    const input: VercelImportInput = { vercelProjectId: project.id, project: slug, environment, target };
    const where = showsEnvironments(envs) ? `${slug} / ${envName(environment)}` : slug;
    setBusy(true);
    const r = await elevate(() => intFetch<VercelImportResult>("/vercel/import", { method: "POST", body: input }), { what: "Importing from Vercel" });
    setBusy(false);
    // Closing "Confirm it is you" is no failure: nothing to report, and the dialog stays open.
    if (isStepUpCancel(r)) return;
    if (!r.ok) {
      // The toast says why; the dialog stays open for another try.
      toast.error("Could not import from Vercel", { description: errText(r.error) });
      return;
    }
    const moved = listing([r.data.variables ? plural(r.data.variables, "variable") : "", r.data.domains ? plural(r.data.domains, "domain") : ""].filter(Boolean));
    toast.success("Imported from Vercel", {
      description: describe([moved ? `${moved} into ${where}` : `Nothing new for ${where}`, r.data.domainsSkipped ? `${plural(r.data.domainsSkipped, "domain")} not added: this environment has no single app to hold them` : ""].filter(Boolean), { preview }),
      action: { label: "View", onClick: () => router.push(`/projects/${encodeURIComponent(slug)}`) },
    });
    onClose();
  };

  return (
    <Dialog
      open={project !== null}
      onClose={onClose}
      title="Import variables and domains"
      sub={project ? `From ${project.name} on Vercel` : undefined}
      icon="download"
      size="lg"
      busy={busy}
      onSubmit={() => void run()}
      footer={
        <FormKeys onCancel={onClose} busy={busy} disabled={!ready} icon="download">
          Import
        </FormKeys>
      }
    >
      {!targets.length ? (
        <Callout tone="warn" icon="alert">
          Create the project in Dockify first, then import into one of its environments.
        </Callout>
      ) : null}
      <div className="int-form-grid int-form-grid-3">
        <Field label="Dockify project">
          {(ids) => (
            <Select
              ids={ids}
              label="Dockify project"
              value={slug}
              placeholder="Pick a project"
              onChange={pickProject}
              options={targets.map((t) => ({ value: t.slug, label: t.slug, icon: "folder" as const }))}
              disabled={!targets.length}
            />
          )}
        </Field>
        {showsEnvironments(envs) ? (
          <Field label="Environment">
            {(ids) => (
              <Select
                ids={ids}
                label="Environment"
                value={environment}
                placeholder="Pick an environment"
                onChange={(e) => {
                  setEnvironment(e);
                  setTarget(targetFor(e));
                }}
                options={envs.map((e) => ({ value: e, label: envName(e) }))}
                disabled={!envs.length}
              />
            )}
          </Field>
        ) : null}
        <Field label="From Vercel">
          {(ids) => <Select ids={ids} label="Vercel environment" value={target} onChange={setTarget} options={TARGETS} />}
        </Field>
      </div>

      <section className="int-preview" aria-label="What will be imported">
        <GroupHead label="Variables" icon="key" count={vars.length} noun="variable" />
        {vars.length ? (
          <ul className="int-preview-list">
            {vars.map((v) => (
              <li key={`${v.key}:${v.targets.join(",")}`} className="int-preview-row">
                <span className="int-preview-key num">{v.key}</span>
                <Secret what={v.key} copy={false} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="int-preview-none none">No variables for {TARGETS.find((t) => t.value === target)?.label} on Vercel</p>
        )}
        <GroupHead label="Domains" icon="globe" count={domains.length} noun="domain" />
        {domains.length ? (
          <ul className="int-preview-list">
            {domains.map((d) => (
              <li key={d} className="int-preview-row">
                <span className="int-preview-key">{d}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="int-preview-none none">No custom domains on this project</p>
        )}
      </section>

      <span className="fld-note">Values are copied on the server and stay masked here. Variables with the same name are replaced, and domains wait for DNS to point at this server.</span>
    </Dialog>
  );
}
