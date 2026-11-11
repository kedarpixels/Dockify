/**
 * Regression tests for the auth, data, registry and log hardening (stolen session
 * MFA takeover, per-user TOTP lockout, missing me.* handlers, host rescue, registry DNS, data rows
 * step-up, log page inflation, log search pool pinning), and for the second factor being the
 * authenticator code alone. No database: fakes only.
 */
import { gzipSync } from "node:zlib";
import { hash as argonHash } from "@node-rs/argon2";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@dockify/db";
import { parseAdminArgs, runAdmin } from "./admin.ts";
import { buildApp, type Ctx } from "./app.ts";
import { cookieName } from "./cookies.ts";
import { HttpError } from "./errors.ts";
import { POLICIES } from "./policy.ts";
import { RateLimits } from "./ratelimit.ts";
import { accountHandlers, describeDevice } from "./routes/account.ts";
import { authHandlers, expireOldChallenges, MAX_OPEN_CHALLENGES } from "./routes/auth.ts";
import { noDb, testConfig, testRing } from "./test-helpers.ts";
import { totpUserTable } from "./mfa.fake.ts";
import { createDataHandlers } from "./modules/data/index.ts";
import { MAX_PAGE_BYTES, readLines, withLogReadSlot } from "./modules/deployments/handlers.ts";
import { decodeChunk } from "./modules/deployments/mapping.ts";
import { boundSearch, MAX_SEARCH_WINDOW_MS, withSearchSlot } from "./modules/observe/logs.ts";
import { checkSpec } from "./modules/projects/app-source.ts";
import { refusedPull } from "@dockify/contracts";
import { registryHostProblem } from "./modules/projects/host-rule.ts";

const web = { origin: "https://dockify.test", secure: true };
const fakeReply = () => {
  const headers: Record<string, unknown> = {};
  return {
    headers,
    header(k: string, v: unknown) {
      headers[k.toLowerCase()] = v;
      return this;
    },
    getHeader: (k: string) => headers[k.toLowerCase()],
  };
};
const fakeReq = (cookie?: string) => ({ clientIp: "203.0.113.9", headers: { "user-agent": "vitest", ...(cookie ? { cookie } : {}) } });
const ctxOf = (db: unknown, limits = new RateLimits()): Ctx => ({ db: db as Db, ring: testRing(), config: testConfig(), web, limits });
const call = <T>(h: unknown, input: Record<string, unknown>): Promise<T> => (h as (i: unknown) => Promise<T>)(input);
const session = (elevated = false) => ({ kind: "session" as const, userId: "u1", name: "Owner", role: "admin" as const, sessionId: "s1", elevated });

async function rejects(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("expected a rejection");
}

describe("a stolen session cannot turn MFA on", () => {
  it("puts 2FA setup and verify behind step-up", () => {
    expect(POLICIES["me.2fa.setup"].access).toBe("elevated");
    expect(POLICIES["me.2fa.verify"].access).toBe("elevated");
  });

  it("answers step_up_required to a plain session before any user lookup", async () => {
    const now = Date.now();
    const db = {
      session: {
        findUnique: async () => ({
          id: "s1", userId: "u1", revokedAt: null, elevatedUntil: null,
          expiresAt: new Date(now + 3600_000), absoluteExpiresAt: new Date(now + 7200_000), lastSeenAt: new Date(now),
          user: { name: "Owner", disabledAt: null, member: { role: "admin" } },
        }),
      },
      user: new Proxy({}, { get: () => { throw new Error("user lookup must not happen"); } }),
    };
    const { app } = await buildApp({ db: db as unknown as Db, ring: testRing(), config: testConfig(), logger: false, integrations: false });
    for (const url of ["/api/v1/me/2fa/setup", "/api/v1/me/2fa/verify"]) {
      const res = await app.inject({
        method: "POST", url, payload: url.endsWith("setup") ? {} : { code: "123456" },
        headers: { origin: web.origin, cookie: `${cookieName(web, "session")}=stolen` },
      });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ code: "STEP_UP_REQUIRED" });
    }
    await app.close();
  });
});

