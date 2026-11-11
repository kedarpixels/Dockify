"use client";

import { useEffect, useState } from "react";
import { saveSettings } from "@/app/(console)/settings/actions";
import { report } from "@/lib/feedback";
import type { InstanceSettings } from "@/lib/pages/activity-settings";
import { settle } from "./form";
import { applyPatch, type SettingsPatch } from "./settings-patch";
import type { SectionProps } from "./settings-view";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A save in either section changes the other's saved copy: a draft without edits follows it, one with edits keeps them. */
export function useSettingsDraft<T>(pick: (s: InstanceSettings) => T, patch: (s: InstanceSettings, d: T) => SettingsPatch, { data, update, onDirty, preview, elevate }: SectionProps) {
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

  const save = async (valid: boolean, okText: string, what: string) => {
    if (!valid) return setError("Fix the highlighted fields first");
    setError(null);
    setSaving(true);
    const sent = draft;
    const change = patch(data.settings, sent);
    const res = report(await settle(elevate(() => saveSettings(change), { what: "Changing settings" })), { success: okText, error: "Could not save", what, preview });
    setSaving(false);
    if (!res.ok) return;
    // The API answers with the stored row; the preview stores nothing, so the patch is applied here.
    const stored = res.data ?? applyPatch(data.settings, change);
    update({ settings: stored });
    // Edits typed while the save ran stay; otherwise the draft takes the stored values.
    setDraft((d) => (same(d, sent) ? pick(stored) : d));
  };
  const discard = () => {
    setDraft(saved);
    setError(null);
  };
  return { draft, setDraft, dirty, saving, error, save, discard };
}
