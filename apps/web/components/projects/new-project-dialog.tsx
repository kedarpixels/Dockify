"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { mutate } from "@/components/project-detail/controls";
import { Callout } from "@/components/ui/callout";
import { Dialog } from "@/components/ui/dialog";
import { Field, TextInput } from "@/components/ui/field";
import { PendingButton } from "@/components/ui/pending";
import { report } from "@/lib/feedback";
import type { NewProjectInput } from "@/lib/pages/project-detail";
import type { OverviewSource } from "@/lib/types";
import { projectNameProblem } from "@/lib/validation";
import { useCan } from "@/lib/viewer";

/*
 * The New project popup, in one step: the name, then Create. It starts with one environment,
 * production, unsaid; more can be added in the project's settings. A project is only
 * the container for one product's apps, so it asks for no repository and no branch. Each app brings
 * its own source (a repository, a Git URL, an image or a database) through New app on the
 * project's page, which is where Create lands.
 */

type Key = "name";

/**
 * The shared Dialog over the current page: Cancel or the close key runs `onClose`, and a finished
 * create replaces the popup's history entry so Back returns to the page underneath. With no data
 * source it says so and Create stays off, since nothing could be created.
 */
export function NewProjectDialog({ source, taken, onClose }: { source: OverviewSource; taken: string[]; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState<Set<Key>>(() => new Set());
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const can = useCan();
  const offline = source === "none";

  const errors: Record<Key, string | null> = {
    name: projectNameProblem(name, taken),
  };
  // Nothing is prefilled, so a problem shows once its field is left or Create is pressed, never on open.
  const shown = (k: Key) => (tried || touched.has(k) ? errors[k] : null);
  const touch = (k: Key) => setTouched((t) => new Set(t).add(k));

  const submit = async () => {
    setTried(true);
    if (busy || offline || Object.values(errors).some(Boolean)) return;
    setBusy(true);
    const project: NewProjectInput = { name, environments: ["production"] };
    const r = await mutate({ type: "project.create", project });
    const created = r.data && typeof r.data === "object" && "slug" in r.data && typeof r.data.slug === "string" ? r.data.slug : name;
    const preview = r.source === "preview";
    report(r, {
      success: "Project created",
      error: "Could not create the project",
      what: created,
      // The preview created nothing, so its next place is the list, not a project that does not exist.
      action: preview ? { label: "View", onClick: () => router.push("/projects") } : undefined,
    });
    // A real create stays busy until the new project replaces this popup, so it cannot run twice.
    if (r.ok && !preview) {
      router.replace(`/projects/${created}`);
      return;
    }
    setBusy(false);
    if (r.ok) onClose();
  };

  // A Viewer can reach /projects/new by a link, but cannot create a project: the popup says so
  // instead of a form whose Create the API would refuse.
  if (!can.manage) {
    return (
      <Dialog
        open
        onClose={onClose}
        icon="folder"
        title="New project"
        sub="A project groups the apps and databases one product runs."
        footer={
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        }
      >
        <Callout icon="lock">Only an admin can create projects. Ask an admin of this server to add one.</Callout>
      </Dialog>
    );
  }

  // Cancel leaves without creating and closes over the page underneath. It waits while a create
  // runs, as the Dialog's own close keys do, so a running write always has a place to answer.
  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      icon="folder"
      title="New project"
      sub="A project groups the apps and databases one product runs."
      initialFocus={nameRef}
      onSubmit={() => void submit()}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <PendingButton type="submit" className="btn btn-primary" pending={busy} icon="plus" disabled={offline}>
            Create project
          </PendingButton>
        </>
      }
    >
      <div className="pj-new">
        <Field label="Project name" error={shown("name")} hint="Lowercase letters, numbers and hyphens. It becomes the slug in URLs, which cannot change later; the name itself can, in Settings.">
          {(ids) => (
            <TextInput
              ids={ids}
              ref={nameRef}
              autoComplete="off"
              spellCheck={false}
              placeholder="my-project"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").slice(0, 40))}
              onBlur={() => {
                setName((n) => n.replace(/^-+|-+$/g, ""));
                touch("name");
              }}
            />
          )}
        </Field>


        {offline ? (
          <Callout tone="bad" icon="alert" role="alert">
            No data source. Set DOCKIFY_API_URL for this dashboard before creating projects.
          </Callout>
        ) : null}
      </div>
    </Dialog>
  );
}
