// Names with a control character, a direction override or a
// zero-width character were accepted. The web refuses them before a request leaves the browser,
// with the same ranges and words as packages/contracts. Run: npm test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { displayNameProblem, hasUnsafeText, UNSAFE_TEXT_MESSAGE } from "../lib/validation.ts";

const ch = (code) => String.fromCharCode(code);

test("refuses controls, direction marks and overrides, isolates and zero-width characters", () => {
  for (const code of [0x00, 0x09, 0x1b, 0x7f, 0x85, 0x061c, 0x200b, 0x200d, 0x200e, 0x2028, 0x202e, 0x2060, 0x2066, 0xfeff]) {
    assert.equal(hasUnsafeText(`Acme${ch(code)}Corp`), true, code.toString(16));
    assert.equal(displayNameProblem(`Acme${ch(code)}Corp`), UNSAFE_TEXT_MESSAGE, code.toString(16));
  }
});

test("keeps ordinary names, accents, other scripts and emoji", () => {
  for (const name of ["Acme Corp", "Café Zürich", "東京オフィス", "Ünïcödé & Sons, Ltd.", "Rocket 🚀"]) {
    assert.equal(hasUnsafeText(name), false, name);
    assert.equal(displayNameProblem(name), null, name);
  }
});

test("says what is missing or too long, in the caller's words", () => {
  assert.equal(displayNameProblem("   ", { empty: "Give the token a name" }), "Give the token a name");
  assert.equal(displayNameProblem("x".repeat(101)), "Use 100 characters or fewer");
  assert.equal(displayNameProblem("x".repeat(60), { max: 60 }), null);
});

test("refuses app and restored database names in Dockify's dk- prefix, with the API's words", async () => {
  const { hasReservedPrefix, RESERVED_NAME_MESSAGE } = await import("../lib/validation.ts");
  assert.equal(RESERVED_NAME_MESSAGE, "Names starting with dk- are reserved for Dockify");
  for (const name of ["dk-web", "dk-route-1", "DK-db"]) assert.equal(hasReservedPrefix(name), true, name);
  for (const name of ["web", "dkweb", "my-dk-db", "desk"]) assert.equal(hasReservedPrefix(name), false, name);
});
