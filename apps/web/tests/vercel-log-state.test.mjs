// The Logs tab of an app that follows a Vercel project stayed blank: a 429 and an empty runtime log
// both left nothing to read. These are the lines the card shows instead. Run: npm test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_RUNTIME_LINES, readFailure, STREAM_LOST, wantsBuildLog } from "../components/deployments/vercel-log-state.ts";

test("a 429 says why and what to do, never an empty pane", () => {
  const said = readFailure(429, "Too many log reads at once");
  assert.match(said, /Too many log reads/);
  assert.match(said, /try again/);
});

test("a session that ended, an offline browser and an API error each get their own line", () => {
  assert.match(readFailure(401, "Sign in again"), /Sign in again/);
  assert.match(readFailure(0, ""), /Could not reach the dashboard/);
  assert.equal(readFailure(502, "Vercel could not be reached"), "Could not read the logs. Vercel could not be reached.");
  assert.equal(readFailure(502, null), "Could not read the logs. The API did not answer.");
});

test("an app with no runtime lines shows its latest build log; a deployment page already has one", () => {
  assert.equal(wantsBuildLog({ named: false, runtimeLines: 0, deploymentId: "d1" }), true);
  assert.equal(wantsBuildLog({ named: true, runtimeLines: 0, deploymentId: "d1" }), false);
  assert.equal(wantsBuildLog({ named: false, runtimeLines: 3, deploymentId: "d1" }), false);
  assert.equal(wantsBuildLog({ named: false, runtimeLines: 0, deploymentId: null }), false);
});

test("the empty and lost lines are one short sentence pair, with no dashes", () => {
  for (const s of [NO_RUNTIME_LINES, STREAM_LOST, readFailure(429, "")]) {
    assert.ok(s.length < 140, s);
    assert.doesNotMatch(s, new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
  }
});
