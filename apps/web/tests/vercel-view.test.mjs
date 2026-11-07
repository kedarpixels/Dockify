// An app that follows a Vercel project: which Variables tab it gets, what stands in for a value
// Dockify never shows, and the domains its Overview links. Run: npm test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { frameworkLabel, valueNote, variablesOnVercel, visitHosts } from "../components/app-detail/vercel-view.ts";

test("a followed app reads its variables from Vercel; a deploy target and a server app keep Dockify's", () => {
  assert.equal(variablesOnVercel({ kind: "vercel", mode: "follow" }), true);
  // A link sent without a mode follows (contracts AppConfigPatch).
  assert.equal(variablesOnVercel({ kind: "vercel" }), true);
  assert.equal(variablesOnVercel({ kind: "vercel", mode: "deploy" }), false);
  assert.equal(variablesOnVercel({ kind: "server" }), false);
  assert.equal(variablesOnVercel(undefined), false);
});

test("a value never shown says why, in a few words with no dashes", () => {
  const dash = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
  const cases = [
    [{ type: "sensitive" }, true, /Sensitive/],
    [{ type: "encrypted" }, true, /Encrypted/],
    [{ type: "system" }, true, /Set by Vercel/],
    [{ type: "plain" }, false, /admins only/],
    [{ type: "plain" }, true, /Empty/],
  ];
  for (const [e, values, re] of cases) {
    const s = valueNote(e, values);
    assert.match(s, re);
    assert.doesNotMatch(s, dash);
    assert.ok(s.length < 40, s);
  }
});

test("production is visited at its custom domains first, else at its vercel.app name", () => {
  assert.deepEqual(visitHosts(["inkwell.example", "www.inkwell.example", "inkwell-web.vercel.app"]), { shown: ["inkwell.example", "www.inkwell.example"], more: 0, custom: true });
  assert.deepEqual(visitHosts(["a.example", "b.example", "c.example", "d.example", "x.vercel.app"]), { shown: ["a.example", "b.example", "c.example"], more: 1, custom: true });
  assert.deepEqual(visitHosts(["web.vercel.app", "web-git-main.vercel.app"]), { shown: ["web.vercel.app"], more: 0, custom: false });
  assert.deepEqual(visitHosts([]), { shown: [], more: 0, custom: false });
});

test("Vercel's framework slugs read as people say them", () => {
  assert.equal(frameworkLabel("nextjs"), "Next.js");
  assert.equal(frameworkLabel("brand-new-thing"), "brand-new-thing");
  assert.equal(frameworkLabel(null), "Other");
});
