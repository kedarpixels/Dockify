"use client";

import { useState } from "react";
import { Field, TextInput } from "@/components/ui/field";
import { mutate } from "@/components/project-detail/controls";
import { report } from "@/lib/feedback";
import { appTitle } from "@/lib/format";
import type { AppDetail } from "@/lib/pages/project-detail";
import { APP_DISPLAY_NAME_MAX, displayNameProblem } from "@/lib/validation";
import { useCan } from "@/lib/viewer";
import { ReadOnlyNote, SaveRow, useReportDirty, type DirtyReport } from "./settings-sections";
import { TabCard } from "./states";

/* The app's name as people read it: the dashboard, notifications, emails and pull request comments.
   It changes nothing else. The app's own name stays its identity for links between apps, the CLI,
   preview addresses and its containers, so the card says which name that is. An empty field, or the
   name itself, goes back to showing the name. The API refuses a name another app of the environment
   already shows or answers to; that refusal reads on the field. */

/** What a save sends: null shows the app's own name again. */
const stored = (value: string, name: string): string | null => (value === "" || value === name ? null : value);

export function NameSection({ app, onRenamed, onDirty }: { app: AppDetail; onRenamed: (displayName: string | null) => void; onDirty?: DirtyReport }) {
  const can = useCan();
  const saved = app.displayName ?? "";
  const [base, setBase] = useState(saved);
  const [value, setValue] = useState(saved);
  const [tried, setTried] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const v = value.trim();
  const problem = v ? displayNameProblem(v, { max: APP_DISPLAY_NAME_MAX }) : null;
  const dirty = v !== base;
  useReportDirty(dirty, onDirty);
  const error = refused ?? (tried ? problem : null);

  const save = async () => {
    setTried(true);
    if (!can.manage || problem || busy || !dirty) return;
    const next = stored(v, app.name);
    setBusy(true);
    const r = await mutate({ type: "app.rename", id: app.id, displayName: next });
    setBusy(false);
    // Taken by another app: said on the field, where the fix is typed.
    if (!r.ok && r.code === "NAME_TAKEN") {
      setRefused(r.error ?? "Another app in this environment already goes by that name");
      return;
    }
    report(r, { success: next === null ? "Name reset" : "App renamed", error: "Could not rename the app", what: `${app.projectSlug} / ${appTitle({ name: app.name, displayName: next })}` });
    if (!r.ok) return;
    const answered = r.data && typeof r.data === "object" && "name" in r.data ? ((r.data as AppDetail).displayName ?? null) : next;
    setTried(false);
    setBase(answered ?? "");
    setValue(answered ?? "");
    onRenamed(answered);
  };

  return (
    <TabCard id="at-name-title" icon="edit" title="Name" sub="What the dashboard, notifications and emails call this app">
      <form
        className="pd-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {/* The tab's one note for a Viewer: every card below is read-only for them. */}
        <ReadOnlyNote />
        <Field
          label="Display name"
          error={error}
          hint={
            <>
              Links between apps, the CLI and preview addresses keep using its name, <span className="pd-mono">{app.name}</span>, which stays the same.
            </>
          }
        >
          {(ids) => (
            <TextInput
              ids={ids}
              value={value}
              placeholder={app.name}
              maxLength={APP_DISPLAY_NAME_MAX + 20}
              spellCheck={false}
              autoComplete="off"
              readOnly={!can.manage}
              onChange={(e) => {
                setValue(e.target.value);
                setRefused(null);
              }}
            />
          )}
        </Field>
        <SaveRow
          dirty={dirty}
          busy={busy}
          onDiscard={() => {
            setValue(base);
            setTried(false);
            setRefused(null);
          }}
        />
      </form>
    </TabCard>
  );
}
