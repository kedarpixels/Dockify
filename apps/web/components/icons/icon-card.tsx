"use client";

import { useRef, useState } from "react";
import { CardTitle } from "@/components/card-title";
import { Icon } from "@/components/icon";
import { KIND_LABEL } from "@/components/project-detail/shared";
import { PendingButton } from "@/components/ui/pending";
import { When } from "@/components/ui/when";
import { report } from "@/lib/feedback";
import type { IconBody, IconState, IconTarget } from "@/lib/icons";
import type { AppKind } from "@/lib/types";
import { useCan } from "@/lib/viewer";
import { AppIcon, ProjectIcon, useIcons } from "./app-icon";
import { prepareUpload, sendIcon } from "./upload";

/*
 * The Icon card in app and project settings: what shows now, Automatic (a frontend's favicon or
 * the kind's default; for a project, its frontend's favicon or the folder), an upload, and Reset.
 * Each action saves at once; a refused upload says why under the card.
 */

type Busy = "auto" | "upload" | null;

function hostOf(url: string | null) {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** The muted line under the current icon. It names the kind as every other page does ("Backend", "Storage"), not the preset. */
function statusLine(state: IconState | undefined, kind: AppKind | undefined, domain: string | null, now: number): React.ReactNode {
  if (state?.choice === "upload") return state.image ? `Uploaded image, ${state.image.width} by ${state.image.height}` : "Uploaded image";
  const fav = state?.favicon;
  if (!kind) {
    const host = hostOf(fav?.origin ?? null);
    return state?.image && host ? `Favicon of ${host}, from this project’s frontend` : "The project folder, until a frontend has a favicon";
  }
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
  /** Apps only; a project has no kind. */
  kind?: AppKind;
  /** The app's primary URL, for the favicon line. */
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
          <span className="two">
            <span className="two-main">{choice === "auto" ? "Automatic" : "Uploaded"}</span>
            <span className="two-sub">{statusLine(state, kind, domain, now)}</span>
          </span>
          <span className="ic-now-acts">
            {can.manage && choice === "auto" && frontend && domain ? (
              <PendingButton className="btn btn-sm" pending={busy === "auto"} disabled={busy !== null} onClick={() => auto("Fetching the favicon")}>
                Fetch again
              </PendingButton>
            ) : null}
            {can.manage && choice !== "auto" ? (
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
    </section>
  );
}
