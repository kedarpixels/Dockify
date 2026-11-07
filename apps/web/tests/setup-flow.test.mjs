// First-run setup's steps and the shared email form's checks. Run: node --test tests/
import assert from "node:assert/strict";
import { test } from "node:test";
import { EMAIL_PORTS, EMAIL_PRESETS, emailFormErrors, keepsPassword, presetOfHost, tlsModeFor } from "../components/activity-settings/integrations/email-rules.ts";
import { doneLead, nextStep, setupPlan, stepCount } from "../components/auth/setup-steps.ts";

test("email not set up: connect comes after the account, then the code, then two-factor", () => {
  const plan = setupPlan(false, false);
  assert.deepEqual(plan, ["account", "connect", "verify", "protect"]);
  assert.deepEqual(stepCount(plan, "account"), [1, 4]);
  assert.equal(nextStep(plan, "account"), "connect");
  assert.equal(nextStep(plan, "connect"), "verify");
  assert.deepEqual(stepCount(plan, "protect"), [4, 4]);
  assert.equal(nextStep(plan, "protect"), "done");
});

test("set up later: no code step, and the count stays true", () => {
  const plan = setupPlan(false, true);
  assert.deepEqual(plan, ["account", "connect", "protect"]);
  assert.deepEqual(stepCount(plan, "connect"), [2, 3]);
  assert.equal(nextStep(plan, "connect"), "protect");
  assert.deepEqual(stepCount(plan, "protect"), [3, 3]);
});

test("email from the installer: no connect step, straight to the code", () => {
  const plan = setupPlan(true, false);
  assert.deepEqual(plan, ["account", "verify", "protect"]);
  assert.equal(nextStep(plan, "account"), "verify");
  assert.deepEqual(stepCount(plan, "verify"), [2, 3]);
  assert.deepEqual(stepCount(plan, "protect"), [3, 3]);
});

test("the last card names what was left off", () => {
  assert.match(doneLead("Acme", false, true), /Acme is ready\. Two-factor is off.*Email is off too/);
  assert.doesNotMatch(doneLead("Acme", true, false), /Email is off/);
  assert.match(doneLead("", true, false), /^Dockify is ready, and two-factor is on/);
});

const good = { host: "smtp.example.com", port: 587, tlsMode: "starttls", username: "mailer", password: "a-password", fromName: "Dockify", fromAddress: "dockify@example.com", replyTo: "" };
const stored = { host: "smtp.example.com", username: "mailer", hasPassword: true };
const clean = (e) => Object.values(e).every((x) => x === null);

test("the email form takes a good connect, and a blank password only for the login it was stored for", () => {
  assert.ok(clean(emailFormErrors(good, null)));
  assert.equal(emailFormErrors({ ...good, password: "" }, null).password, "Enter the password");
  assert.equal(emailFormErrors({ ...good, password: "" }, stored).password, null);
  assert.match(emailFormErrors({ ...good, password: "", host: "smtp.other.example" }, stored).password, /Enter the password again/);
  assert.match(emailFormErrors({ ...good, password: "", username: "else" }, stored).password, /Enter the password again/);
  assert.equal(emailFormErrors({ ...good, host: "smtp.other.example" }, stored).password, null);
  assert.equal(keepsPassword({ host: " SMTP.example.com ", username: "mailer" }, stored), true);
  assert.equal(keepsPassword(good, { ...stored, hasPassword: false }), false);
});

test("the email form refuses bad values", () => {
  for (const host of ["", "localhost", "10.0.0.1", "smtp example.com"]) assert.ok(emailFormErrors({ ...good, host }, null).host, host);
  for (const port of [0, 22, 443, 8080]) assert.ok(emailFormErrors({ ...good, port }, null).port, String(port));
  assert.ok(emailFormErrors({ ...good, tlsMode: "off" }, null).tlsMode);
  assert.ok(emailFormErrors({ ...good, username: " " }, null).username);
  assert.ok(emailFormErrors({ ...good, password: "a\r\nb" }, null).password);
  assert.ok(emailFormErrors({ ...good, fromAddress: "nope" }, null).fromAddress);
  assert.ok(emailFormErrors({ ...good, fromName: 'a"b' }, null).fromName);
  assert.ok(emailFormErrors({ ...good, replyTo: "nope" }, null).replyTo);
  assert.equal(emailFormErrors({ ...good, replyTo: "ops@example.com" }, null).replyTo, null);
});

test("a preset only fills fields, each with a port the sender dials and the TLS mode that port uses", () => {
  assert.deepEqual(EMAIL_PORTS, [25, 465, 587, 2465, 2525, 2587]);
  assert.deepEqual(EMAIL_PORTS.map(tlsModeFor), ["starttls", "implicit", "starttls", "implicit", "starttls", "starttls"]);
  for (const p of EMAIL_PRESETS) {
    assert.ok(EMAIL_PORTS.includes(p.port), p.id);
    assert.equal(emailFormErrors({ ...good, host: p.host, port: p.port, tlsMode: tlsModeFor(p.port) }, null).host, null, p.id);
    assert.equal(presetOfHost(p.host), p);
  }
  assert.equal(presetOfHost("smtp.example.com"), null);
});
