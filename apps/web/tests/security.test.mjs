// Regression tests for the web security fixes. Run: node --test tests/ (Node 22.18+ strips the
// TypeScript types of the imported modules; no build, no Next needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalPath, localDestination, safeNext } from "../components/auth/util.ts";
import { forwardedHeaders, parseSetCookie, SESSION_COOKIES } from "../lib/forwarded.ts";
import { contentSecurityPolicy, makeNonce, securityHeaders } from "../lib/security-headers.ts";

const h = (o) => new Headers(o);

test("every API call forwards the client address, agent and cookie", () => {
  const out = forwardedHeaders(h({ cookie: "__Host-dockify_sid=abc", "x-forwarded-for": "203.0.113.5", "cf-connecting-ip": "203.0.113.5", "user-agent": "UA", host: "x" }));
  assert.deepEqual(out, { cookie: "__Host-dockify_sid=abc", "x-forwarded-for": "203.0.113.5", "cf-connecting-ip": "203.0.113.5", "user-agent": "UA" });
  assert.equal(forwardedHeaders(h({ cookie: "a=b", "x-forwarded-for": "1.2.3.4" }), { cookie: false }).cookie, undefined);
});

test("the SSH tunnel's Host reaches the API, and no other Host does", () => {
  const key = "x-dockify-loopback-host";
  assert.equal(forwardedHeaders(h({ host: "127.0.0.1:3000" }))[key], "127.0.0.1:3000");
  for (const host of ["dash.example.com", "evil.example:3000", "127.0.0.1.evil.example:3000", "localhost:3000", "127.0.0.1"]) {
    assert.equal(forwardedHeaders(h({ host }))[key], undefined, host);
  }
});

test("safeNext never yields a protocol-relative URL from dot segments", () => {
  // "/\\evil.com" is the characters / \ evil.com: a browser reads that backslash as a slash.
  for (const evil of ["/..//evil.com", "/x/..//evil.com/p", "/%2e%2e//evil.com", "//evil.com", "/\\evil.com", "/\\/evil.com", "/.//evil.com", "/./..//evil.com"]) {
    const out = safeNext(evil);
    assert.ok(!out.startsWith("//") && !out.startsWith("/\\"), `${evil} -> ${out}`);
    assert.equal(new URL(out, "https://dockify.example.com").origin, "https://dockify.example.com", evil);
  }
  assert.equal(safeNext("/..//evil.com"), "/");
  assert.equal(safeNext("/\\evil.com"), "/");
  assert.equal(safeNext("/apps/1?tab=env#x"), "/apps/1?tab=env#x");
});

test("the client only navigates to local paths", () => {
  assert.equal(isLocalPath("//evil.com"), false);
  assert.equal(isLocalPath("/\\evil.com"), false);
  assert.equal(isLocalPath("https://evil.com"), false);
  assert.equal(isLocalPath("/projects/shop"), true);
  assert.equal(localDestination("//evil.com"), "/");
  assert.equal(localDestination("/deployments"), "/deployments");
});

test("the API's clearing Set-Cookie becomes an expired cookie, so sign out clears the session", () => {
  const c = parseSetCookie("__Host-dockify_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure");
  assert.deepEqual(c, { name: "__Host-dockify_sid", value: "", opts: { path: "/", httpOnly: true, sameSite: "strict", maxAge: 0, secure: true } });
  assert.ok(SESSION_COOKIES.includes("__Host-dockify_sid") && SESSION_COOKIES.includes("dockify_sid"));
});

test("console responses cannot be framed and scripts need the nonce", () => {
  const n = makeNonce();
  assert.notEqual(n, makeNonce());
  const hdrs = securityHeaders(n);
  assert.equal(hdrs["X-Frame-Options"], "DENY");
  assert.equal(hdrs["X-Content-Type-Options"], "nosniff");
  // HSTS only once the request already arrived over https, so the http loopback escape hatch works.
  assert.equal(hdrs["Strict-Transport-Security"], undefined);
  assert.equal(securityHeaders(n, false, true)["Strict-Transport-Security"], "max-age=31536000; includeSubDomains");
  const csp = contentSecurityPolicy(n);
  assert.match(csp, /frame-ancestors 'none'/);
  // Only this site and GitHub (the app manifest form posts there) may receive a form.
  assert.match(csp, /form-action 'self' https:\/\/github\.com(;|$)/);
  // "\\$&" inserts a backslash before the match; "\$&" is just "$&" and leaves + and / unescaped, which made this flaky.
  assert.match(csp, new RegExp(`script-src 'self' 'nonce-${n.replace(/[+/=]/g, "\\$&")}'`));
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
});
