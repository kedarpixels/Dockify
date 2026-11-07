/**
 * Notification webhooks, alert rule links and the GitHub App created from the dashboard, through
 * the real routes against a real Postgres. Runs only when DATABASE_URL_TEST points at a scratch
 * database with the migrations applied (see auth.integration.test.ts). Every table is truncated
 * before each test. Nothing leaves the process: the integrations plugin gets a fake http client.
 */
import { createHmac, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@dockify/db";
import type { HttpRequest, HttpResponse } from "@dockify/net-guard";
import { buildApp } from "./app.ts";
import { ensureInstance } from "./boot.ts";
import { defaultDeps } from "./modules/integrations/deps.ts";
import { testConfig, testRing } from "./test-helpers.ts";

const url = process.env.DATABASE_URL_TEST;
const ring = testRing();
const ORIGIN = "https://dockify.test";

const SLACK_TOKEN = "abcdEFGHijklMNOPqrstUVWX";
const SLACK = `https://hooks.slack.com/services/T0ABCDEF12/B0ABCDEF34/${SLACK_TOKEN}`;
const DISCORD = `https://discord.com/api/webhooks/123456789012345678/${"a1B2-c3_D4".repeat(7)}`;
const BOT = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const HOSTILE_SVG = '<svg viewBox="0 0 24 24" onload="alert(1)"><script>steal()</script><path d="M2 2h20v20H2z"/></svg>';

describe.skipIf(!url)("webhooks, alert links and the GitHub App (postgres)", () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let sent: HttpRequest[] = [];
  let answer: (r: HttpRequest) => HttpResponse = () => ({ status: 200, headers: {}, body: Buffer.from("ok") });

  beforeAll(async () => {
    db = createDb(url);
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    const tables = await db.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'servers')`;
    await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
    await ensureInstance(db, ring, ORIGIN, "direct_tls");
    sent = [];
    answer = () => ({ status: 200, headers: {}, body: Buffer.from("ok") });
    const http = async (r: HttpRequest) => {
      sent.push(r);
      return answer(r);
    };
    await app?.close();
    ({ app } = await buildApp({ db, ring, config: testConfig(), logger: false, integrationDeps: defaultDeps({ http, inlineWebhookTests: true }) }));
  });

  const jar = (res: { headers: Record<string, unknown> }): string => {
    const raw = res.headers["set-cookie"];
    const lines = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    return lines.map((l) => String(l).split(";")[0] ?? "").filter((p) => !p.endsWith("=")).join("; ");
  };
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT", path: string, cookie: string, payload?: unknown) =>
    app.inject({ method, url: path, headers: { origin: ORIGIN, cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const owner = async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/setup", headers: { origin: ORIGIN },
      payload: { instanceName: "Acme", name: "Owner", email: "owner@example.com", password: "correct horse battery" },
    });
    expect(res.statusCode).toBe(200);
    const cookie = jar(res);
    expect((await call("POST", "/api/v1/auth/step-up", cookie, { password: "correct horse battery" })).statusCode).toBe(200);
    return cookie;
  };

  it("stores a Slack webhook sealed, answers only its host and hint, and asks for step-up first", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/setup", headers: { origin: ORIGIN },
      payload: { instanceName: "Acme", name: "Owner", email: "owner@example.com", password: "correct horse battery" },
    });
    const fresh = jar(res);
    const refused = await call("POST", "/api/v1/integrations/webhooks", fresh, { url: SLACK });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "STEP_UP_REQUIRED" });

    expect((await call("POST", "/api/v1/auth/step-up", fresh, { password: "correct horse battery" })).statusCode).toBe(200);
    const made = await call("POST", "/api/v1/integrations/webhooks", fresh, { url: SLACK });
    expect(made.statusCode).toBe(201);
    expect(made.body).not.toContain(SLACK_TOKEN);
    const w = made.json().webhook;
    expect(w).toMatchObject({ name: "Slack", provider: "slack", host: "hooks.slack.com", hint: "UVWX", enabled: true, updates: true, status: "never", signingSecretHint: null });
    expect(made.json().signingSecret).toBeNull();

    const secret = await db.secret.findFirstOrThrow({ where: { ownerType: "webhook", ownerId: w.id } });
    expect(secret).toMatchObject({ kind: "channel_url", hint: "UVWX" });
    expect(Buffer.from(secret.ciphertext).toString("latin1")).not.toContain(SLACK_TOKEN);

    const list = await call("GET", "/api/v1/integrations/webhooks", fresh);
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(SLACK_TOKEN);
    // A second webhook of the same provider gets the next free name; a name asked for is never renamed.
    expect((await call("POST", "/api/v1/integrations/webhooks", fresh, { url: SLACK })).json().webhook.name).toBe("Slack 2");
    expect((await call("POST", "/api/v1/integrations/webhooks", fresh, { url: SLACK, name: "slack" })).json()).toMatchObject({ code: "NAME_TAKEN" });
  });

  it("refuses an endpoint net-guard refuses, and a logo on a built-in provider", async () => {
    const cookie = await owner();
    for (const bad of ["https://10.0.0.5/hook", "https://metadata.google.internal/x", "http://hooks.example.com/x", "https://hooks.example.com@evil.example/x"]) {
      const r = await call("POST", "/api/v1/integrations/webhooks", cookie, { url: bad });
      expect(r.statusCode, bad).toBe(400);
    }
    const logo = await call("POST", "/api/v1/integrations/webhooks", cookie, { url: SLACK, logo: { choice: "url", url: "https://cdn.example.com/x.png" } });
    expect(logo.statusCode).toBe(400);
    expect(logo.json()).toMatchObject({ field: "logo" });
    expect(sent).toEqual([]);
  });

  it("makes a generic webhook's signing secret once, signs with it, and rotates it", async () => {
    const cookie = await owner();
    const made = (await call("POST", "/api/v1/integrations/webhooks", cookie, { url: "https://hooks.example.com/dockify", name: "Ops relay" })).json();
    const secret = made.signingSecret as string;
    expect(secret).toMatch(/^dkwh_/);
    expect(made.webhook).toMatchObject({ provider: "generic", signingSecretHint: secret.slice(-4) });
    // Its automatic icon is its site's favicon, which the worker fetches.
    const job = await db.job.findFirst({ where: { kind: "icon_fetch" } });
    expect(job?.payload).toEqual({ webhookId: made.webhook.id });

    const test = await call("POST", "/api/v1/integrations/webhooks/test", cookie, { id: made.webhook.id });
    expect(test.statusCode).toBe(200);
    const req = sent[0]!;
    const ts = req.headers!["X-Dockify-Timestamp"]!;
    expect(req.headers!["X-Dockify-Signature"]).toBe(`sha256=${createHmac("sha256", secret).update(`${ts}.${String(req.body)}`).digest("hex")}`);
    expect(JSON.parse(String(req.body))).toMatchObject({ version: 1, event: "test", instance: { name: "Acme", url: ORIGIN } });

    const rotated = (await call("PATCH", `/api/v1/integrations/webhooks/${made.webhook.id}`, cookie, { signingSecret: "rotate" })).json();
    expect(rotated.signingSecret).toMatch(/^dkwh_/);
    expect(rotated.signingSecret).not.toBe(secret);
    expect(await db.secret.count({ where: { kind: "channel_secret" } })).toBe(1);
    // A plain change answers no secret.
    expect((await call("PATCH", `/api/v1/integrations/webhooks/${made.webhook.id}`, cookie, { enabled: false })).json()).toMatchObject({ signingSecret: null, webhook: { enabled: false } });
  });

  it("stores an uploaded SVG logo rebuilt, and serves it inert and versioned", async () => {
    const cookie = await owner();
    const made = (await call("POST", "/api/v1/integrations/webhooks", cookie, {
      url: "https://hooks.example.com/x", logo: { choice: "upload", image: Buffer.from(HOSTILE_SVG).toString("base64") },
    })).json();
    const icon = made.webhook.icon;
    expect(icon).toMatchObject({ choice: "upload", logoUrl: null, image: { source: "upload", width: 24, height: 24 } });
    const got = await call("GET", `/api/v1/integrations/webhooks/${made.webhook.id}/icon?v=${icon.image.version}`, cookie);
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/svg+xml");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(got.headers["cache-control"]).toContain("immutable");
    expect(got.body).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>');
    // No favicon fetch for a webhook with its own logo.
    expect(await db.job.count({ where: { kind: "icon_fetch" } })).toBe(0);
  });

  it("downloads a logo link once through net-guard's client and keeps where it came from", async () => {
    const cookie = await owner();
    answer = (r) => (r.url === "https://brand.example.com/logo"
      ? { status: 302, headers: { location: "https://cdn.example.com/logo.svg" }, body: Buffer.alloc(0) }
      : { status: 200, headers: {}, body: Buffer.from(HOSTILE_SVG) });
    const made = (await call("POST", "/api/v1/integrations/webhooks", cookie, { url: "https://hooks.example.com/x", logo: { choice: "url", url: "https://brand.example.com/logo" } })).json();
    expect(made.webhook.icon).toMatchObject({ choice: "upload", logoUrl: "https://brand.example.com/logo" });
    expect(sent.map((r) => [r.method, r.url])).toEqual([["GET", "https://brand.example.com/logo"], ["GET", "https://cdn.example.com/logo.svg"]]);
    const row = await db.iconImage.findFirstOrThrow({ where: { webhookId: made.webhook.id } });
    expect(row).toMatchObject({ source: "upload", mime: "image/svg+xml", origin: "https://cdn.example.com/logo.svg" });
  });

  it("sends a test to a saved webhook, records the outcome, and never echoes the URL", async () => {
    const cookie = await owner();
    const w = (await call("POST", "/api/v1/integrations/webhooks", cookie, { url: SLACK })).json().webhook;
    const ok = await call("POST", "/api/v1/integrations/webhooks/test", cookie, { id: w.id });
    expect(ok.json()).toMatchObject({ provider: "slack", status: 200 });
    expect(sent[0]).toMatchObject({ method: "POST", url: SLACK });
    expect(JSON.parse(String(sent[0]!.body))).toMatchObject({ blocks: expect.any(Array) });
    expect((await call("GET", "/api/v1/integrations/webhooks", cookie)).json()[0]).toMatchObject({ status: "ok", error: null });

    answer = () => ({ status: 404, headers: {}, body: Buffer.from("no_service") });
    const failed = await call("POST", "/api/v1/integrations/webhooks/test", cookie, { id: w.id });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ code: "WEBHOOK_FAILED", error: "Slack answered 404 (no_service)" });
    expect(failed.body).not.toContain(SLACK_TOKEN);
    expect((await call("GET", "/api/v1/integrations/webhooks", cookie)).json()[0]).toMatchObject({ status: "failing", error: "Slack answered 404 (no_service)" });
  });

  it("tests a draft before it is saved, and stores nothing", async () => {
    const cookie = await owner();
    const r = await call("POST", "/api/v1/integrations/webhooks/test", cookie, { provider: "telegram", botToken: BOT, chatId: "-100123" });
    expect(r.statusCode).toBe(200);
    expect(sent[0]!.url).toBe(`https://api.telegram.org/bot${BOT}/sendMessage`);
    expect(JSON.parse(String(sent[0]!.body))).toMatchObject({ chat_id: "-100123", parse_mode: "HTML" });
    expect(await db.notificationWebhook.count()).toBe(0);
  });

  it("keeps Telegram's token sealed and shows its chat", async () => {
    const cookie = await owner();
    const made = await call("POST", "/api/v1/integrations/webhooks", cookie, { provider: "telegram", botToken: BOT, chatId: "@dockify_ops", name: "Ops chat" });
    expect(made.statusCode).toBe(201);
    expect(made.body).not.toContain("AAHdqTcvCH1v");
    expect(made.json().webhook).toMatchObject({ provider: "telegram", host: "api.telegram.org", chatId: "@dockify_ops", hint: "Dsaw" });
  });

  it("links alert rules to webhooks, refuses a channel that is not email or the bell, and drops links with the webhook", async () => {
    const cookie = await owner();
    const slack = (await call("POST", "/api/v1/integrations/webhooks", cookie, { url: SLACK })).json().webhook;
    const discord = (await call("POST", "/api/v1/integrations/webhooks", cookie, { url: DISCORD })).json().webhook;
    const rule = await call("POST", "/api/v1/alerts/rules", cookie, { metric: "disk", appId: null, service: null, threshold: null, durationMin: 5, channels: ["email"], webhooks: [slack.id], enabled: true });
    expect(rule.statusCode).toBe(200);
    expect(rule.json()).toMatchObject({ channels: ["email"], webhooks: [slack.id] });

    expect((await call("POST", "/api/v1/alerts/rules", cookie, { metric: "disk", appId: null, service: null, threshold: null, durationMin: 5, channels: ["discord", "bell"], enabled: true })).statusCode).toBe(400);
    const second = (await call("POST", "/api/v1/alerts/rules", cookie, { metric: "disk", appId: null, service: null, threshold: null, durationMin: 5, channels: ["bell"], webhooks: [discord.id], enabled: true })).json();
    expect(second).toMatchObject({ channels: ["bell"], webhooks: [discord.id] });

    const unknown = await call("PATCH", `/api/v1/alerts/rules/${second.id}`, cookie, { webhooks: ["00000000-0000-4000-8000-000000000000"] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ field: "webhooks" });
    // A rule with nowhere left to send keeps the bell.
    expect((await call("PATCH", `/api/v1/alerts/rules/${second.id}`, cookie, { channels: [], webhooks: [] })).json()).toMatchObject({ channels: ["bell"], webhooks: [] });

    const alerts = (await call("GET", "/api/v1/alerts", cookie)).json();
    expect(alerts.webhooks.map((w: { name: string; provider: string }) => [w.name, w.provider])).toEqual([["Slack", "slack"], ["Discord", "discord"]]);
    expect(alerts.channels).toEqual({ discord: true, webhook: false, email: false });

    expect((await call("DELETE", `/api/v1/integrations/webhooks/${slack.id}`, cookie)).statusCode).toBe(204);
    expect((await call("GET", "/api/v1/alerts", cookie)).json().rules.find((r: { id: string }) => r.id === rule.json().id).webhooks).toEqual([]);
    expect(await db.secret.count({ where: { ownerId: slack.id } })).toBe(0);
  });

  it("creates the GitHub App from the manifest, keeps every credential sealed, and forgets it on request", async () => {
    const cookie = await owner();
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const CLIENT_SECRET = "0123456789abcdef0123456789abcdef01234567";
    answer = (r) => (r.url === "https://api.github.com/app-manifests/code123/conversions"
      ? {
          status: 201, headers: {},
          body: Buffer.from(JSON.stringify({
            id: 4242, slug: "dockify-dockify-test", client_id: "Iv1.0123456789abcdef", client_secret: CLIENT_SECRET, webhook_secret: "whsec-0123456789abcdef",
            pem, html_url: "https://github.com/apps/dockify-dockify-test", owner: { login: "acme", type: "Organization" },
          })),
        }
      : { status: 404, headers: {}, body: Buffer.alloc(0) });

    const manifest = await call("POST", "/api/v1/git/app/manifest", cookie, { organization: "acme" });
    expect(manifest.statusCode).toBe(200);
    const m = manifest.json();
    expect(m.postUrl).toMatch(/^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=/);
    expect(m.manifest).toMatchObject({
      name: expect.stringMatching(/^dockify-[0-9a-f]{6}$/), url: ORIGIN, redirect_url: `${ORIGIN}/api/v1/git/app/callback`, setup_url: `${ORIGIN}/api/v1/git/setup`,
      hook_attributes: { url: `${ORIGIN}/api/v1/webhooks/github`, active: true }, default_events: ["push", "pull_request"],
    });
    const state = new URL(m.postUrl).searchParams.get("state")!;

    // GitHub sends the browser back cross-site: no cookie rides along, the state is the credential.
    const back = await app.inject({ method: "GET", url: `/api/v1/git/app/callback?code=code123&state=${encodeURIComponent(state)}` });
    expect(back.statusCode).toBe(200);
    expect(back.body).toContain(`url=${ORIGIN}/settings?section=integrations&github=app-created`);
    const replay = await app.inject({ method: "GET", url: `/api/v1/git/app/callback?code=code123&state=${encodeURIComponent(state)}` });
    expect(replay.body).toContain("github=app-failed");

    const summary = (await call("GET", "/api/v1/integrations", cookie)).json();
    expect(summary.github.app).toMatchObject({ slug: "dockify-dockify-test", htmlUrl: "https://github.com/apps/dockify-dockify-test", owner: { login: "acme", type: "Organization" }, source: "manifest" });
    const row = await db.integration.findFirstOrThrow({ where: { kind: "github_app" } });
    const kinds = (await db.secret.findMany({ where: { ownerType: "integration", ownerId: row.id }, select: { kind: true, ciphertext: true } }));
    expect(kinds.map((k) => k.kind).sort()).toEqual(["github_client_secret", "github_private_key", "github_webhook_secret"]);
    for (const k of kinds) expect(Buffer.from(k.ciphertext).toString("latin1")).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(row.config)).not.toContain(CLIENT_SECRET);
    expect((await call("POST", "/api/v1/git/app/manifest", cookie, {})).json()).toMatchObject({ code: "GITHUB_APP_EXISTS" });

    expect((await call("DELETE", "/api/v1/git/app", cookie)).statusCode).toBe(204);
    expect(await db.integration.count({ where: { kind: "github_app" } })).toBe(0);
    expect(await db.secret.count({ where: { ownerType: "integration", ownerId: row.id } })).toBe(0);
    expect((await call("GET", "/api/v1/integrations", cookie)).json().github.app).toBeNull();
    // With the App gone, a new one can be created.
    expect((await call("POST", "/api/v1/git/app/manifest", cookie, {})).statusCode).toBe(200);
  });

  it("refuses a manifest callback with a forged state, and stores nothing", async () => {
    await owner();
    const back = await app.inject({ method: "GET", url: "/api/v1/git/app/callback?code=code123&state=forged.state" });
    expect(back.body).toContain("github=app-failed");
    expect(await db.integration.count({ where: { kind: "github_app" } })).toBe(0);
    expect(sent).toEqual([]);
  });
});
