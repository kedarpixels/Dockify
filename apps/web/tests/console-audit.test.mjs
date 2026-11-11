// The console audit's findings in Settings, Activity, Resources, Domains, Alerts and Integrations.
// The pure parts are run; the rest live in components with no render harness here, so these pin the
// line that makes each one hold. Run: npm test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyPatch, instanceDraft, instancePatch, notificationsPatch } from "../components/activity-settings/settings-patch.ts";
import { afterTest } from "../components/activity-settings/integrations/webhook-test.ts";
import { domainSettling, liveResources, onServer } from "../components/resources-domains/live.ts";

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const EVENTS = { deployFailed: true, appDown: true, backupFailed: true, tlsExpiring: true, previewDeployments: false, jobFailed: true };
const SETTINGS = {
  instanceName: "Dockify",
  publicUrl: "https://dash.example.com",
  defaultBranch: "main",
  buildConcurrency: 1,
  logRetentionDays: 14,
  notifications: { events: EVENTS },
  // What the API sends while no custom domain is set: the derived one, flagged as not custom.
  previewDomain: "preview.example.com",
  previewDomainDefault: "preview.example.com",
  previewDomainCustom: false,
  terminalEnabled: true,
};

test("saving Notifications sends the changed events and no other field", () => {
  const patch = notificationsPatch(SETTINGS, { ...EVENTS, appDown: false });
  assert.deepEqual(patch, { notifications: { events: { appDown: false } } });
  assert.equal("previewDomain" in patch, false);
});

test("saving Instance sends only what changed, and never the derived preview domain", () => {
  const draft = instanceDraft(SETTINGS);
  assert.equal(draft.previewDomain, "");
  assert.deepEqual(instancePatch(SETTINGS, draft), {});
  assert.deepEqual(instancePatch(SETTINGS, { ...draft, instanceName: " Box " }), { instanceName: "Box" });
  // Typing the default by hand is still "derive it".
  assert.deepEqual(instancePatch(SETTINGS, { ...draft, previewDomain: "Preview.Example.com" }), {});
  assert.deepEqual(instancePatch(SETTINGS, { ...draft, previewDomain: "pr.example.org", logRetentionDays: "30" }), { logRetentionDays: 30, previewDomain: "pr.example.org" });
});

test("clearing a custom preview domain sends null, and the preview shows the default again", () => {
  const custom = { ...SETTINGS, previewDomain: "pr.example.org", previewDomainCustom: true };
  const patch = instancePatch(custom, { ...instanceDraft(custom), previewDomain: "" });
  assert.deepEqual(patch, { previewDomain: null });
  const after = applyPatch(custom, patch);
  assert.equal(after.previewDomain, "preview.example.com");
  assert.equal(after.previewDomainCustom, false);
  assert.equal(applyPatch(SETTINGS, { notifications: { events: { appDown: false } } }).notifications.events.jobFailed, true);
});

