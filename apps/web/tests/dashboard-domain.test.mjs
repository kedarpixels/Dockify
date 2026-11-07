// The dashboard domain flow's rules, and setup's offer of it. Run: node --test tests/
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextStep, setupPlan, stepCount } from "../components/auth/setup-steps.ts";
import { cleanHost, domainChecks, HOST_RE, isSslipHost, joinHost, recordMode, worstFinding } from "../lib/dashboard-domain.ts";

test("a hostname reads however it is typed", () => {
  assert.equal(cleanHost(" HTTPS://Dash.Example.com/setup "), "dash.example.com");
  assert.equal(cleanHost("dash.example.com."), "dash.example.com");
  assert.ok(HOST_RE.test("dash.example.com"));
  assert.ok(HOST_RE.test("203-0-113-4.sslip.io"));
  for (const bad of ["", "localhost", "a b.example.com", "-x.example.com", "x-.example.com", "https://x.example.com"]) assert.ok(!HOST_RE.test(bad), bad);
});

test("setup offers a domain only on the address an install started on", () => {
  assert.ok(isSslipHost("203-0-113-4.sslip.io"));
  assert.ok(isSslipHost("203-0-113-4.nip.io"));
  assert.ok(!isSslipHost("dash.example.com"));
  assert.ok(!isSslipHost("app.203-0-113-4.sslip.io"));
});

test("setup's domain step comes last, and the count stays true", () => {
  const plan = setupPlan(false, false, true);
  assert.deepEqual(plan, ["account", "connect", "verify", "protect", "domain"]);
  assert.deepEqual(stepCount(plan, "domain"), [5, 5]);
  assert.equal(nextStep(plan, "protect"), "domain");
  assert.equal(nextStep(plan, "domain"), "done");
  assert.equal(nextStep(setupPlan(false, false), "protect"), "done");
});

test("a name and a zone make one hostname; empty or @ is the zone itself", () => {
  assert.equal(joinHost("app", "example.com"), "app.example.com");
  assert.equal(joinHost("", "example.com"), "example.com");
  assert.equal(joinHost("@", "example.com"), "example.com");
  assert.equal(joinHost(" App ", "example.com"), "app.example.com");
});

test("a full hostname pasted into the name box is not doubled", () => {
  assert.equal(joinHost("app.example.com", "example.com"), "app.example.com");
  assert.equal(joinHost("a.b.example.com", "example.com"), "a.b.example.com");
  assert.equal(joinHost("example.com", "example.com"), "example.com");
  assert.equal(joinHost("notexample.com", "example.com"), "notexample.com.example.com");
});

test("the worst finding sets a row's tone", () => {
  assert.equal(worstFinding(null), null);
  assert.equal(worstFinding({ findings: [] }), null);
  assert.equal(worstFinding({ findings: [{ tone: "info" }] }), "info");
  assert.equal(worstFinding({ findings: [{ tone: "info" }, { tone: "warn" }] }), "warn");
  assert.equal(worstFinding({ findings: [{ tone: "warn" }, { tone: "bad" }] }), "bad");
  assert.equal(recordMode({ proxied: true }), "Proxied");
  assert.equal(recordMode({ proxied: false }), "DNS only");
});

const pending = (over = {}) => ({
  host: "dash.example.com", phase: "waiting", requestedAt: "", requestedBy: null,
  dns: { status: "missing", resolved: [], detail: "No A or AAAA record for dash.example.com yet.", checkedAt: null },
  probe: { status: "untried", detail: null, checkedAt: null },
  tls: { status: "pending", issuer: null, expiresAt: null, detail: null },
  error: null, cfRecord: null,
  ...over,
});
const states = (p) => Object.fromEntries(domainChecks(p).map((c) => [c.key, c.state]));

test("the three checks say where a new domain stands", () => {
  assert.deepEqual(states(pending()), { dns: "wait", answer: "wait", tls: "wait" });
  assert.deepEqual(states(pending({ dns: { status: "mismatch", resolved: [], detail: "x", checkedAt: null } })), { dns: "bad", answer: "wait", tls: "wait" });
  // Behind Cloudflare: asked and refused, with Cloudflare's own reason.
  const asked = pending({ dns: { status: "mismatch", resolved: [], detail: "x", checkedAt: null }, probe: { status: "failed", detail: "it redirects in a loop", checkedAt: null } });
  assert.equal(states(asked).answer, "bad");
  assert.match(domainChecks(asked).find((c) => c.key === "answer").detail, /loop/);
  assert.deepEqual(states(pending({ dns: { status: "ok", resolved: [], detail: null, checkedAt: null } })), { dns: "ok", answer: "ok", tls: "wait" });
  assert.deepEqual(states(pending({ dns: { status: "ok", resolved: [], detail: null, checkedAt: null }, tls: { status: "active", issuer: "Let's Encrypt", expiresAt: null, detail: null } })), { dns: "ok", answer: "ok", tls: "ok" });
  assert.match(domainChecks(pending()).find((c) => c.key === "tls").detail, /once the domain points here/);
});