describe("TOTP guesses are bounded per user, not per challenge", () => {
  const challengeDb = () => {
    let n = 0;
    const consumed: string[] = [];
    const db = {
      user: totpUserTable(),
      loginChallenge: {
        findUnique: async () => ({
          id: `c${++n}`, userId: "u1", consumedAt: null, expiresAt: new Date(Date.now() + 60_000),
          user: { id: "u1", name: "Owner", totpSecretId: null, totpConfirmedAt: new Date() },
        }),
        update: async () => ({ failedAttempts: 1 }),
        updateMany: async (q: { where: { userId?: string } }) => {
          if (q.where.userId) consumed.push(q.where.userId);
          return { count: 1 };
        },
      },
      activityLog: { create: vi.fn(async () => ({})) },
    };
    return { db, consumed };
  };

  it("locks the user out across fresh challenges and writes a lockout row", async () => {
    const { db, consumed } = challengeDb();
    const ctx = ctxOf(db);
    const codes: string[] = [];
    for (let i = 0; i < 12; i++) {
      const e = await rejects(call(authHandlers["auth.verify"], {
        body: { code: "000000", remember: false },
        req: fakeReq(`${cookieName(web, "pending")}=challenge${i}`), reply: fakeReply(), ctx,
      }));
      codes.push(e.code);
    }
    expect(codes.slice(0, 9).every((c) => c === "INVALID_CODE")).toBe(true);
    expect(codes[9]).toBe("MFA_LOCKED");
    expect(codes.slice(10).every((c) => c === "RATE_LIMITED")).toBe(true);
    expect(consumed).toContain("u1");
    const actions = db.activityLog.create.mock.calls.map((c) => (c as unknown as [{ data: { action: string } }])[0].data.action);
    expect(actions).toContain("auth.mfa.locked");
  });

  it("keeps at most MAX_OPEN_CHALLENGES open per user", async () => {
    const updateMany = vi.fn(async (q: { where: { id: { in: string[] } } }) => ({ count: q.where.id.in.length }));
    const db = { loginChallenge: { findMany: async () => ["a", "b", "c", "d", "e"].map((id) => ({ id })), updateMany } };
    expect(await expireOldChallenges(db as never, "u1")).toBe(5 - (MAX_OPEN_CHALLENGES - 1));
    expect(updateMany.mock.calls[0]?.[0].where.id.in).toEqual(["c", "d", "e"]);
  });
});

describe("account handlers exist and re-prove what they need", () => {
  it("handles every me.* endpoint", () => {
    for (const id of ["me.patch", "me.password", "me.password.code", "me.2fa.disable", "me.sessions.list", "me.sessions.revoke", "me.sessions.revokeOthers"]) {
      expect(authHandlers[id as keyof typeof authHandlers], id).toBeTypeOf("function");
    }
  });

  it("changes the password only with the current one, then ends every other session", async () => {
    const passwordHash = await argonHash("correct horse battery");
    const sessionUpdates: unknown[] = [];
    const tx = {
      user: { update: vi.fn(async () => ({})) },
      session: { updateMany: async (q: unknown) => { sessionUpdates.push(q); return { count: 2 }; } },
      trustedDevice: { updateMany: async () => ({ count: 0 }) },
      loginChallenge: { updateMany: async () => ({ count: 0 }) },
      passwordReset: { updateMany: async () => ({ count: 0 }) },
      activityLog: { create: async () => ({}) },
    };
    const db = { ...tx, user: { ...tx.user, findUniqueOrThrow: async () => ({ id: "u1", passwordHash }) }, integration: { findUnique: async () => null }, $transaction: async (fn: (t: unknown) => unknown) => fn(tx) };
    const ctx = ctxOf(db);
    const wrong = await rejects(call(accountHandlers["me.password"], { body: { current: "nope", next: "a brand new password" }, actor: session(), req: fakeReq(), reply: fakeReply(), ctx }));
    expect(wrong.code).toBe("INVALID_CREDENTIALS");
    expect(tx.user.update).not.toHaveBeenCalled();

    await call(accountHandlers["me.password"], { body: { current: "correct horse battery", next: "a brand new password" }, actor: session(), req: fakeReq(), reply: fakeReply(), ctx });
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(sessionUpdates[0]).toMatchObject({ where: { userId: "u1", revokedAt: null, id: { not: "s1" } } });
  });

  it("refuses to disable MFA without a valid TOTP code", async () => {
    const remove = vi.fn();
    const db = {
      user: totpUserTable(),
      $transaction: remove,
    };
    const e = await rejects(call(accountHandlers["me.2fa.disable"], { body: { code: "123456" }, actor: session(true), req: fakeReq(), reply: fakeReply(), ctx: ctxOf(db) }));
    expect(e.code).toBe("INVALID_CODE");
    expect(remove).not.toHaveBeenCalled();
  });

  it("revokes only the caller's own sessions", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const db = { session: { updateMany }, activityLog: { create: async () => ({}) } };
    const e = await rejects(call(accountHandlers["me.sessions.revoke"], { params: { id: "other" }, actor: session(), req: fakeReq(), ctx: ctxOf(db) }));
    expect(e.status).toBe(404);
    expect(updateMany.mock.calls[0]).toEqual([expect.objectContaining({ where: { id: "other", userId: "u1", revokedAt: null } })]);
  });

  it("needs a step-up to change the email", async () => {
    // Email is not set up here (no integration row), so the step-up path applies.
    const db = { user: { findUniqueOrThrow: async () => ({ id: "u1", email: "owner@example.com", name: "Owner" }) }, integration: { findUnique: async () => null } };
    const e = await rejects(call(accountHandlers["me.patch"], { body: { email: "thief@example.com" }, actor: session(false), req: fakeReq(), ctx: ctxOf(db) }));
    expect(e.code).toBe("STEP_UP_REQUIRED");
  });

  it("labels devices", () => {
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537")).toEqual({ device: "Chrome on Windows", kind: "desktop" });
    expect(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17) Version/17 Mobile Safari/604")).toEqual({ device: "Safari on iOS", kind: "mobile" });
    expect(describeDevice(null)).toEqual({ device: "Unknown device", kind: "unknown" });
    expect(describeDevice("curl/8.5.0")).toEqual({ device: "Unknown device", kind: "unknown" });
    expect(describeDevice("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1")).toEqual({ device: "Safari on iOS", kind: "tablet" });
    expect(describeDevice("Mozilla/5.0 (Linux; Android 14; SM-X710) Chrome/130.0 Safari/537.36")).toEqual({ device: "Chrome on Android", kind: "tablet" });
    expect(describeDevice("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130.0 Mobile Safari/537.36")).toEqual({ device: "Chrome on Android", kind: "mobile" });
    expect(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) Version/17.5 Safari/605.1.15")).toEqual({ device: "Safari on macOS", kind: "desktop" });
  });

});

