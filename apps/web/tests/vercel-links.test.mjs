import assert from "node:assert/strict";
import { test } from "node:test";
import { hostOfUrl, vercelLogsHref } from "../components/deployments/vercel-links.ts";

test("Vercel's Logs tab comes from the inspector address", () => {
  assert.equal(vercelLogsHref("https://vercel.com/acme/web/J1hXN00q"), "https://vercel.com/acme/web/logs");
});

test("anything but an https page on vercel.com has no Logs link", () => {
  for (const bad of [null, "", "not a url", "http://vercel.com/acme/web/x", "https://evil.example/acme/web/x", "https://vercel.com.evil.example/acme/web/x", "https://vercel.com/acme"]) {
    assert.equal(vercelLogsHref(bad), null, String(bad));
  }
});

test("a link's text is the host", () => {
  assert.equal(hostOfUrl("https://web-abc.vercel.app"), "web-abc.vercel.app");
  assert.equal(hostOfUrl("nonsense"), "nonsense");
});
