// The final backend audit's web findings. A restore's wait is pure and run; the rest live in
// components with no render harness here, so these pin the line that makes each one hold.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { followRestore } from "../components/server-backups/restore-follow.ts";

const src = (p) => readFileSync(new URL(`../components/${p}`, import.meta.url), "utf8");
const DONE = { ok: true, finishedAt: "2026-11-07T00:00:00.000Z", database: { name: "db", projectSlug: "acme", environment: "prod", deletedAt: null, resourceId: "r1" } };
const ACCEPTED = { jobId: "j1", resourceId: "r1", status: "queued" };
const noWait = async () => {};
const answers = (...list) => {
  const seen = [];
  return { seen, read: async (id) => (seen.push(id), list.shift()) };
};

test("a restore that answered at once needs no following", async () => {
  const a = answers();
  assert.equal(await followRestore(DONE, a.read, noWait), DONE);
  assert.deepEqual(a.seen, []);
});

test("a 202 is no failure: it follows the job to its real outcome, whatever a read says on the way", async () => {
  const a = answers(
    { ok: true, data: { status: "running", error: null } },
    { ok: false, status: 502, error: "Bad gateway" },
    { ok: false, status: 0, error: "offline" },
    { ok: true, data: null },
    { ok: true, data: DONE },
  );
  assert.equal(await followRestore(ACCEPTED, a.read, noWait), DONE);
  assert.deepEqual(a.seen, ["j1", "j1", "j1", "j1", "j1"]);
});

test("the worker's reason is what a failed restore reports", async () => {
  const a = answers({ ok: true, data: { status: "failed", error: "psql exited with code 3" } });
  await assert.rejects(followRestore(ACCEPTED, a.read, noWait), /psql exited with code 3/);
});

test("only a job that is really gone ends the wait", async () => {
  await assert.rejects(followRestore(ACCEPTED, answers({ ok: false, status: 404, error: "That restore does not exist" }).read, noWait), /does not exist/);
});

test("both restore toasts follow the job", () => {
  for (const f of ["server-backups/backups-view.tsx", "app-detail/backups-tab.tsx"]) assert.match(src(f), /followRestore\(first, readRestore\(run\.id\)\)/, f);
});

test("a failed read keeps the page: the update toast's card and an open restore dialog stay mounted", () => {
  assert.match(src("server-backups/server-view.tsx"), /usePoll\(initial, "\/api\/server", 15_000, hasServer\)/);
  assert.match(src("server-backups/backups-view.tsx"), /fast \? 4_000 : 20_000, hasBackups\)/);
});

test("the update toast keeps asking, and says silence only when there is silence", () => {
  const s = src("server-backups/server-updates.tsx");
  assert.match(s, /heard\.current = Date\.now\(\);/);
  assert.doesNotMatch(s, /toastId\.current = null;\n\s+return;\n\s+}\n\s+timer = setTimeout/);
});

test("server actions that hold a dialog or a row busy are settled, so a rejection cannot trap the user", () => {
  const cases = {
    "activity-settings/team-section.tsx": [/settle\(elevate\(\(\) => createInvite/, /settle\(elevate\(\(\) => saveTeam\(change\)/, /settle\(elevate\(\(\) => revokeInvite/],
    "activity-settings/tokens-section.tsx": [/settle\(elevate\(\(\) => createToken/],
    "activity-settings/two-factor.tsx": [/settle\(elevate\(\(\) => setupTwoFactor/, /settle\(elevate\(\(\) => verifyTwoFactor/],
    "activity-settings/settings-draft.ts": [/settle\(elevate\(\(\) => saveSettings/],
  };
  for (const [f, res] of Object.entries(cases)) {
    for (const re of res) assert.match(src(f), re, f);
    assert.doesNotMatch(src(f).replaceAll("settle(elevate(", ""), /await elevate\(/, f);
  }
});

test("the backups tab's timer comes back after a failed read", () => {
  assert.match(src("app-detail/backups-tab.tsx"), /\[b, running, testRunning, q\.loading, preview, reload, patch\]/);
});

test("a log stream an HTTP error closed falls back at once", () => {
  for (const f of ["deployments/deployment-view.tsx", "deployments/vercel-runtime-logs.tsx"]) assert.match(src(f), /misses < 4 && es\??\.readyState !== EventSource\.CLOSED/, f);
  assert.match(src("deployments/deployment-view.tsx"), /if \(settled && r\.ok\)/);
});

test("the project and app pages take what the server sends after a change", () => {
  assert.match(src("project-detail/project-view.tsx"), /if \(page !== seenPage\) \{\n\s+setSeenPage\(page\);\n\s+setSaved\(null\);/);
  const app = src("project-detail/app-view.tsx");
  assert.match(app, /OP_STATUS\[op\], at: new Date\(\)\.toISOString\(\) \}\);\n\s+router\.refresh\(\);/);
  assert.match(app, /lastPolled\.current = polled;\n\s+router\.refresh\(\);/);
});

test("closing Confirm it is you on a scheduled job shows no error", () => {
  assert.equal(src("app-detail/jobs-tab.tsx").match(/!r\.aborted && !wasCancelled\(r\)/g).length, 3);
});

test("a large paste through the browser's own shortcut is refused too", () => {
  assert.match(src("app-detail/terminal-view.tsx"), /el\.addEventListener\("paste", guardPaste, \{ capture: true \}\)/);
});
