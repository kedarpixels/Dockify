import { describe, expect, it } from "vitest";
import { CHECK_EVERY_MS, decideAuto, DEFAULT_WINDOW, inWindow, localClock, nextCheckAt, nextWindowOpen, type UpdatePolicy } from "./policy.ts";
import { chooseRelease } from "./release.ts";
import { release } from "./test-fixtures.ts";

const policy = (over: Partial<UpdatePolicy> = {}): UpdatePolicy => ({ mode: "all", window: DEFAULT_WINDOW, timeZone: "Etc/UTC", skipVersion: null, pausedUntil: null, ...over });
const at = (iso: string) => new Date(iso);
// 2026-11-02 is a Monday.
const MON_0400 = at("2026-11-02T04:00:00Z");
const MON_1200 = at("2026-11-02T12:00:00Z");

describe("the maintenance window", () => {
  it("is open between start and end on the listed days, in the instance time zone", () => {
    expect(inWindow(MON_0400, DEFAULT_WINDOW, "Etc/UTC")).toBe(true);
    expect(inWindow(at("2026-11-02T05:00:00Z"), DEFAULT_WINDOW, "Etc/UTC")).toBe(false);
    expect(inWindow(at("2026-11-02T02:59:00Z"), DEFAULT_WINDOW, "Etc/UTC")).toBe(false);
    // 04:00 UTC is 05:00 in Berlin (CET): outside 03:00 to 05:00 there.
    expect(inWindow(MON_0400, DEFAULT_WINDOW, "Europe/Berlin")).toBe(false);
    expect(inWindow(at("2026-11-02T02:30:00Z"), DEFAULT_WINDOW, "Europe/Berlin")).toBe(true);
    expect(localClock(MON_0400, "America/New_York")).toEqual({ day: 0, minute: 23 * 60 });
  });

  it("honours the days, and a window past midnight belongs to the day it opens", () => {
    const sat = { days: [6], start: "22:00", end: "02:00" };
    expect(inWindow(at("2026-11-07T23:00:00Z"), sat, "Etc/UTC")).toBe(true); // Saturday night
    expect(inWindow(at("2026-11-08T01:30:00Z"), sat, "Etc/UTC")).toBe(true); // early Sunday, opened Saturday
    expect(inWindow(at("2026-11-08T23:00:00Z"), sat, "Etc/UTC")).toBe(false); // Sunday night
    expect(inWindow(at("2026-11-02T01:00:00Z"), sat, "Etc/UTC")).toBe(false); // Monday early
  });

  it("any time is always open; no days is never open", () => {
    expect(inWindow(MON_1200, null, "Etc/UTC")).toBe(true);
    expect(inWindow(MON_1200, { days: [], start: "00:00", end: "23:59" }, "Etc/UTC")).toBe(false);
    expect(nextWindowOpen(MON_1200, { days: [], start: "00:00", end: "23:59" }, "Etc/UTC")).toBeNull();
  });

  it("finds the next opening", () => {
    expect(nextWindowOpen(MON_1200, DEFAULT_WINDOW, "Etc/UTC")?.toISOString()).toBe("2026-11-03T03:00:00.000Z");
    const weekend = { days: [0, 6], start: "03:00", end: "05:00" };
    expect(nextWindowOpen(MON_1200, weekend, "Etc/UTC")?.toISOString()).toBe("2026-11-07T03:00:00.000Z");
    expect(nextWindowOpen(MON_0400, DEFAULT_WINDOW, "Etc/UTC")).toEqual(MON_0400);
  });
});

describe("decideAuto: the policies", () => {
  const plain = chooseRelease({ releases: [release("1.1.0")] }, "1.0.0");
  const critical = chooseRelease({ releases: [release("1.1.0", { critical: true })] }, "1.0.0");
  const none = chooseRelease({ releases: [release("1.0.0")] }, "1.0.0");

  it("all stable releases: installs in the window, waits outside it", () => {
    expect(decideAuto(MON_0400, policy(), plain).action).toBe("install");
    const d = decideAuto(MON_1200, policy(), plain);
    expect(d).toMatchObject({ action: "wait", reason: "outside the maintenance window" });
    expect(d.action === "wait" && d.until?.toISOString()).toBe("2026-11-03T03:00:00.000Z");
  });

  it("security only: a regular release only notifies, a critical one installs in the next window", () => {
    expect(decideAuto(MON_0400, policy({ mode: "security" }), plain).action).toBe("notify");
    expect(decideAuto(MON_0400, policy({ mode: "security" }), critical)).toMatchObject({ action: "install", reason: "critical security release" });
    expect(decideAuto(MON_1200, policy({ mode: "security" }), critical).action).toBe("wait");
  });

  it("a critical fix anywhere on the path counts, even when the target itself is not flagged", () => {
    const path = chooseRelease({ releases: [release("1.2.0"), release("1.1.0", { critical: true })] }, "1.0.0");
    expect(path.critical).toBe(true);
    expect(decideAuto(MON_0400, policy({ mode: "security" }), path).action).toBe("install");
  });

  it("manual: notify only, even for a critical release", () => {
    expect(decideAuto(MON_0400, policy({ mode: "manual" }), critical).action).toBe("notify");
  });

  it("skip this version and pause for 7 days hold back automatic installs", () => {
    expect(decideAuto(MON_0400, policy({ skipVersion: "v1.1.0" }), plain).action).toBe("none");
    expect(decideAuto(MON_0400, policy({ skipVersion: "1.0.5" }), plain).action).toBe("install");
    const paused = decideAuto(MON_0400, policy({ pausedUntil: at("2026-11-09T04:00:00Z") }), critical);
    expect(paused).toMatchObject({ action: "wait", reason: "automatic updates are paused" });
    expect(decideAuto(at("2026-11-10T04:00:00Z"), policy({ pausedUntil: at("2026-11-09T04:00:00Z") }), plain).action).toBe("install");
  });

  it("nothing newer: nothing to do", () => {
    expect(decideAuto(MON_0400, policy(), none).action).toBe("none");
  });
});

describe("the check cadence", () => {
  it("is every 6 hours plus up to an hour of jitter", () => {
    expect(nextCheckAt(MON_0400, () => 0).getTime() - MON_0400.getTime()).toBe(CHECK_EVERY_MS);
    const late = nextCheckAt(MON_0400, () => 0.999).getTime() - MON_0400.getTime();
    expect(late).toBeGreaterThan(CHECK_EVERY_MS + 59 * 60_000);
    expect(late).toBeLessThan(CHECK_EVERY_MS + 3_600_000);
  });
});
