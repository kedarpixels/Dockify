"use client";

import { useEffect, useState } from "react";
import { saveSettings } from "@/app/(console)/settings/actions";
import { report } from "@/lib/feedback";
import type { InstanceSettings } from "@/lib/pages/activity-settings";
import { settle } from "./form";
import type { SectionProps } from "./settings-view";

/* A draft of the instance settings object, shared by Notifications and Instance. */

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Both sections edit one settings object, so a save in either changes the other's saved copy;
 * a draft without edits follows it, a draft with edits keeps them.
 */
export function useSettingsDraft<T>(pick: (s: InstanceSettings) => T, merge: (s: InstanceSettings, d: T) => InstanceSettings, { data, update, onDirty, preview, elevate }: SectionProps) {
  const saved = pick(data.settings);
  const [base, setBase] = useState<T>(saved);
  const [draft, setDraft] = useState<T>(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!same(base, saved)) {
    setBase(saved);
    if (same(draft, base)) setDraft(saved);
  }
  const dirty = !same(draft, saved);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  // Validation stays on the bar, and only while something is still wrong; the write is a toast.
  const save = async (valid: boolean, okText: string, what: string) => {
    if (!valid) return setError("Fix the highlighted fields first");
    setError(null);
    setSaving(true);
    const sent = draft;
    const res = report(await settle(elevate(() => saveSettings(merge(data.settings, sent)), { what: "Changing settings" })), { success: okText, error: "Could not save", what, preview });
    setSaving(false);
    if (!res.ok) return;
    update({ settings: res.data });
    // Edits typed while the save ran stay; otherwise the draft takes the stored values.
    setDraft((d) => (same(d, sent) ? pick(res.data) : d));
  };
  const discard = () => {
    setDraft(saved);
    setError(null);
  };
  return { draft, setDraft, dirty, saving, error, save, discard };
}
