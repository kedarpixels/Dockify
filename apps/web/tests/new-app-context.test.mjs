// A Viewer's integrations summary is booleans. The New app context reads the same
// route, and must not take a boolean for a list. Run: npm test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { toContext } from "../lib/pages/new-app-context.ts";

test("a Viewer's small answer reads as nothing to pick from, not a crash", () => {
  const limited = { limited: true, github: true, vercel: true, cloudflare: false, registries: true, storage: false, webhooks: false, email: true };
  assert.deepEqual(toContext(limited), { registries: [], vercel: null });
});

test("an admin's answer keeps the registries and the Vercel account", () => {
  const out = toContext({
    registries: [{ id: "r1", host: "ghcr.io", username: "bot", error: null, kind: "ghcr", tokenHint: "abcd", addedAt: "" }],
    vercel: { account: { username: "o", name: "O" }, team: { id: "t", name: "Team" } },
  });
  assert.deepEqual(out, { registries: [{ id: "r1", host: "ghcr.io", username: "bot", error: null }], vercel: { account: "o", team: "Team" } });
});

test("no answer reads as nothing", () => {
  assert.deepEqual(toContext(null), { registries: [], vercel: null });
});
