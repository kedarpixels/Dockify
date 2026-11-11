import { describe, expect, it } from "vitest";
import { auth as A } from "@dockify/contracts";
import { planSettings, toSettings } from "./settings.ts";

// The settings patch is partial on purpose: the dashboard sends one section's changed fields, and
// everything left out must stay as stored. These pin that, and why a whole-object save was wrong.
const ORIGIN = "https://dash.example.com";
const row = {
  name: "Dockify",
  publicUrl: ORIGIN,
  defaultBranch: "main",
  buildConcurrency: 1,
  logRetentionDays: 14,
  notifyEvents: A.DEFAULT_NOTIFY,
  previewDomain: null,
  terminalEnabled: true,
};

describe("settings patch", () => {
  it("a notifications save writes the events and nothing else", () => {
    const flipped = !A.DEFAULT_NOTIFY.appDown;
    const p = planSettings(row, { notifications: { events: { appDown: flipped } } }, ORIGIN);
    expect(Object.keys(p.data)).toEqual(["notifyEvents"]);
    expect(p.changes.map((c) => c.key)).toEqual(["notify.appDown"]);
    expect(p.data.previewDomain).toBeUndefined();
  });

  it("an event that was not sent keeps its stored value", () => {
    const stored = { ...row, notifyEvents: { ...A.DEFAULT_NOTIFY, jobFailed: !A.DEFAULT_NOTIFY.jobFailed } };
    const p = planSettings(stored, { notifications: { events: { appDown: !A.DEFAULT_NOTIFY.appDown } } }, ORIGIN);
    expect((p.data.notifyEvents as Record<string, boolean>).jobFailed).toBe(!A.DEFAULT_NOTIFY.jobFailed);
  });

  it("the derived preview domain sent back as a value is stored as a custom one, so a save must not send it", () => {
    const shown = toSettings(row);
    expect(shown.previewDomainCustom).toBe(false);
    expect(shown.previewDomain).toBe(shown.previewDomainDefault);
    const p = planSettings(row, { previewDomain: shown.previewDomain }, ORIGIN);
    expect(p.data.previewDomain).toBe(shown.previewDomain);
    expect(planSettings(row, {}, ORIGIN).changes).toEqual([]);
  });
});
