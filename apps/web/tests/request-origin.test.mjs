// The status feed's absolute links. Run: node --test tests/
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { requestOrigin } from "../lib/request-origin.ts";

const req = (headers) => ({ headers: new Headers(headers) });
const saved = process.env.DOCKIFY_PUBLIC_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.DOCKIFY_PUBLIC_URL;
  else process.env.DOCKIFY_PUBLIC_URL = saved;
});

test("a visitor's X-Forwarded-Host or X-Forwarded-Proto never reaches a link", () => {
  delete process.env.DOCKIFY_PUBLIC_URL;
  assert.equal(requestOrigin(req({ host: "dash.example.com", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" })), "https://dash.example.com");
  assert.equal(requestOrigin(req({ "x-forwarded-host": "evil.example" })), null);
});

test("the Host must look like a hostname, and only the SSH tunnel's port is plain http", () => {
  delete process.env.DOCKIFY_PUBLIC_URL;
  for (const host of ["evil.example/x", "a b", "<script>", "user@evil.example", ""]) assert.equal(requestOrigin(req({ host })), null, host);
  assert.equal(requestOrigin(req({ host: "127.0.0.1:3000" })), "http://127.0.0.1:3000");
  assert.equal(requestOrigin(req({ host: "127.0.0.1.evil.example:3000" })), "https://127.0.0.1.evil.example:3000");
});

test("DOCKIFY_PUBLIC_URL wins over every header", () => {
  process.env.DOCKIFY_PUBLIC_URL = "https://dash.example.com/";
  assert.equal(requestOrigin(req({ host: "other.example", "x-forwarded-host": "evil.example" })), "https://dash.example.com");
});
