// The Backups page's pure pieces: the 30 day window, UTC day groups, and what a bulk run missed.
// Run: node --test tests/
import assert from "node:assert/strict";
import { test } from "node:test";
import { byDay, heldNoun, inHistory, isVolumes, listNoun, notStarted } from "../components/server-backups/history.ts";
import { dayHeading } from "../lib/format.ts";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const run = (createdAt, resourceId = "a") => ({ createdAt, resourceId });

test("the history keeps 30 days, so the older rows the API adds for totals stay out of it", () => {
  assert.equal(inHistory(run("2026-11-10T03:00:00Z"), NOW), true);
  assert.equal(inHistory(run("2026-10-12T12:00:01Z"), NOW), true);
  assert.equal(inHistory(run("2026-10-12T12:00:00Z"), NOW), false);
  assert.equal(inHistory(run("2026-09-01T03:00:00Z"), NOW), false);
});

test("runs group by UTC day, the zone the card's label names", () => {
  // 23:30 and 00:30 UTC are one local evening in New York and one local day in Tokyo, but two UTC days.
  const rows = [run("2026-11-11T00:30:00Z"), run("2026-11-10T23:30:00Z"), run("2026-11-10T01:00:00Z"), run("2026-11-08T05:00:00Z")];
  const groups = byDay(rows, (iso) => dayHeading(iso, NOW));
  assert.deepEqual(groups.map((g) => [g.label, g.rows.length]), [["Today", 1], ["Yesterday", 2], ["Sunday 8 Nov", 1]]);
  assert.deepEqual(byDay([], () => "x"), []);
});

test("a bulk run names the enabled databases it started nothing for", () => {
  const asked = [{ resourceId: "a" }, { resourceId: "b" }, { resourceId: "c" }];
  assert.deepEqual(notStarted(asked, [run("2026-11-11T00:00:00Z", "a"), run("2026-11-11T00:00:00Z", "a"), run("2026-11-11T00:00:00Z", "c")]), [{ resourceId: "b" }]);
  assert.deepEqual(notStarted(asked, asked), []);
  // One database picked by hand asks for no list.
  assert.deepEqual(notStarted([], [run("2026-11-11T00:00:00Z")]), []);
});

test("a backup of an app's volumes is worded as an app, and a list says databases only while every one is", () => {
  const db = { content: "database" };
  const files = { content: "volumes" };
  assert.equal(isVolumes(files), true);
  assert.equal(isVolumes(db), false);
  // An older API sends no content: it only had databases.
  assert.equal(isVolumes({}), false);
  assert.equal(heldNoun(files), "app");
  assert.equal(heldNoun({}), "database");
  assert.equal(listNoun([db, {}]), "database");
  assert.equal(listNoun([db, files]), "app");
  assert.equal(listNoun([]), "database");
});
