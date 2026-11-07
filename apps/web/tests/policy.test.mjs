// The web's shared rules: the same-origin write guard, the step-up refusal, the password policy
// and the reserved project names. Run: npm test (Node 22.18+ strips the types of the imports).
import assert from "node:assert/strict";
import { test } from "node:test";
import { crossSiteRefusal } from "../lib/same-origin.ts";
import { isStepUpCancel, isStepUpRefusal, STEP_UP_CANCELLED, STEP_UP_MESSAGE, STEP_UP_MINUTES, STEP_UP_REQUIRED, stepUpRefusal } from "../lib/step-up.ts";
import { MIN_PASSWORD, newPasswordProblem, scorePassword } from "../lib/password.ts";
import { BRANCH_NAME, ENV_NAME, isReservedProjectSlug, projectNameProblem } from "../lib/validation.ts";

const h = (o) => new Headers(o);

test("a write passes only from this exact origin", () => {
  assert.equal(crossSiteRefusal(h({ "sec-fetch-site": "same-origin" })), null);
  // A sibling subdomain (an app this server hosts) is same-site, not same-origin.
  assert.ok(crossSiteRefusal(h({ "sec-fetch-site": "same-site" })));
  assert.ok(crossSiteRefusal(h({ "sec-fetch-site": "cross-site", origin: "https://dockify.example.com", host: "dockify.example.com" })));
  assert.ok(crossSiteRefusal(h({ "sec-fetch-site": "none" })));
});

test("without Sec-Fetch-Site the Origin must match the forwarded host, then Host", () => {
  assert.equal(crossSiteRefusal(h({ origin: "https://dockify.example.com", host: "dockify.example.com" })), null);
  assert.equal(crossSiteRefusal(h({ origin: "https://dockify.example.com", "x-forwarded-host": "dockify.example.com", host: "web:3000" })), null);
  assert.ok(crossSiteRefusal(h({ origin: "https://evil.example", host: "dockify.example.com" })));
  assert.ok(crossSiteRefusal(h({ origin: "null", host: "dockify.example.com" })));
  // Neither header on a write: not a browser request from this dashboard.
  assert.ok(crossSiteRefusal(h({ host: "dockify.example.com" })));
});

test("a step-up refusal is recognised in every shape, and its text is never the raw code", () => {
  const r = stepUpRefusal();
  assert.deepEqual(r, { ok: false, error: STEP_UP_MESSAGE, code: STEP_UP_REQUIRED });
  assert.notEqual(r.error, STEP_UP_REQUIRED);
  assert.ok(isStepUpRefusal(r));
  assert.ok(isStepUpRefusal(Object.assign(new Error(STEP_UP_MESSAGE), { code: STEP_UP_REQUIRED })));
  // A path that passed the API's own answer through untouched still counts.
  assert.ok(isStepUpRefusal({ ok: false, error: "step_up_required" }));
  assert.ok(!isStepUpRefusal({ ok: false, error: "You do not have access to this" }));
  assert.ok(!isStepUpRefusal({ ok: true }));
  assert.ok(!isStepUpRefusal(null));
  assert.ok(isStepUpCancel({ ok: false, error: STEP_UP_MESSAGE, code: STEP_UP_CANCELLED }));
  assert.ok(!isStepUpCancel(r));
  // The window the copy states is the one the API grants (ELEVATION_MS in apps/api/src/actor.ts).
  assert.equal(STEP_UP_MINUTES, 5);
});

test("a new password needs 12 characters, and the meter agrees", () => {
  assert.equal(MIN_PASSWORD, 12);
  assert.equal(newPasswordProblem("a".repeat(11)), "Use at least 12 characters");
  assert.equal(newPasswordProblem("a".repeat(12)), null);
  assert.ok(newPasswordProblem("a".repeat(257)));
  assert.equal(scorePassword("Short1!").label, "Too short");
  assert.equal(scorePassword("aaaaaaaaaaaa").label, "Weak");
  assert.ok(scorePassword("correct-Horse-battery-9").score >= 3);
});

test("no project may be named new, the New project address", () => {
  assert.ok(isReservedProjectSlug("new"));
  assert.ok(isReservedProjectSlug(" NEW "));
  assert.ok(!isReservedProjectSlug("newsroom"));
  assert.equal(projectNameProblem("new"), "That name is reserved");
  assert.equal(projectNameProblem("shop", ["shop"]), "A project called shop already exists");
  assert.equal(projectNameProblem("-shop"), "Lowercase letters, numbers and hyphens, up to 40 characters, not starting or ending with a hyphen");
  assert.equal(projectNameProblem("shop"), null);
});

test("every environment name the API accepts passes, a leading digit included", () => {
  for (const ok of ["production", "dev", "2026q1", "eu-1"]) assert.ok(ENV_NAME.test(ok), ok);
  for (const bad of ["", "-dev", "Dev", "a".repeat(33), "dev_1"]) assert.ok(!ENV_NAME.test(bad), bad);
});

test("one branch rule: no leading, trailing or double slash, no dot pair, at most 200 characters", () => {
  for (const ok of ["main", "feature/login", "release-1.2", "a".repeat(200)]) assert.ok(BRANCH_NAME.test(ok), ok);
  for (const bad of ["", "/main", "main/", "a//b", "a..b", "a".repeat(201), "has space"]) assert.ok(!BRANCH_NAME.test(bad), bad);
});
