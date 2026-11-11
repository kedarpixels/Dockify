"use client";

import { useRef, useState } from "react";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { KIND_LABEL } from "@/components/project-detail/shared";
import { ConfirmDialog } from "@/components/ui/dialog";
import { PendingButton } from "@/components/ui/pending";
import { Select, type SelectOption } from "@/components/ui/select";
import { When } from "@/components/ui/when";
import { report } from "@/lib/feedback";
import { PROJECT_FOLDER as FOLDER, PROJECT_UPLOAD as UPLOADED, projectIconLine, projectIconPick, type IconBody, type IconState, type IconTarget } from "@/lib/icons";
import type { AppKind } from "@/lib/types";
import { useCan } from "@/lib/viewer";
import { AppIcon, ProjectIcon, useIcons } from "./app-icon";
import { prepareUpload, sendIcon } from "./upload";

/* Each action saves at once; a refused upload says why under the card. */

type Busy = "auto" | "pick" | "upload" | null;

function hostOf(url: string | null) {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Names the kind as every other page does ("Backend", "Storage"), not the preset. */
function statusLine(state: IconState | undefined, kind: AppKind | undefined, domain: string | null, now: number): React.ReactNode {
  if (state?.choice === "upload") return state.image ? `Uploaded image, ${state.image.width} by ${state.image.height}` : "Uploaded image";
  const fav = state?.favicon;
  if (!kind) return projectIconLine(state);
  if (kind !== "frontend") return `The ${KIND_LABEL[kind]} icon`;
  const from = hostOf(fav?.origin ?? null) ?? domain;
  if (state?.image && fav?.fetchedAt) {
    return <When iso={fav.fetchedAt} now={now} prefix={`Favicon from ${from ?? "its domain"}, fetched`} />;
  }
  if (fav?.error) return <span className="tone-warn">Last check found no favicon: {fav.error}</span>;
  return domain ? `The Frontend icon until a favicon is found. Dockify fetches it from ${domain} after each deploy.` : "The Frontend icon. Add a domain, and its favicon is fetched after the next deploy.";
}

export function IconCard({
  target,
  name,
  where,
  kind,
  url = null,
  now,
}: {
  target: IconTarget;
  name: string;
  /** "horseai / web" or "horseai", for the toasts. */
  where: string;
  kind?: AppKind;
  url?: string | null;
  now: number;
}) {
  const { map, set } = useIcons();
  const state = target.target === "app" ? map.apps[target.id] : map.projects[target.slug];
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  // Changing an icon is an admin's write (apps.icon.put, projects.icon.put): a Viewer sees the icon only.
  const can = useCan();
  const domain = hostOf(url);
  const choice = state?.choice ?? "auto";
  const frontend = kind === "frontend";

  // A ref, not `busy`: a second click can land before the re-render disables the keys.
  const inFlight = useRef(false);

  const save = async (body: IconBody, pending: Busy, success: string, localSrc?: string) => {
    setBusy(pending);
    setError(null);
    const r = report(await sendIcon(target, body), { success, error: "Could not change the icon", what: where });
    setBusy(null);
    const keep = r.ok && r.data && r.source === "preview" ? localSrc : undefined;
    if (localSrc && !keep) URL.revokeObjectURL(localSrc);
    if (!r.ok) setError(r.error ?? "Could not change the icon");
    else if (r.data) set(target, r.data, keep);
  };

  const run = async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await work();
    } finally {
      inFlight.current = false;
    }
  };

  const auto = (success: string) => void run(() => save({ choice: "auto" }, "auto", success));

  const project = target.target === "project";
  const { value: picked, apps } = projectIconPick(state);
  // The pick waiting on "remove the upload?", since leaving an upload deletes it as Reset does.
  const [leaving, setLeaving] = useState<string | null>(null);
  const appName = (id: string) => apps.find((a) => a.id === id)?.name ?? "the app";
  const sendPick = (value: string) =>
    run(() =>
      value === FOLDER
        ? save({ choice: "folder" }, "pick", "Icon set to the folder")
        : save({ choice: "app", appId: value }, "pick", `Icon set to the favicon of ${appName(value)}`),
    );
  const pick = (value: string) => {
    if (value === UPLOADED || value === picked) return;
    if (choice === "upload") setLeaving(value);
    else void sendPick(value);
  };
  const options: SelectOption<string>[] = project
    ? [
        ...(choice === "upload"
          ? [{ value: UPLOADED, label: "Uploaded image", hint: state?.image ? `${state.image.width} by ${state.image.height}` : undefined, glyph: <ProjectIcon slug={target.slug} /> }]
          : []),
        { value: FOLDER, label: "Folder", hint: "Default", glyph: <ProjectIcon /> },
        ...apps.map((a) => ({ value: a.id, label: a.name, hint: a.host ?? a.environment, glyph: <AppIcon id={a.id} kind="frontend" /> })),
      ]
    : [];

  const upload = (f: File) =>
    void run(async () => {
      setError(null);
      setBusy("upload");
      const prepared = await prepareUpload(f);
      if (!prepared.ok) {
        setBusy(null);
        setError(prepared.reason);
        return;
      }
      await save({ choice: "upload", image: prepared.base64 }, "upload", "Icon uploaded", URL.createObjectURL(prepared.blob));
    });

  const id = target.target === "app" ? `ic-${target.id}` : `ic-${target.slug}`;
  return (
    <section className="card" aria-labelledby={`${id}-title`}>
      <div className="card-hd">
        <CardTitle id={`${id}-title`} icon="image" title="Icon" sub={`How ${name} appears across the dashboard`} />
      </div>
      <div className="pd-form ic-card">
        <div className="pd-trow ic-now" aria-busy={busy !== null || undefined}>
          <span className="ic-now-face">
            {target.target === "app" ? <AppIcon id={target.id} kind={kind} size="lg" /> : <ProjectIcon slug={target.slug} size="lg" />}
            {busy ? (
              <span className="ic-now-busy" aria-hidden="true">
                <Icon name="loader" className="spin" />
              </span>
            ) : null}
          </span>
          {project ? (
            <span className="ic-pick">
              <Select label={`Icon of ${name}`} value={picked} options={options} onChange={pick} disabled={!can.manage || busy !== null} />
              <span className="two-sub">{statusLine(state, kind, domain, now)}</span>
            </span>
          ) : (
            <span className="two">
              <span className="two-main">{choice === "auto" ? "Automatic" : "Uploaded"}</span>
              <span className="two-sub">{statusLine(state, kind, domain, now)}</span>
            </span>
          )}
          <span className="ic-now-acts">
            {can.manage && choice === "auto" && frontend && domain ? (
              <PendingButton className="btn btn-sm" pending={busy === "auto"} disabled={busy !== null} onClick={() => auto("Fetching the favicon")}>
                Fetch again
              </PendingButton>
            ) : null}
            {can.manage && choice !== "auto" && !project ? (
              <PendingButton className="btn btn-sm" pending={busy === "auto"} disabled={busy !== null} onClick={() => auto("Icon reset")}>
                Reset
              </PendingButton>
            ) : null}
          </span>
        </div>

        {can.manage ? (
        <div className="ic-group">
          <span className="fld-label">Upload an image</span>
          <div className="ic-up">
            <PendingButton className="btn btn-sm btn-lead" pending={busy === "upload"} disabled={busy !== null} icon="upload" onClick={() => file.current?.click()}>
              Upload image
            </PendingButton>
            <p className="fld-note">PNG, JPG or WebP, up to 128 KB and at least 32 by 32 pixels. Other shapes are cropped to a centered square.</p>
          </div>
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="sr"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) upload(f);
            }}
          />
          {error ? (
            <p className="fld-note fld-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        ) : null}
      </div>
      {project ? (
        <ConfirmDialog
          open={leaving !== null}
          onClose={() => setLeaving(null)}
          title="Remove the uploaded image"
          sub={name}
          body={
            <p className="dlg-text">
              {leaving === FOLDER || leaving === null
                ? "The project shows the folder instead."
                : `The project shows the favicon of ${appName(leaving)} instead.`}{" "}
              The uploaded image is deleted; upload it again to bring it back.
            </p>
          }
          confirmLabel="Remove and switch"
          onConfirm={async () => {
            const value = leaving;
            if (value) await sendPick(value);
            setLeaving(null);
          }}
        />
      ) : null}
    </section>
  );
}
