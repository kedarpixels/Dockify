// Parts of the console kept their first read: the sidebar, command menu, tab title and icons (the
// layout reads once), the project page's deployments and previews, a project's Variables tab after
// an environment was added, and an app's branch after a save. Run: npm test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dayIn } from "../components/overview/today.ts";
import { previewsMoving, statusKey } from "../components/project-detail/live.ts";
import { matchesProject } from "../components/projects/search.ts";
import { iconsStale, isNewer } from "../components/shell/live-shell.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const facts = (projects, apps, inFlight) => ({ projects: projects.map((slug) => ({ slug })), apps: apps.map((id) => ({ id })), inFlight });

test("the shell takes a polled overview only when it is as new as the layout's", () => {
  assert.equal(isNewer("2026-11-10T10:00:15.000Z", "2026-11-10T10:00:00.000Z"), true);
  assert.equal(isNewer("2026-11-10T10:00:00.000Z", "2026-11-10T10:00:15.000Z"), false);
  // No layout stamp (the not-found shell): anything polled wins.
  assert.equal(isNewer("2026-11-10T10:00:00.000Z", ""), true);
});

test("icons are read again when a project or app comes or goes, and twice around a build's end", () => {
  const base = facts(["shop"], ["a1"], 0);
  assert.deepEqual(iconsStale(base, facts(["shop"], ["a1"], 0)), { now: false, again: false });
  assert.deepEqual(iconsStale(base, facts(["shop", "blog"], ["a1"], 0)), { now: true, again: false });
  assert.deepEqual(iconsStale(base, facts(["shop"], [], 0)), { now: true, again: false });
  // A build starting changes no icon; its end does, and the favicon lands a moment later.
  assert.deepEqual(iconsStale(base, facts(["shop"], ["a1"], 1)), { now: false, again: false });
  assert.deepEqual(iconsStale(facts(["shop"], ["a1"], 2), facts(["shop"], ["a1"], 1)), { now: true, again: true });
});

test("the shell reads the polled overview and never polls for itself", () => {
  const shell = read("components/shell/shell.tsx");
  assert.match(shell, /useLatestOverview\(\)/);
  assert.match(shell, /useTabSignals\(data\.inFlight\)/);
  assert.match(shell, /if \(stale\.now \|\| readAgain\.current\) router\.refresh\(\)/);
  assert.doesNotMatch(shell, /setInterval|useOverview\(|fetch\(/);
  assert.doesNotMatch(read("lib/live-overview.ts"), /setInterval|fetch\(/);
  assert.match(read("app/(console)/layout.tsx"), /<Shell data=\{shell\} servedAt=\{fetchedAt\}>/);
  // The one poll hook hands every snapshot to the shell, so every page that polls keeps it live.
  assert.match(read("lib/hooks.ts"), /useEffect\(\(\) => publishOverview\(result\), \[result\]\)/);
});

test("the project page reads itself again when a status moves, and previews while one is unsettled", () => {
  assert.notEqual(statusKey([{ id: "a", status: "running" }]), statusKey([{ id: "a", status: "deploying" }]));
  assert.equal(statusKey([{ id: "a", status: "running" }]), statusKey([{ id: "a", status: "running" }]));
  assert.equal(previewsMoving([{ status: "ready" }, { status: "building" }]), true);
  assert.equal(previewsMoving([{ status: "ready" }, { status: "closing" }]), true);
  assert.equal(previewsMoving([{ status: "ready" }, { status: "failed" }, { status: "asleep" }]), false);
  assert.equal(previewsMoving(null), false);
  const view = read("components/project-detail/project-view.tsx");
  assert.match(view, /lastPolled\.current = polled;\s*router\.refresh\(\);/);
  assert.match(view, /if \(moving\) void reload\(\);/);
});

test("adding or removing an environment reloads the variables, and a stale set never stands in for another environment", () => {
  const card = read("components/project-extras/environments.tsx");
  assert.equal(card.match(/onReload\?\.\(\);/g)?.length, 2);
  assert.match(read("components/project-detail/project-settings.tsx"), /<EnvironmentsCard [^>]*onReload=\{onReload\}/);
  assert.match(read("components/project-extras/env-workbench.tsx"), /if \(!self && environment && !envNames\.includes\(environment\)\) \{/);
});

test("a saved branch or image reads as saved, and the page reads the new source", () => {
  const tab = read("components/app-detail/settings-tab.tsx");
  assert.match(tab, /setStored\(\{ from: served, image, branch \}\);/);
  assert.match(tab, /stored\?\.from === served \? \{ image: stored\.image, branch: stored\.branch \}/);
  assert.match(tab, /if \(sourcePatch\) router\.refresh\(\);/);
  assert.equal(tab.match(/router\.refresh\(\);/g)?.length, 2);
});

test("the Projects search finds a project by the name its card shows", () => {
  const p = { slug: "kz-prod", name: "Harbor Lights", apps: [{ name: "api", displayName: "Game API" }] };
  for (const q of ["harbor", "kz-", "api", "game"]) assert.equal(matchesProject(p, q), true, q);
  assert.equal(matchesProject(p, "meadow"), false);
  assert.equal(matchesProject(p, ""), true);
  assert.equal(matchesProject({ slug: "old", apps: [] }, "old"), true);
  assert.match(read("components/projects/projects-view.tsx"), /matchesProject\(p, q\)/);
});

test("today is the day in the zone the trend was counted in", () => {
  const lateUtc = Date.parse("2026-11-10T23:30:00.000Z");
  assert.equal(dayIn(lateUtc), "2026-11-10");
  assert.equal(dayIn(lateUtc, "UTC"), "2026-11-10");
  assert.equal(dayIn(lateUtc, "Asia/Kolkata"), "2026-11-11");
  assert.equal(dayIn(Date.parse("2026-11-10T03:00:00.000Z"), "America/New_York"), "2026-11-09");
  // A zone the runtime does not know falls back to the UTC day.
  assert.equal(dayIn(lateUtc, "Not/AZone"), "2026-11-10");
  assert.match(read("components/overview/overview-view.tsx"), /const todayIso = dayIn\(now, zone\);/);
  assert.doesNotMatch(read("components/overview/deploy-heatmap.tsx"), /new Date\(now\)\.toISOString\(\)/);
});