test("the settings action forwards a patch, never the whole object", () => {
  const actions = src("app/(console)/settings/actions.ts");
  assert.match(actions, /export async function saveSettings\(patch: SettingsPatch\)/);
  assert.match(actions, /if \(previewDomain !== undefined\) \{/);
  assert.doesNotMatch(actions, /publicUrl,/);
  assert.match(src("components/activity-settings/settings-draft.ts"), /const change = patch\(data\.settings, sent\);/);
});

const ROW = { id: "a1", name: "web", kind: "frontend", status: "running", projectId: "p", projectSlug: "acme", environment: "production", image: "", cpu: { usedPct: 0, limitCores: 1 }, memory: { usedBytes: 0, reservedBytes: 512 }, volume: null, startedAt: null };

test("an app Vercel hosts is marked, and reserves no memory on this server", () => {
  const rows = liveResources([ROW, { ...ROW, id: "a2", status: "deploying" }], [{ ...ROW, onVercel: true }, { ...ROW, id: "a2", status: "running" }]);
  assert.equal(rows[0].onVercel, true);
  assert.equal(rows[1].status, "running");
  assert.equal(rows[1].onVercel, undefined);
  assert.deepEqual(onServer(rows).map((r) => r.id), ["a2"]);
  // A row the overview has not seen yet keeps what the list said.
  assert.equal(liveResources([ROW], undefined)[0], ROW);
});

test("the resources list is read again on a timer, and a Vercel app never reads Starting", () => {
  const view = src("components/resources-domains/resources-view.tsx");
  assert.match(view, /usePageRefresh\(initial\.source === "api", RESOURCES_POLL_MS\);/);
  assert.match(view, /r\.onVercel \? ON_VERCEL : notRunning\(r\.status\)/);
  assert.match(view, /const here = onServer\(items\);/);
});

test("a domain is followed while the server settles it, not while it waits for its owner", () => {
  const d = (tls, dns, test) => ({ tls: { status: tls }, dns: { status: dns }, test });
  assert.equal(domainSettling(d("pending", "unchecked")), true);
  assert.equal(domainSettling(d("pending", "ok")), true);
  assert.equal(domainSettling(d("pending", "missing", true)), true);
  assert.equal(domainSettling(d("pending", "missing")), false);
  assert.equal(domainSettling(d("active", "ok")), false);
  assert.equal(domainSettling(d("failed", "mismatch")), false);
});

test("the domains list polls while a row settles and drops a list asked for before a local change", () => {
  const view = src("components/resources-domains/domains-view.tsx");
  assert.match(view, /usePageRefresh\(live && items\.some\(domainSettling\), DOMAINS_POLL_MS/);
  assert.match(view, /if \(asked\.current === writes\.current\) setRows\(rows\);/);
});

test("activity takes the whole first page when the log comes back after a failed load", () => {
  const view = src("components/activity-settings/activity-view.tsx");
  assert.match(view, /if \(!items\.length\) \{\s+setItems\(page\.items\);\s+setCursor\(page\.nextCursor\);\s+if \(page\.actors\.length\) setActors\(page\.actors\);/);
});

test("settings lists are read again after the writes that change them", () => {
  const security = src("components/activity-settings/security-section.tsx");
  assert.match(security, /onChanged=\{\(\) => void afterPassword\(\)\}/);
  assert.match(security, /fresh\.ok && fresh\.data \? fresh\.data : data\.sessions\.filter\(\(s\) => s\.current\)/);
  assert.match(src("components/activity-settings/password-dialog.tsx"), /if \(r\.ok\) \{\s+onChanged\(\);/);
  const team = src("components/activity-settings/team-section.tsx");
  assert.match(team, /const tokens = await settle\(readTokens\(\)\);/);
  assert.match(team, /i\.emailStatus === "queued"/);
  assert.match(team, /fresh\.ok && fresh\.data && at === writes\.current/);
});

test("alert history names the window the API keeps", () => {
  assert.match(src("components/alerts/history-card.tsx"), /Last 90 days, newest first/);
  assert.doesNotMatch(src("components/alerts/history-card.tsx"), /7 days/);
  assert.doesNotMatch(src("components/alerts/alerts-skeleton.tsx"), /7 days/);
});

test("only a test that was delivered and refused marks a webhook failing", () => {
  const w = { id: "w1", status: "ok", error: null, lastSentAt: "2026-11-01T00:00:00.000Z", lastFailedAt: null };
  const at = "2026-11-11T00:00:00.000Z";
  assert.equal(afterTest(w, { ok: false, error: "The worker is not running", code: "WORKER_DOWN" }, at), w);
  assert.equal(afterTest(w, { ok: false, error: "The worker is busy", code: "WORKER_BUSY" }, at), w);
  assert.equal(afterTest(w, { ok: false, error: "Could not reach the dashboard" }, at), w);
  assert.deepEqual(afterTest(w, { ok: false, error: "404 from the endpoint", code: "WEBHOOK_FAILED" }, at), { ...w, status: "failing", error: "404 from the endpoint", lastFailedAt: at });
  assert.deepEqual(afterTest({ ...w, status: "failing", error: "old" }, { ok: true }, at), { ...w, status: "ok", error: null, lastSentAt: at });
});

test("a stale read cannot undo a write: jobs, the dashboard domain, a zone switch", () => {
  const jobs = src("components/app-detail/jobs-tab.tsx");
  assert.match(jobs, /const id = \+\+asked\.current;/);
  assert.match(jobs, /if \(id !== asked\.current\) return;/);
  const flow = src("components/dashboard-domain/flow.tsx");
  assert.match(flow, /writes\.current \+= 1;\s+setState\(r\.data\);/);
  assert.match(flow, /if \(r\.ok && at === writes\.current\) setState\(r\.data\);/);
  const cf = src("components/activity-settings/integrations/cloudflare-card.tsx");
  assert.match(cf, /if \(inFlight\.current\.has\(zone\.id\)\) return;/);
  assert.match(cf, /disabled=\{busy\}/);
});

test("no dashes in what these files say", () => {
  const dash = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
  for (const f of [
    "components/activity-settings/settings-patch.ts",
    "components/activity-settings/integrations/webhook-test.ts",
    "components/resources-domains/live.ts",
    "components/resources-domains/refresh.ts",
    "components/alerts/history-card.tsx",
  ]) assert.doesNotMatch(src(f), dash, f);
});
