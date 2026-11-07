/**
 * Full auth flows against a real Postgres. Runs only when DATABASE_URL_TEST points at a scratch
 * database that already has the migrations applied (docker compose up postgres, then
 * DATABASE_URL=$DATABASE_URL_TEST pnpm db:migrate). Every table is truncated before each test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "@dockify/db";
import { runAdmin } from "./admin.ts";
import { buildApp } from "./app.ts";
import { ensureInstance } from "./boot.ts";
import { testConfig, testRing } from "./test-helpers.ts";
import { totpAt } from "./totp.ts";

const url = process.env.DATABASE_URL_TEST;
const ring = testRing();
const ORIGIN = "https://dockify.test";

describe.skipIf(!url)("auth flows (postgres)", () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];

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
    await app?.close();
    ({ app } = await buildApp({ db, ring, config: testConfig(), logger: false }));
  });

  const jar = (res: { headers: Record<string, unknown> }): string => {
    const raw = res.headers["set-cookie"];
    const lines = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    return lines.map((l) => String(l).split(";")[0] ?? "").filter((p) => !p.endsWith("=")).join("; ");
  };
  const post = (path: string, payload: unknown, cookie?: string) =>
    app.inject({ method: "POST", url: path, payload: payload as object, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });

  const setup = async () => {
    const res = await post("/api/v1/auth/setup", { instanceName: "Test", name: "Owner", email: "owner@example.com", password: "correct horse battery" });
    expect(res.statusCode).toBe(200);
    return jar(res);
  };

  it("names the primary server when it makes the instance row, at setup, and keeps its ingress true", async () => {
    const primary = () => db.server.findFirstOrThrow({ where: { isPrimary: true }, select: { name: true, ingress: true, state: true } });
    expect(await primary()).toEqual({ name: "Dockify", ingress: "direct_tls", state: "active" });
    await setup();
    expect((await primary()).name).toBe("Test");
    // What an existing install reads after the migration: nothing ever wrote instance.ingressMode.
    await db.server.updateMany({ where: { isPrimary: true }, data: { ingress: "cloudflare_tunnel" } });
    await ensureInstance(db, ring, ORIGIN, "direct_tls");
    expect(await primary()).toEqual({ name: "Test", ingress: "direct_tls", state: "active" });
  });

  it("creates the first admin once, then refuses", async () => {
    // emailEnabled is public on purpose: the login page uses it to offer "Forgot password".
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/setup-status" })).json()).toEqual({ needsSetup: true, emailEnabled: false });
    const cookie = await setup();
    expect(cookie).toContain("__Host-dockify_sid=");
    const again = await post("/api/v1/auth/setup", { instanceName: "X", name: "Y", email: "y@example.com", password: "another long password" });
    expect(again.statusCode).toBe(409);
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    expect(me.json()).toMatchObject({ email: "owner@example.com", role: "admin" });
  });

  it("signs in, refuses a wrong password with one message, and signs out", async () => {
    await setup();
    const bad = await post("/api/v1/auth/login", { email: "owner@example.com", password: "wrong" });
    expect(bad.statusCode).toBe(401);
    const nobody = await post("/api/v1/auth/login", { email: "ghost@example.com", password: "wrong" });
    expect(nobody.json().error).toBe(bad.json().error);

    const ok = await post("/api/v1/auth/login", { email: "OWNER@example.com", password: "correct horse battery" });
    expect(ok.json()).toEqual({ next: "done" });
    const cookie = jar(ok);
    expect((await post("/api/v1/auth/logout", {}, cookie)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } })).statusCode).toBe(401);
  });

  const stepUp = async (cookie: string) => {
    expect((await post("/api/v1/auth/step-up", { password: "correct horse battery" }, cookie)).statusCode).toBe(200);
  };

  it("refuses to start or confirm MFA without a fresh step-up", async () => {
    const owner = await setup();
    expect((await post("/api/v1/me/2fa/setup", {}, owner)).json()).toMatchObject({ code: "STEP_UP_REQUIRED" });
    expect((await post("/api/v1/me/2fa/verify", { code: "123456" }, owner)).json()).toMatchObject({ code: "STEP_UP_REQUIRED" });
  });

  /** Turns two-factor on for the signed-in owner and answers the TOTP secret. */
  const enableTotp = async (owner: string) => {
    await stepUp(owner);
    const { secret } = (await post("/api/v1/me/2fa/setup", {}, owner)).json() as { secret: string };
    const enable = await post("/api/v1/me/2fa/verify", { code: totpAt(secret, Date.now()) }, owner);
    expect(enable.statusCode).toBe(204);
    return secret;
  };

  it("enables TOTP, then requires it at sign in and refuses a replayed code", async () => {
    const owner = await setup();
    const secret = await enableTotp(owner);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: owner } })).json()).toMatchObject({ twoFactor: { enabled: true } });

    const login = await post("/api/v1/auth/login", { email: "owner@example.com", password: "correct horse battery" });
    expect(login.json()).toEqual({ next: "verify" });
    const pending = jar(login);
    // The step accepted at enable time is spent, so the same code must not pass again.
    const replay = await post("/api/v1/auth/verify", { code: totpAt(secret, Date.now()) }, pending);
    expect(replay.statusCode).toBe(401);
    // Only a 6-digit authenticator code is a second factor: anything else is refused outright.
    expect((await post("/api/v1/auth/verify", { code: "abcd-efgh-ijkl-mnop" }, pending)).statusCode).toBe(400);

    // The next step's code has not been spent, so it signs in.
    const next = totpAt(secret, Date.now() + 30_000);
    const ok = await post("/api/v1/auth/verify", { code: next, remember: true }, pending);
    expect(ok.statusCode).toBe(200);
    expect(jar(ok)).toContain("__Host-dockify_trust=");
  });

  it("lets the host owner turn two-factor off with the CLI, ending every session", async () => {
    const owner = await setup();
    await enableTotp(owner);
    expect(await runAdmin(db, "disable-mfa", "owner@example.com")).toMatch(/Two-factor sign-in is off for owner@example.com/);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: owner } })).statusCode).toBe(401);
    const login = await post("/api/v1/auth/login", { email: "owner@example.com", password: "correct horse battery" });
    expect(login.json()).toEqual({ next: "done" });
    expect(await db.activityLog.count({ where: { action: "admin.disable-mfa" } })).toBe(1);
  });

  it("lets the host owner reset a password with the CLI, and two-factor stays on", async () => {
    const owner = await setup();
    await enableTotp(owner);
    const out = await runAdmin(db, "reset-password", "owner@example.com");
    const password = /New password for owner@example\.com: (\S+)/.exec(out)?.[1] ?? "";
    expect(password.length).toBeGreaterThanOrEqual(20);
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: owner } })).statusCode).toBe(401);
    expect((await post("/api/v1/auth/login", { email: "owner@example.com", password: "correct horse battery" })).statusCode).toBe(401);
    const login = await post("/api/v1/auth/login", { email: "owner@example.com", password });
    expect(login.json()).toEqual({ next: "verify" });
  });

  it("steps up with the password when MFA is off, and elevated routes need it", async () => {
    const owner = await setup();
    // A valid body both times, so the only difference is the step-up. The project scope is required.
    const body = { name: "ci", scope: "read", expiresInDays: 30, projects: "all" };
    const before = await post("/api/v1/tokens", body, owner);
    expect(before.json()).toMatchObject({ error: "step_up_required" });
    const wrong = await post("/api/v1/auth/step-up", { password: "nope" }, owner);
    expect(wrong.statusCode).toBe(401);
    const ok = await post("/api/v1/auth/step-up", { password: "correct horse battery" }, owner);
    expect(ok.json().expiresAt).toBeTruthy();
    const after = await post("/api/v1/tokens", body, owner);
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({ token: { name: "ci", scope: "read", allProjects: true } });
    expect(typeof after.json().secret).toBe("string");
  });

  it("accepts an invite exactly once and gives the invited role", async () => {
    await setup();
    const { hashToken } = await import("@dockify/crypto");
    const team = await db.team.findFirstOrThrow();
    await db.invite.create({
      data: { teamId: team.id, email: "dev@example.com", role: "viewer", tokenHash: hashToken("invite-token-123"), expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const peek = await app.inject({ method: "GET", url: "/api/v1/auth/invite/invite-token-123" });
    expect(peek.json()).toMatchObject({ email: "dev@example.com", role: "viewer" });
    const accept = await post("/api/v1/auth/invite/invite-token-123", { name: "Dev", password: "a long enough password" });
    expect(accept.statusCode).toBe(200);
    const twice = await post("/api/v1/auth/invite/invite-token-123", { name: "Dev", password: "a long enough password" });
    expect(twice.statusCode).toBe(410);
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: jar(accept) } });
    expect(me.json()).toMatchObject({ role: "viewer" });
    const denied = await app.inject({ method: "GET", url: "/api/v1/activity", headers: { cookie: jar(accept) } });
    expect(denied.statusCode).toBe(403);
  });
});
