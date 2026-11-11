// The Deployments list polls its first page. Under a status filter it kept rows the fresh page no
// longer held, so a finished build stayed under "Building"; and a day head counted only loaded
// rows, so the last day's count grew on "Load more". Run: npm test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { groupCount, merge, refreshed } from "../components/deployments/feed-list.ts";

const row = (id, minute, status = "building") => ({ id, status, createdAt: `2026-11-10T10:${String(minute).padStart(2, "0")}:00.000Z` });

test("with no status filter a poll merges: rows update in place and new ones go on top", () => {
  const shown = { items: [row("b", 2), row("a", 1)], next: null };
  const out = refreshed(shown, { items: [row("c", 3), row("b", 2, "ready")], nextCursor: null }, false);
  assert.deepEqual(out.items.map((d) => `${d.id}:${d.status}`), ["c:building", "b:ready", "a:building"]);
  assert.deepEqual(merge(shown.items, []), shown.items);
});

test("under a status filter a build that finished leaves the list", () => {
  const shown = { items: [row("b", 2), row("a", 1)], next: null };
  const out = refreshed(shown, { items: [row("b", 2)], nextCursor: null }, true);
  assert.deepEqual(out.items.map((d) => d.id), ["b"]);
  assert.equal(refreshed(shown, { items: [], nextCursor: null }, true).items.length, 0);
});

test("under a status filter rows from Load more stay, and only the stretch the fresh page covers is replaced", () => {
  // Page one held e, d, c; Load more added b, a. Since then d finished and f started.
  const shown = { items: [row("e", 5), row("d", 4), row("c", 3), row("b", 2), row("a", 1)], next: "cursor-2" };
  const out = refreshed(shown, { items: [row("f", 6), row("e", 5), row("c", 3)], nextCursor: "cursor-1" }, true);
  assert.deepEqual(out.items.map((d) => d.id), ["f", "e", "c", "b", "a"]);
  assert.equal(out.next, "cursor-2");
  // A fresh page with no page after it is the whole answer, whatever was loaded before.
  const whole = refreshed(shown, { items: [row("e", 5)], nextCursor: null }, true);
  assert.deepEqual(whole.items.map((d) => d.id), ["e"]);
  assert.equal(whole.next, null);
  // With nothing older kept, the cursor is the fresh page's.
  const first = refreshed({ items: [row("e", 5), row("d", 4)], next: "old" }, { items: [row("e", 5), row("d", 4)], nextCursor: "new" }, true);
  assert.equal(first.next, "new");
});

test("a day head shows a count only once the day is whole", () => {
  assert.equal(groupCount(7, false, true), 7);
  assert.equal(groupCount(7, true, true), undefined);
  assert.equal(groupCount(7, true, false), 7);
});
