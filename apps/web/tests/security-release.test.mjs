// The security release rules the console's banner and popup share (lib/security-release.ts).
// Run: npm test (Node 22.18+ strips the types of the imports).
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOSE_SNOOZE, compareVersions, dayLabel, isSnoozed, popupDue, readAlert, remindKey, snoozeChoices, updatePlan } from "../lib/security-release.ts";

const NOW = Date.parse("2026-11-06T10:00:00Z");
const release = { version: "0.9.2", level: "critical", summary: "A path check could read files.", advisory: "https://example.com/a", cves: ["CVE-2026-0000"], publishedAt: "2026-11-05T06:00:00Z", maxSnoozeDays: 3 };
const alert = (over = {}) => ({ release, current: "0.9.0", target: "0.9.2", snoozedUntil: null, updating: null, ...over });

test("offers 1 and 3 days for a critical release, 1, 3 and 7 for an important one; close means tomorrow", () => {
  assert.deepEqual(snoozeChoices(release), [1, 3]);
  assert.deepEqual(snoozeChoices({ level: "important", maxSnoozeDays: 7 }), [1, 3, 7]);
  // The level's cap wins over whatever an answer claims.
  assert.deepEqual(snoozeChoices({ level: "critical", maxSnoozeDays: 7 }), [1, 3]);
  assert.deepEqual(snoozeChoices({ level: "important", maxSnoozeDays: 0 }), [1, 3, 7]);
  assert.equal(CLOSE_SNOOZE, 1);
  assert.equal(dayLabel(1), "1 day");
  assert.equal(dayLabel(3), "3 days");
});

test("the popup is due for an Admin only, with no reminder running and no update in flight", () => {
  assert.equal(popupDue(alert(), true, NOW), true);
  assert.equal(popupDue(alert(), false, NOW), false, "Viewers never get the popup");
  assert.equal(popupDue(alert({ release: null }), true, NOW), false);
  assert.equal(popupDue(null, true, NOW), false);
  assert.equal(popupDue(alert({ snoozedUntil: new Date(NOW + 60_000).toISOString() }), true, NOW), false);
  assert.equal(popupDue(alert({ snoozedUntil: new Date(NOW - 1).toISOString() }), true, NOW), true, "due again once the reminder ends");
  assert.equal(popupDue(alert({ updating: { kind: "update", version: "0.9.2" } }), true, NOW), false);
  assert.equal(isSnoozed({ snoozedUntil: null }, NOW), false);
});

test("reads only an answer it understands", () => {
  assert.deepEqual(readAlert(alert()), alert());
  assert.deepEqual(readAlert({ ...alert(), release: { ...release, version: "v0.9.2" } })?.release?.version, "0.9.2");
  // An advisory that is not https is dropped, the alert kept.
  assert.equal(readAlert({ ...alert(), release: { ...release, advisory: "javascript:alert(1)" } })?.release?.advisory, null);
  assert.equal(readAlert({ ...alert(), release: { ...release, level: "low" } }), null);
  assert.equal(readAlert({ ...alert(), release: "critical" }), null);
  assert.equal(readAlert({ release: null }), null);
  assert.equal(readAlert(null), null);
  assert.deepEqual(readAlert({ current: "0.9.0", release: null }), { release: null, current: "0.9.0", target: null, snoozedUntil: null, updating: null });
  assert.deepEqual(readAlert({ ...alert(), updating: { kind: "update", version: "0.9.2" } })?.updating, { kind: "update", version: "0.9.2" });
  assert.equal(readAlert({ ...alert(), updating: { kind: "reboot", version: "0.9.2" } })?.updating, null);
});

test("says what Update now installs, and orders versions as the API does", () => {
  assert.equal(updatePlan(alert(), release), "exact");
  assert.equal(updatePlan(alert({ target: "1.0.0" }), release), "newer");
  assert.equal(updatePlan(alert({ target: "0.9.1" }), release), "step");
  assert.equal(updatePlan(alert({ target: null }), release), "none");
  assert.ok(compareVersions("0.9.2", "0.9.10") < 0);
  assert.ok(compareVersions("1.0.0-rc.1", "1.0.0") < 0);
  assert.equal(compareVersions("v1.2.0", "1.2.0"), 0);
  assert.equal(remindKey({ version: "v0.9.2", level: "critical" }), "0.9.2:critical");
});
