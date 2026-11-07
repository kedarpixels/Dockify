// The absolute time helpers honour the user's zone and clock. Run: node --test tests/ (Node 22.18+
// strips the TypeScript types of the imported module).
import assert from "node:assert/strict";
import { test } from "node:test";
import { absTime, chartTime, clockTime, parseZonedInput, timeParts, zonedInputValue } from "../lib/format.ts";

const AT = "2026-10-30T14:05:09Z";
const berlin = { timeZone: "Europe/Berlin", hour12: false };
const ny12 = { timeZone: "America/New_York", hour12: true };

test("UTC moments ignore the zone but follow the clock", () => {
  assert.equal(absTime(AT, { utc: true, prefs: berlin }), "30 Oct 2026, 14:05 UTC");
  assert.equal(absTime(AT, { utc: true, prefs: { timeZone: null, hour12: true } }), "30 Oct 2026, 2:05 PM UTC");
});

test("local moments read in the picked zone and clock", () => {
  assert.equal(absTime(AT, { prefs: berlin }), "30 Oct 2026, 15:05");
  assert.equal(absTime(AT, { prefs: ny12 }), "30 Oct 2026, 10:05 AM");
  assert.equal(clockTime(AT, { prefs: ny12, seconds: true }), "10:05:09 AM");
  assert.equal(clockTime("2026-10-30T00:30:00Z", { utc: true, prefs: { timeZone: null, hour12: true } }), "12:30 AM");
  assert.equal(chartTime(AT, { prefs: berlin, withDay: true }), "Fri 15:05");
  assert.equal(timeParts("2026-10-30T23:30:00Z", { prefs: berlin }).day, 31);
});

test("an unknown zone falls back to the browser instead of throwing", () => {
  assert.equal(typeof absTime(AT, { prefs: { timeZone: "Mars/Olympus", hour12: false } }), "string");
  assert.equal(absTime("not a date", { prefs: berlin }), "not a date");
});

test("datetime-local values round trip in the picked zone, across a DST change", () => {
  for (const iso of ["2026-10-30T14:05:00Z", "2026-03-29T00:30:00Z", "2026-07-01T22:15:00Z"]) {
    const v = zonedInputValue(Date.parse(iso), berlin);
    assert.equal(new Date(parseZonedInput(v, berlin)).toISOString(), new Date(iso).toISOString(), v);
  }
  assert.equal(zonedInputValue(Date.parse(AT), berlin), "2026-10-30T15:05");
  assert.ok(Number.isNaN(parseZonedInput("yesterday", berlin)));
});

test("sizes round one way, and a used-of-total pair prints a shared unit once", async () => {
  const { bytes, sizePair, plural } = await import("../lib/format.ts");
  assert.equal(bytes(512), "512 B");
  assert.equal(bytes(4.2 * 1024), "4.2 KB");
  assert.equal(bytes(11.2 * 1024 ** 3), "11 GB");
  assert.equal(bytes(1023.7 * 1024), "1 MB");
  assert.equal(bytes(-5), "0 B");
  assert.equal(sizePair(11.2 * 1024 ** 3, 32 * 1024 ** 3), "11 of 32 GB");
  assert.equal(sizePair(439 * 1024 ** 2, 1024 ** 3), "439 MB of 1 GB");
  assert.equal(sizePair(0, 20 * 1024 ** 3), "0 B of 20 GB");
  assert.equal(plural(1, "app"), "1 app");
  assert.equal(plural(3, "app"), "3 apps");
  assert.equal(plural(2, "entry", "entries"), "2 entries");
  assert.equal(plural(1200, "row"), "1,200 rows");
});

test("an error spliced into a sentence ends on one full stop", async () => {
  const { clause } = await import("../lib/format.ts");
  assert.equal(clause("The API did not answer."), "The API did not answer");
  assert.equal(clause("  No data source, set DOCKIFY_API_URL for this dashboard. \n"), "No data source, set DOCKIFY_API_URL for this dashboard");
  assert.equal(clause("Version 1.2"), "Version 1.2");
});