describe("host rescue: dockify admin over SSH", () => {
  /** A user row plus a transaction that records every write. */
  const hostDb = (user: Record<string, unknown> | null) => {
    const tx = {
      user: { update: vi.fn(async () => ({})) },
      secret: { delete: vi.fn(async () => ({})) },
      session: { updateMany: vi.fn(async () => ({ count: 3 })) },
      trustedDevice: { updateMany: vi.fn(async () => ({ count: 1 })) },
      loginChallenge: { updateMany: vi.fn(async () => ({ count: 1 })) },
      passwordReset: { updateMany: vi.fn(async () => ({ count: 0 })) },
      apiToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
      activityLog: { create: vi.fn(async () => ({})) },
    };
    const $transaction = vi.fn(async (fn: (t: unknown) => unknown) => fn(tx));
    return { tx, $transaction, db: { user: { findUnique: async () => user }, $transaction } as never };
  };
  const owner = (over: Record<string, unknown> = {}) => ({ id: "u1", email: "owner@example.com", totpSecretId: null, totpConfirmedAt: null, ...over });
  const audited = (tx: ReturnType<typeof hostDb>["tx"]) => (tx.activityLog.create.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>).map((c) => c[0].data);

  it("parses only the known commands with one email", () => {
    expect(parseAdminArgs(["reset-password", "Owner@Example.com"])).toEqual({ command: "reset-password", email: "owner@example.com" });
    expect(parseAdminArgs(["disable-mfa", "owner@example.com"])).toEqual({ command: "disable-mfa", email: "owner@example.com" });
    expect(parseAdminArgs(["drop-tables", "a@b.co"])).toBeNull();
    expect(parseAdminArgs(["revoke-sessions"])).toBeNull();
    expect(parseAdminArgs(["disable-mfa", "not-an-email"])).toBeNull();
    expect(parseAdminArgs(["disable-mfa", "a@b.co", "extra"])).toBeNull();
  });

  it("resets the password, ends every session and pending sign in, and leaves two-factor on", async () => {
    const { tx, db } = hostDb(owner({ totpSecretId: "sec1", totpConfirmedAt: new Date() }));
    const out = await runAdmin(db, "reset-password", "owner@example.com");
    expect(out).toMatch(/New password for owner@example.com: \S{20,}/);
    expect(out).toContain("Two-factor sign in is still on");
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(tx.user.update.mock.calls[0]).toEqual([{ where: { id: "u1" }, data: { passwordHash: expect.stringMatching(/^\$argon2id\$/), passwordChangedAt: expect.any(Date) } }]);
    expect(tx.secret.delete).not.toHaveBeenCalled();
    expect(tx.session.updateMany).toHaveBeenCalledWith({ where: { userId: "u1", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(tx.trustedDevice.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.loginChallenge.updateMany).toHaveBeenCalledTimes(1);
    expect(audited(tx)).toEqual([expect.objectContaining({ category: "access", action: "admin.reset-password", actorType: "system", targetId: "u1" })]);
  });

  it("turns two-factor off, drops the TOTP secret, ends every session and pending sign in, and audits it", async () => {
    const { tx, db } = hostDb(owner({ totpSecretId: "sec1", totpConfirmedAt: new Date() }));
    const out = await runAdmin(db, "disable-mfa", "owner@example.com");
    expect(out).toMatch(/Two-factor sign-in is off for owner@example.com/);
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { totpSecretId: null, totpConfirmedAt: null, totpLastUsedStep: null } });
    expect(tx.secret.delete).toHaveBeenCalledWith({ where: { id: "sec1" } });
    expect(tx.session.updateMany).toHaveBeenCalledWith({ where: { userId: "u1", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(tx.trustedDevice.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.loginChallenge.updateMany).toHaveBeenCalledTimes(1);
    // Shown as "Dockify turned off two-factor sign-in for owner@example.com from the server (dockify admin)".
    expect(audited(tx)).toEqual([expect.objectContaining({
      category: "access", action: "admin.disable-mfa", verb: "turned off two-factor sign-in for", targetLabel: "owner@example.com",
      suffix: "from the server (dockify admin)", actorType: "system", actorName: "host admin", targetId: "u1",
    })]);
  });

  it("changes nothing when two-factor is not on, and refuses an unknown email", async () => {
    const off = hostDb(owner());
    expect(await runAdmin(off.db, "disable-mfa", "owner@example.com")).toMatch(/not on for owner@example.com\. Nothing changed/);
    expect(off.$transaction).not.toHaveBeenCalled();
    await expect(runAdmin(hostDb(null).db, "reset-password", "ghost@example.com")).rejects.toThrow(/No user with the email ghost@example.com/);
  });
});

describe("the second factor is the authenticator code alone", () => {
  it("serves only the reviewed sign in and two-factor routes", async () => {
    const { app, routes } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), logger: false, handlers: {}, integrations: false });
    const under = (prefix: string) => [...new Set(routes.filter((r) => r.url.startsWith(prefix)).map((r) => `${r.method} ${r.url}`))].sort();
    expect(under("/api/v1/me/2fa/")).toEqual(["POST /api/v1/me/2fa/disable", "POST /api/v1/me/2fa/setup", "POST /api/v1/me/2fa/verify"]);
    expect(under("/api/v1/auth/")).toEqual([
      "GET /api/v1/auth/invite/:token", "GET /api/v1/auth/reset/:token", "GET /api/v1/auth/setup-status",
      "POST /api/v1/auth/forgot", "POST /api/v1/auth/invite/:token", "POST /api/v1/auth/login", "POST /api/v1/auth/logout",
      "POST /api/v1/auth/reset/:token", "POST /api/v1/auth/setup", "POST /api/v1/auth/step-up", "POST /api/v1/auth/verify",
    ]);
    await app.close();
  });

  it("refuses anything but six digits, and any extra field, before a lookup", async () => {
    const { app } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), logger: false, handlers: {}, integrations: false });
    for (const payload of [{ code: "abcd-efgh-ijkl-mnop" }, { code: "12345678" }, { code: "123456", kind: "totp" }]) {
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/verify", payload, headers: { origin: web.origin } });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    await app.close();
  });
});

