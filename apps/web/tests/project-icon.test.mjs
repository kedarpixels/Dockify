// A project's Icon dropdown: which value it shows (the upload, the picked frontend or Automatic),
// the app Automatic lands on, and the line naming where the icon comes from. Run: npm test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { iconUrl, PROJECT_AUTO, PROJECT_UPLOAD, projectIconLine, projectIconPick } from "../lib/icons.ts";

const SITE = { id: "site", name: "frontend", environment: "production", host: "brand.example" };
const DASH = { id: "dash", name: "Admin panel", environment: "production", host: "dashboard-4f5e6d.203-0-113-10.sslip.io" };
const image = { version: "33c9ee2bd908", source: "favicon", width: 64, height: 64 };
const auto = (borrow, extra = {}) => ({ choice: "auto", image, favicon: { origin: "https://brand.example/favicon.png", fetchedAt: null, checkedAt: null, error: null }, borrow, ...extra });

test("names the app and its host, never only the host", () => {
  assert.equal(projectIconLine(auto({ pick: null, auto: "site", from: "site", apps: [SITE, DASH] })), "Favicon of frontend, at brand.example");
  assert.equal(projectIconLine(auto({ pick: "dash", auto: "site", from: "dash", apps: [SITE, DASH] })), "Favicon of Admin panel, at dashboard-4f5e6d.203-0-113-10.sslip.io");
  assert.equal(projectIconLine({ choice: "auto", image: null, favicon: null, borrow: { pick: null, auto: null, from: null, apps: [] } }), "The project folder, until a frontend has a favicon");
  assert.equal(projectIconLine({ choice: "upload", image: { ...image, source: "upload" }, favicon: null }), "Uploaded image, 64 by 64");
});

test("shows Automatic, the pick, or the upload as the dropdown's value", () => {
  assert.deepEqual(projectIconPick(auto({ pick: null, auto: "site", from: "site", apps: [SITE, DASH] })), { value: PROJECT_AUTO, auto: SITE, apps: [SITE, DASH] });
  assert.equal(projectIconPick(auto({ pick: "dash", auto: "site", from: "dash", apps: [SITE, DASH] })).value, "dash");
  // A pick whose app lost its favicon reads as Automatic, as the API then borrows the automatic one.
  assert.equal(projectIconPick(auto({ pick: "gone", auto: "site", from: "site", apps: [SITE] })).value, PROJECT_AUTO);
  assert.equal(projectIconPick({ choice: "upload", image, favicon: null, borrow: { pick: null, auto: "site", from: "site", apps: [SITE] } }).value, PROJECT_UPLOAD);
  // A project the map does not list yet: Automatic, with nothing to pick.
  assert.deepEqual(projectIconPick(undefined), { value: PROJECT_AUTO, auto: null, apps: [] });
});

test("builds the same versioned image URL for a project as for an app", () => {
  assert.equal(iconUrl({ target: "project", slug: "brand" }, "33c9ee2bd908"), "/api/icons/projects/brand?v=33c9ee2bd908");
  assert.equal(iconUrl({ target: "app", id: "33333333-0000-4000-8000-000000000002" }, "33c9ee2bd908"), "/api/icons/apps/33333333-0000-4000-8000-000000000002?v=33c9ee2bd908");
});
