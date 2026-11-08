// A project's Icon dropdown: which value it shows (the folder, the frontend chosen or the upload)
// and the line naming what the icon is. Run: npm test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { iconUrl, PROJECT_FOLDER, PROJECT_UPLOAD, projectIconLine, projectIconPick } from "../lib/icons.ts";

const SITE = { id: "site", name: "frontend", environment: "production", host: "brand.example" };
const DASH = { id: "dash", name: "Admin panel", environment: "production", host: "dashboard-4f5e6d.203-0-113-10.sslip.io" };
const image = { version: "33c9ee2bd908", source: "favicon", width: 64, height: 64 };
const fav = { origin: "https://brand.example/favicon.png", fetchedAt: null, checkedAt: null, error: null };
const folder = (apps = [SITE, DASH]) => ({ choice: "auto", image: null, favicon: null, borrow: { mode: "folder", pick: null, from: null, apps } });
const chosen = (id, apps = [SITE, DASH]) => ({ choice: "auto", image, favicon: fav, borrow: { mode: "app", pick: id, from: id, apps } });

test("names the folder, or the app chosen and its host", () => {
  assert.equal(projectIconLine(folder()), "The folder");
  assert.equal(projectIconLine(undefined), "The folder");
  assert.equal(projectIconLine(chosen("site")), "Favicon of frontend, at brand.example");
  assert.equal(projectIconLine(chosen("dash")), "Favicon of Admin panel, at dashboard-4f5e6d.203-0-113-10.sslip.io");
  // The app chosen lost its favicon: the project shows the folder, and the line says why.
  assert.equal(projectIconLine({ choice: "auto", image: null, favicon: null, borrow: { mode: "app", pick: "gone", from: null, apps: [SITE] } }), "The folder, while the app chosen has no favicon");
  assert.equal(projectIconLine({ choice: "upload", image: { ...image, source: "upload" }, favicon: null }), "Uploaded image, 64 by 64");
});

test("shows the folder, the app chosen, or the upload as the dropdown's value", () => {
  assert.deepEqual(projectIconPick(folder()), { value: PROJECT_FOLDER, apps: [SITE, DASH] });
  assert.equal(projectIconPick(chosen("dash")).value, "dash");
  // A chosen app that lost its favicon reads as the folder, which is what the project shows.
  assert.equal(projectIconPick({ choice: "auto", image: null, favicon: null, borrow: { mode: "app", pick: "gone", from: null, apps: [SITE] } }).value, PROJECT_FOLDER);
  assert.equal(projectIconPick({ choice: "upload", image, favicon: null, borrow: { mode: "upload", pick: null, from: null, apps: [SITE] } }).value, PROJECT_UPLOAD);
  // A project the map does not list: the folder, with nothing to choose.
  assert.deepEqual(projectIconPick(undefined), { value: PROJECT_FOLDER, apps: [] });
});

test("builds the same versioned image URL for a project as for an app", () => {
  assert.equal(iconUrl({ target: "project", slug: "brand" }, "33c9ee2bd908"), "/api/icons/projects/brand?v=33c9ee2bd908");
  assert.equal(iconUrl({ target: "app", id: "33333333-0000-4000-8000-000000000002" }, "33c9ee2bd908"), "/api/icons/apps/33333333-0000-4000-8000-000000000002?v=33c9ee2bd908");
});