describe("registry names are resolved before an image is stored", () => {
  const resolver = (addrs: string[]) => vi.fn(async () => addrs.map((address) => ({ address })));

  it.each(["127.0.0.1", "127.8.8.8", "0.0.0.0", "169.254.169.254", "100.100.100.200", "168.63.129.16", "172.30.3.2", "::1", "::", "fe80::1", "fd00:ec2::254", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:172.30.1.9"])("refuses a name resolving to %s", async (addr) => {
    expect(await registryHostProblem("reg.attacker.tld/x:1", resolver([addr]))).toMatch(/does not pull from reg\.attacker\.tld: it resolves to/);
  });

  it.each(["10.1.2.3", "172.16.0.9", "172.30.6.5", "192.168.1.5", "fd12:3456::1", "::ffff:192.168.1.5"])("takes a registry name on a LAN address, %s, as the gate does", async (addr) => {
    expect(await registryHostProblem("registry.example.com:5000/x:1", resolver([addr]))).toBeNull();
  });

  it("refuses a mix of good and internal answers and a public name that does not resolve", async () => {
    expect(await registryHostProblem("reg.example.com/x:1", resolver(["8.8.8.8", "127.0.0.1"]))).toMatch(/resolves to 127\.0\.0\.1/);
    expect(await registryHostProblem("reg.example.com/x:1", vi.fn(async () => { throw new Error("ENOTFOUND"); }))).toMatch(/did not resolve/);
    expect(await registryHostProblem("reg.example.com/x:1", resolver([]))).toMatch(/did not resolve/);
  });

  it("takes a LAN name this container cannot resolve, and still reads the answer when it can", async () => {
    const nothing = vi.fn(async () => { throw new Error("ENOTFOUND"); });
    for (const image of ["registry.lan:5000/x:1", "registry:5000/x:1", "box.home/x", "reg.corp:443/a/b"]) expect(await registryHostProblem(image, nothing), image).toBeNull();
    expect(await registryHostProblem("registry.lan:5000/x", resolver(["192.168.1.5"]))).toBeNull();
    expect(await registryHostProblem("registry.lan:5000/x", resolver(["127.0.0.1"]))).toMatch(/resolves to 127\.0\.0\.1/);
  });

  it("takes a port on any registry the gate takes, and asks no DNS for a written address", async () => {
    const asked = resolver(["127.0.0.1"]);
    for (const image of ["192.168.1.5:5000/x", "10.0.0.7:5000/x", "172.30.6.5/x", "172.16.3.2:5000/a/b:1"]) expect(await registryHostProblem(image, asked), image).toBeNull();
    expect(asked).not.toHaveBeenCalled();
    expect(await registryHostProblem("reg.example.com:2375/x:1", resolver(["8.8.8.8"]))).toBeNull();
  });

  // Every spelling the gate refuses, at save time, in the gate's own words.
  it.each([
    "127.0.0.1:5000/x", "127.1:5000/x", "2130706433:5000/x", "0x7f000001:5000/x", "0x7f.0.0.1:5000/x", "0177.0.0.1:5000/x", "127.0.0.01:5000/x", "017700000001:5000/x", "0:5000/x", "256.0.0.1:5000/x", "1.2.3.4.5:5000/x",
    "localhost:5000/x", "localhost/x", "foo.localhost:5000/x", "localhost.localdomain:5000/x", "ip6-localhost:5000/x", "ip6-loopback:5000/x", "0.0.0.0:5000/x",
    "169.254.169.254/latest", "169.254.0.1:5000/x", "100.100.100.200/x", "168.63.129.16/x", "metadata.google.internal/x", "metadata.goog/x", "metadata:80/x", "instance-data:80/x", "instance-data.ec2.internal/x",
    "host.docker.internal:5000/x", "gateway.docker.internal/x", "172.30.1.10:3001/x", "172.30.2.10:3001/x", "172.30.3.2:5432/x", "172.30.4.2:2375/x", "172.30.5.30:443/x",
  ])("refuses %s on its face, before any lookup", async (image) => {
    const asked = resolver(["8.8.8.8"]);
    const why = await registryHostProblem(image, asked);
    expect(why).toBe(refusedPull(image));
    expect(why).toMatch(/Dockify does not pull from/);
    expect(asked).not.toHaveBeenCalled();
    expect(checkSpec({ kind: "backend", source: { type: "image", image, registryId: null } } as never).find((r) => r.field === "source.image")?.reason).toBe(why);
  });

  it("refuses an IPv6 literal the contract's grammar would let past it", async () => {
    expect(await registryHostProblem("[::1]:5000/x")).toMatch(/does not pull from/);
    expect(await registryHostProblem("[fd00:ec2::254]/x")).toMatch(/does not pull from/);
  });

  it("allows a public registry and never resolves Docker Hub", async () => {
    expect(await registryHostProblem("ghcr.io/o/r:1", resolver(["140.82.112.33"]))).toBeNull();
    const hub = resolver(["127.0.0.1"]);
    expect(await registryHostProblem("nginx:1.27", hub)).toBeNull();
    expect(hub).not.toHaveBeenCalled();
  });

  it("takes a LAN registry with a port at rest too", () => {
    for (const image of ["reg.example.com:5000/app:1", "registry.lan:5000/app:1", "192.168.1.5:5000/app"]) {
      expect(checkSpec({ kind: "backend", source: { type: "image", image, registryId: null } } as never).filter((r) => r.field === "source.image"), image).toEqual([]);
    }
  });
});

