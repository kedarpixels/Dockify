// The bell's order and its read state. Run: node --test tests/ (Node 22.18+ strips the TypeScript
// types of the imported module).
import assert from "node:assert/strict";
import { test } from "node:test";
import { keepSeen, orderNotices } from "../lib/notices.ts";

const notice = (id, kind, at) => ({ id, kind, at, tone: "idle", title: id, detail: "", href: "/" });
const ids = (list) => list.map((n) => n.id);

test("an update notice takes its place by time, under newer deploys", () => {
  // The order deriveNotices builds them in: Dockify's own notices ahead of the deploy results.
  const list = [
    notice("sys:update-available-1.0.4", "result", "2026-11-08T09:00:00Z"),
    notice("deploy-new", "result", "2026-11-11T10:00:00Z"),
    notice("deploy-old", "result", "2026-11-10T22:00:00Z"),
  ];
  assert.deepEqual(ids(orderNotices(list)), ["deploy-new", "deploy-old", "sys:update-available-1.0.4"]);
});

test("a finished update that is the newest event leads the results", () => {
  const list = [
    notice("deploy", "result", "2026-11-11T08:00:00Z"),
    notice("sys:update-1", "result", "2026-11-11T09:00:00Z"),
  ];
  assert.deepEqual(ids(orderNotices(list)), ["sys:update-1", "deploy"]);
});

test("problems stay ahead of results, live states first, then newest first", () => {
  const list = [
    notice("app:stopped", "problem"),
    notice("deploy-failed", "problem", "2026-11-11T07:00:00Z"),
    notice("sys:security-release-1.0.4", "problem", "2026-11-11T09:00:00Z"),
    notice("deploy", "result", "2026-11-11T10:00:00Z"),
    notice("app:degraded", "problem"),
  ];
  assert.deepEqual(ids(orderNotices(list)), ["app:stopped", "app:degraded", "sys:security-release-1.0.4", "deploy-failed", "deploy"]);
});

test("equal and unreadable times keep the order given, and the input is left alone", () => {
  const list = [notice("a", "result", "2026-11-11T10:00:00Z"), notice("b", "result", "2026-11-11T10:00:00Z"), notice("c", "result", "soon")];
  assert.deepEqual(ids(orderNotices(list)), ["a", "b", "c"]);
  assert.deepEqual(ids(list), ["a", "b", "c"]);
});

test("a read is kept by a tab whose older list never showed that notice", () => {
  // Another tab saw the deploy finish and marked it read; this hidden tab still shows the old list.
  const stale = new Set(["app:stopped"]);
  assert.deepEqual(keepSeen(["app:stopped", "deploy-new"], stale, stale), ["app:stopped", "deploy-new"]);
});

test("a read is forgotten once this page watched its notice go", () => {
  const before = new Set(["app:stopped", "deploy"]);
  assert.deepEqual(keepSeen(["app:stopped", "deploy"], before, new Set(["deploy"])), ["deploy"]);
});

test("the first list after a load clears out what is no longer listed", () => {
  assert.deepEqual(keepSeen(["gone", "deploy"], null, new Set(["deploy"])), ["deploy"]);
});
