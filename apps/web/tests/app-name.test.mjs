// An app's display name is what people read; its name stays its identity for links, the CLI and
// preview addresses. These pin the web's side of that: which name a page shows, the length the
// Name card allows (as packages/contracts), and that a search finds a renamed app by either name.
// Run: npm test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { appTitle } from "../lib/format.ts";
import { APP_DISPLAY_NAME_MAX, displayNameProblem, UNSAFE_TEXT_MESSAGE } from "../lib/validation.ts";

test("shows the display name when the app has one, else its name", () => {
  assert.equal(appTitle({ name: "web", displayName: "Storefront" }), "Storefront");
  assert.equal(appTitle({ name: "web", displayName: null }), "web");
  assert.equal(appTitle({ name: "web" }), "web");
  assert.equal(appTitle({ name: "web", displayName: "" }), "web");
});

test("holds a display name to 60 characters of visible text, as the API does", () => {
  assert.equal(APP_DISPLAY_NAME_MAX, 60);
  assert.equal(displayNameProblem("x".repeat(60), { max: APP_DISPLAY_NAME_MAX }), null);
  assert.equal(displayNameProblem("x".repeat(61), { max: APP_DISPLAY_NAME_MAX }), "Use 60 characters or fewer");
  assert.equal(displayNameProblem(`Store${String.fromCharCode(0x202e)}front`, { max: APP_DISPLAY_NAME_MAX }), UNSAFE_TEXT_MESSAGE);
  assert.equal(displayNameProblem("Café Zürich", { max: APP_DISPLAY_NAME_MAX }), null);
});