describe("data rows need a step-up and are audited", () => {
  it("elevates rows and audits every rows read", async () => {
    expect(POLICIES["apps.data.rows"].access).toBe("elevated");
    const create = vi.fn(async () => ({}));
    const db = {
      app: { findUnique: async () => ({ id: "a1", name: "db", kind: "postgres", environment: { projectId: "p1" } }) },
      activityLog: { create },
    };
    const handlers = createDataHandlers({ call: async () => ({ columns: [], rows: [] }) });
    await call(handlers["apps.data.rows"], { ctx: ctxOf(db), actor: session(true), params: { id: "a1" }, query: { table: "public.users", limit: 200 }, req: fakeReq() });
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0] as unknown as [{ data: { action: string; suffix: string } }])[0].data).toMatchObject({ action: "data.rows", suffix: "public.users (limit 200)" });
  });
});

describe("vercel import is elevated", () => {
  it("is an elevated route", () => {
    expect(POLICIES["integrations.vercel.import"].access).toBe("elevated");
  });
});

describe("a deployment log page is bounded by bytes", () => {
  const line = "x".repeat(16 * 1024);
  const chunk = (firstSeq: number, n: number) =>
    gzipSync(Buffer.from(Array.from({ length: n }, () => JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", stream: "stdout", text: line })).join("\n")));

  it("stops at about 1 MiB of decoded text and reports more", async () => {
    const db = { $queryRaw: async () => [0, 200, 400].map((s) => ({ firstSeq: s, lineCount: 200, gzip: chunk(s, 200) })) };
    const { lines, more } = await readLines(db as never, "d1", -1);
    expect(more).toBe(true);
    const bytes = lines.reduce((n, l) => n + l.text.length, 0);
    expect(bytes).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(100);
  });

  it("refuses to inflate a decompression bomb and moves the cursor past it", () => {
    const bomb = gzipSync(Buffer.alloc(32 * 1024 * 1024, 0x61));
    const out = decodeChunk(10, bomb, 200);
    expect(out).toEqual([expect.objectContaining({ seq: 209, text: "[log chunk too large to show]" })]);
  });

  it("caps concurrent page reads per user", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = withLogReadSlot("u1", () => gate);
    const b = withLogReadSlot("u1", () => gate);
    const e = await rejects(withLogReadSlot("u1", async () => 1));
    expect(e.status).toBe(429);
    expect(await withLogReadSlot("u2", async () => 2)).toBe(2);
    release();
    await Promise.all([a, b]);
    expect(await withLogReadSlot("u1", async () => 3)).toBe(3);
  });
});

describe("log search cannot pin the pool", () => {
  const now = new Date("2026-10-30T12:00:00.000Z");

  it("bounds an all-apps text search to 24 hours", () => {
    const f = boundSearch({ appIds: null, q: "boom" }, false, now);
    expect(f.to).toEqual(now);
    expect(now.getTime() - f.from!.getTime()).toBe(MAX_SEARCH_WINDOW_MS);
    expect(() => boundSearch({ appIds: null, q: "x", from: new Date(now.getTime() - 3 * MAX_SEARCH_WINDOW_MS) }, false, now)).toThrow(/24 hours/);
  });

  it("leaves app-scoped and plain filters alone", () => {
    const scoped = { appIds: ["a"], q: "x" };
    expect(boundSearch(scoped, true, now)).toBe(scoped);
    const plain = { appIds: null };
    expect(boundSearch(plain, false, now)).toBe(plain);
  });

  it("caps concurrent searches per user", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = [withSearchSlot("u1", () => gate), withSearchSlot("u1", () => gate)];
    expect((await rejects(withSearchSlot("u1", async () => 0))).code).toBe("TOO_MANY_SEARCHES");
    release();
    await Promise.all(held);
    expect(await withSearchSlot("u1", async () => 1)).toBe(1);
  });
});
