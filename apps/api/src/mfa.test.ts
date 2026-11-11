/**
 * The one lockout every authenticator code check shares: kept on the user row, doubling each time
 * in a row, cleared by a right code. No database: totpUserTable stands in for the user row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeSecret, type Db } from "@dockify/db";
import type { Ctx } from "./app.ts";
import { cookieName } from "./cookies.ts";
import type { HttpError } from "./errors.ts";
import { checkTotp } from "./mfa.ts";
import { totpUserTable } from "./mfa.fake.ts";
import { RateLimits, TOTP_LOCK_MAX_MS, TOTP_MAX_FAILS, totpLockMs } from "./ratelimit.ts";
import { accountHandlers } from "./routes/account.ts";
import { authHandlers } from "./routes/auth.ts";
import { sendSecurityNotice } from "./security-notice.ts";
import { testConfig, testRing } from "./test-helpers.ts";
import { totpAt } from "./totp.ts";

vi.mock("./security-notice.ts", async (original) => ({ ...(await original<typeof import("./security-notice.ts")>()), sendSecurityNotice: vi.fn(async () => true) }));

const SECRET = "JBSWY3DPEHPK3PXP";
const ring = testRing();
const web = { origin: "https://dockify.test", secure: true };
const T0 = Date.parse("2026-11-11T12:00:00Z");
const MIN = 60_000;

async function setup() {
  const secrets = new Map<string, Record<string, unknown>>();
  const secret = {
    create: async ({ data }: { data: Record<string, unknown> }) => (secrets.set(String(data.id), data), data),
    findUnique: async ({ where }: { where: { id: string } }) => secrets.get(where.id) ?? null,
  };
  const totpSecretId = await storeSecret({ secret } as never, ring, { kind: "totp", ownerType: "user", ownerId: "u1" }, SECRET);
  const user = totpUserTable({ totpSecretId });
  const actions: string[] = [];
  const db = {
    user, secret,
    loginChallenge: {
      findUnique: async () => ({ id: "c1", userId: "u1", consumedAt: null, expiresAt: new Date(Date.now() + MIN), user: user.row }),
      update: async () => ({ failedAttempts: 1 }),
      updateMany: async () => ({ count: 1 }),
    },
    activityLog: { create: async (q: { data: { action: string } }) => (actions.push(q.data.action), {}) },
    session: { update: async () => ({}) },
  };
  return { db: db as unknown as Db, user, actions };
}

const wrong = (db: Db, row: Record<string, unknown>, now: number) => checkTotp(db, ring, row as never, "000000", now);

describe("totpLockMs", () => {
  it("doubles from 15 minutes and stops at a day", () => {
    expect([0, 1, 2, 3].map((n) => totpLockMs(n) / MIN)).toEqual([15, 30, 60, 120]);
    expect(totpLockMs(7)).toBe(TOTP_LOCK_MAX_MS);
    expect(totpLockMs(5000)).toBe(TOTP_LOCK_MAX_MS);
  });
});

describe("checkTotp", () => {
  it("locks after ten wrong codes, refuses even the right code while locked, and doubles the next lockout", async () => {
    const { db, user } = await setup();
    for (let i = 0; i < TOTP_MAX_FAILS - 1; i++) expect(await wrong(db, user.row, T0)).toEqual({ ok: false, wait: null, engaged: false, first: false });
    expect(await wrong(db, user.row, T0)).toEqual({ ok: false, wait: 900, engaged: true, first: true });
    expect(await checkTotp(db, ring, user.row as never, totpAt(SECRET, T0 + MIN), T0 + MIN)).toEqual({ ok: false, wait: 840, engaged: false, first: false });

    let now = T0 + 15 * MIN;
    for (const minutes of [30, 60, 120]) {
      for (let i = 0; i < TOTP_MAX_FAILS - 1; i++) expect(await wrong(db, user.row, now)).toMatchObject({ wait: null });
      expect(await wrong(db, user.row, now)).toEqual({ ok: false, wait: minutes * 60, engaged: true, first: false });
      now += minutes * MIN;
    }
    expect(user.row.totpLockouts).toBe(4);
  });

  it("starts over only after a right code", async () => {
    const { db, user } = await setup();
    for (let i = 0; i < TOTP_MAX_FAILS; i++) await wrong(db, user.row, T0);
    const later = T0 + 15 * MIN;
    for (let i = 0; i < 4; i++) await wrong(db, user.row, later);
    expect(user.row).toMatchObject({ totpFailedCount: 4, totpLockouts: 1 });
    expect(await checkTotp(db, ring, user.row as never, totpAt(SECRET, later), later)).toEqual({ ok: true });
    expect(user.row).toMatchObject({ totpFailedCount: 0, totpLockouts: 0, totpLockedUntil: null });
    for (let i = 0; i < TOTP_MAX_FAILS - 1; i++) await wrong(db, user.row, later + MIN);
    expect(await wrong(db, user.row, later + MIN)).toMatchObject({ wait: 900, engaged: true, first: true });
  });

  it("lets exactly one of many parallel guesses start the lockout", async () => {
    const { db, user } = await setup();
    const out = await Promise.all(Array.from({ length: 40 }, () => wrong(db, user.row, T0)));
    expect(out.filter((r) => !r.ok && r.engaged)).toHaveLength(1);
    expect(out.every((r) => !r.ok && r.wait !== null)).toBe(true);
    expect(user.row).toMatchObject({ totpFailedCount: 0, totpLockouts: 1 });
  });

  it("locks a count left full by a crash instead of refusing forever", async () => {
    const { db, user } = await setup();
    user.row.totpFailedCount = TOTP_MAX_FAILS;
    expect(await wrong(db, user.row, T0)).toMatchObject({ wait: 900, engaged: true });
    expect(await checkTotp(db, ring, user.row as never, totpAt(SECRET, T0 + 15 * MIN), T0 + 15 * MIN)).toEqual({ ok: true });
  });
});

describe("sign in, step-up and two-factor off spend one budget", () => {
  const reply = () => ({ headers: {} as Record<string, unknown>, header(k: string, v: unknown) { this.headers[k.toLowerCase()] = v; return this; }, getHeader() { return undefined; } });
  const session = { kind: "session" as const, userId: "u1", name: "Owner", role: "admin" as const, sessionId: "s1", elevated: false };
  const ctxOf = (db: Db): Ctx => ({ db, ring, config: testConfig(), web, limits: new RateLimits() });
  const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: HttpError) => e.code);
  const run = (id: "auth.verify" | "auth.stepUp" | "me.2fa.disable", ctx: Ctx, r = reply()) => {
    const req = { clientIp: "203.0.113.9", headers: { "user-agent": "vitest", ...(id === "auth.verify" ? { cookie: `${cookieName(web, "pending")}=x` } : {}) } };
    const handlers = { ...authHandlers, ...accountHandlers } as unknown as Record<string, (i: unknown) => Promise<unknown>>;
    return handlers[id]!({ body: { code: "000000", remember: false }, actor: session, req, reply: r, ctx });
  };

  beforeEach(() => vi.mocked(sendSecurityNotice).mockClear());

  it("counts wrong codes across all three, survives a restart, and mails the owner once", async () => {
    const { db, user, actions } = await setup();
    const ctx = ctxOf(db);
    const seen: string[] = [];
    for (const id of ["auth.stepUp", "auth.stepUp", "auth.stepUp", "auth.stepUp", "me.2fa.disable", "me.2fa.disable", "me.2fa.disable", "auth.verify", "auth.verify"] as const) seen.push(await code(run(id, ctx)));
    expect(seen).toEqual([...Array(4).fill("INVALID_CREDENTIALS"), ...Array(5).fill("INVALID_CODE")]);

    const r = reply();
    const locked = (await run("auth.stepUp", ctx, r).catch((e: HttpError) => e)) as HttpError;
    expect([locked.code, locked.status, locked.message]).toEqual(["MFA_LOCKED", 429, "Too many incorrect codes. Try again in 15 minutes."]);
    expect(r.headers["retry-after"]).toBe("900");
    expect(actions.filter((a) => a === "auth.mfa.locked")).toHaveLength(1);
    expect(vi.mocked(sendSecurityNotice).mock.calls.map((c) => [c[1], c[2]])).toEqual([["u1", "mfaLocked"]]);

    // A new process holds new in-memory limiters; the lockout is on the user row.
    const restarted = ctxOf(db);
    for (const id of ["auth.verify", "auth.stepUp", "me.2fa.disable"] as const) expect(await code(run(id, restarted))).toBe("RATE_LIMITED");

    // The lockout runs out and the guessing goes on: twice as long, and no second mail.
    user.row.totpLockedUntil = new Date(Date.now() - 1000);
    for (let i = 0; i < TOTP_MAX_FAILS - 1; i++) expect(await code(run("auth.verify", restarted))).toBe("INVALID_CODE");
    const again = (await run("auth.verify", restarted).catch((e: HttpError) => e)) as HttpError;
    expect([again.code, again.message]).toEqual(["MFA_LOCKED", "Too many incorrect codes. Try again in 30 minutes."]);
    expect(vi.mocked(sendSecurityNotice)).toHaveBeenCalledTimes(1);
  });
});
