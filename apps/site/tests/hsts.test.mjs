import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hstsFor } from "../lib/hsts.ts";

test("an https site asks for https only, for its own host", () => {
  assert.equal(hstsFor("https://dockify.sh"), "max-age=31536000");
});

test("a site on plain http sends no such header", () => {
  assert.equal(hstsFor("http://localhost:3007"), null);
});

test("the proxy sets it on every response", () => {
  const proxy = readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(proxy, /hstsFor\(SITE_URL\)/);
  assert.match(proxy, /Strict-Transport-Security/);
});
