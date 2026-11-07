/**
 * Email, end to end through the handlers with fakes only (no database, no network):
 *   the mailer seals whole messages and the job names only the sealed row;
 *   forgot password answers before any lookup, mails only real members, stores the token hashed
 *   and links to the configured public URL; a reset link works once, expires and ends sessions;
 *   email codes are keyed hashes with five tries; PATCH /me hands an email change to the code
 *   flow while email is on; a password change needs its own emailed code while email is on; the
 *   email integration keeps its password write-only and only ever sends it to the server it was
 *   saved for.
 */
import { hash as argonHash } from "@node-rs/argon2";
import { describe, expect, it, vi } from "vitest";
import { auth, integrations as I } from "@dockify/contracts";
import { hashToken } from "@dockify/crypto";
import { readSecretValue, type Db } from "@dockify/db";
import { MailError, type Mailer, type OutgoingEmail, type SmtpServer } from "@dockify/email";
import type { Actor } from "./actor.ts";
import type { Ctx } from "./app.ts";
import { HttpError } from "./errors.ts";
import { queueEmailTx } from "./mailer.ts";
import { defaultDeps } from "./modules/integrations/deps.ts";
import { emailHandlers } from "./modules/integrations/email.ts";
import { RateLimits } from "./ratelimit.ts";
import { accountHandlers } from "./routes/account.ts";
import { codeHash, emailAuthHandlers, MAX_CODE_TRIES, startPasswordReset } from "./routes/email-auth.ts";
import { testConfig, testRing } from "./test-helpers.ts";

const ring = testRing();
const web = { origin: "https://dockify.test", secure: true };
const call = <T>(h: unknown, input: Record<string, unknown>): Promise<T> => (h as (i: unknown) => Promise<T>)(input);
const fakeReq = () => ({ clientIp: "203.0.113.9", headers: { "user-agent": "Mozilla/5.0 (Macintosh; Mac OS X) Chrome/130.0" }, log: { error: vi.fn() } });
const fakeReply = () => ({ header() { return this; } });
const session = (elevated = false): Actor => ({ kind: "session", userId: "u1", name: "Owner", role: "admin", sessionId: "s1", elevated });
const ctxOf = (db: unknown, limits = new RateLimits()): Ctx => ({ db: db as Db, ring, config: testConfig(), web, limits });

async function rejects(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("expected a rejection");
}

type Row = Record<string, unknown>;
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    const cur = row[k];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const o = v as { gt?: Date; lt?: Date; in?: unknown[]; not?: unknown };
      if ("gt" in o) return cur instanceof Date && cur > (o.gt as Date);
      if ("lt" in o) return cur instanceof Date && cur < (o.lt as Date);
      if ("in" in o) return (o.in ?? []).includes(cur);
      if ("not" in o) return cur !== o.not;
    }
    // Prisma reads a missing nullable column as null.
    return v === null ? cur == null : cur === v;
  });

/** One in-memory table with the Prisma calls the email code uses. */
function table(rows: Row[] = []) {
  return {
    rows,
    findUnique: async ({ where }: { where: Row }) => rows.find((r) => matches(r, where)) ?? null,
    findUniqueOrThrow: async ({ where }: { where: Row }) => {
      const r = rows.find((x) => matches(x, where));
      if (!r) throw new Error("not found");
      return r;
    },
    findFirst: async ({ where }: { where: Row }) => [...rows].reverse().find((r) => matches(r, where)) ?? null,
    findMany: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)),
    create: async ({ data }: { data: Row }) => {
      const row = { id: data.id ?? `id-${rows.length + 1}`, createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const r = rows.find((x) => matches(x, where));
      if (!r) throw new Error("not found");
      for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === "object" && "increment" in v ? Number(r[k] ?? 0) + Number((v as { increment: number }).increment) : v;
      return r;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
    deleteMany: async ({ where }: { where?: Row } = {}) => {
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count };
    },
    delete: async ({ where }: { where: Row }) => {
      const i = rows.findIndex((r) => matches(r, where));
      return rows.splice(i, 1)[0];
    },
  };
}

/** A small database: users, members, codes, resets, sealed secrets, jobs, audit and the email row. */
function fakeDb(opts: { email?: boolean; users?: Row[] } = {}) {
  const db = {
    user: table(opts.users ?? [{ id: "u1", email: "owner@example.com", name: "Owner", passwordHash: "x", disabledAt: null, member: { role: "admin" }, emailVerifiedAt: null }]),
    instance: table([{ id: 1, name: "Acme Cloud" }]),
    integration: table(opts.email === false ? [] : [{ id: "int1", kind: "email", name: "default", status: "connected", secretId: "sec-key", config: { host: "smtp.acme.dev", port: 465, tlsMode: "implicit", username: "mailer", fromName: "Acme", fromAddress: "ops@acme.dev", replyTo: null } }]),
    emailCode: table(),
    passwordReset: table(),
    secret: table(),
    job: table(),
    session: table(),
    trustedDevice: table(),
    apiToken: table(),
    loginChallenge: table(),
    activityLog: table(),
    $executeRaw: async () => 0,
    $transaction: async (fn: (t: unknown) => unknown) => fn(db),
  };
  // The email integration's row keys on kind_name.
  db.integration.findUnique = async ({ where }: { where: Row }) => {
    const kn = where.kind_name as { kind: string; name: string } | undefined;
    return db.integration.rows.find((r) => (kn ? r.kind === kn.kind && r.name === kn.name : matches(r, where))) ?? null;
  };
  return db;
}

/** Opens every queued message the fake holds. */
async function queued(db: ReturnType<typeof fakeDb>) {
  return Promise.all(
    db.job.rows.map(async (j) => {
      const id = (j.payload as { messageId: string }).messageId;
      return JSON.parse((await readSecretValue(db as never, ring, id)) ?? "null") as { to: string; subject: string; html: string; text: string };
    }),
  );
}

describe("mailer", () => {
  it("seals the whole message and gives the job only the sealed row's id", async () => {
    const db = fakeDb();
    await queueEmailTx(db as never, ring, "Someone@Example.com", { subject: "123456 is your code", html: "<p>123456</p>", text: "123456" });
    const job = db.job.rows[0]!;
    expect(job.kind).toBe("email_send");
    expect(Object.keys(job.payload as object)).toEqual(["messageId"]);
    expect(JSON.stringify(job)).not.toMatch(/example\.com|123456/);
    expect(db.secret.rows[0]).toMatchObject({ kind: "email_message", hint: null });
    expect((await queued(db))[0]).toMatchObject({ to: "someone@example.com", subject: "123456 is your code" });
  });
});

describe("forgot password", () => {
  it("answers 202 before any account lookup, and 409 when email is off", async () => {
    const db = fakeDb();
    const find = vi.spyOn(db.user, "findUnique");
    const out = await call(emailAuthHandlers["auth.forgot"], { body: { email: "nobody@example.com" }, req: fakeReq(), reply: fakeReply(), ctx: ctxOf(db) });
    expect(out).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
    const off = await rejects(call(emailAuthHandlers["auth.forgot"], { body: { email: "a@b.co" }, req: fakeReq(), reply: fakeReply(), ctx: ctxOf(fakeDb({ email: false })) }));
    expect(off.code).toBe("EMAIL_NOT_CONFIGURED");
  });

  it("mails nothing for an unknown or disabled address", async () => {
    const db = fakeDb({ users: [{ id: "u2", email: "gone@example.com", name: "Gone", disabledAt: new Date(), member: { role: "viewer" } }] });
    expect(await startPasswordReset(ctxOf(db), "nobody@example.com", fakeReq() as never)).toBe("skipped");
    expect(await startPasswordReset(ctxOf(db), "gone@example.com", fakeReq() as never)).toBe("skipped");
    expect(db.job.rows).toHaveLength(0);
    expect(db.passwordReset.rows).toHaveLength(0);
  });

  it("stores the token hashed and links to the configured public URL", async () => {
    const db = fakeDb();
    expect(await startPasswordReset(ctxOf(db), "owner@example.com", fakeReq() as never)).toBe("sent");
    const [mail] = await queued(db);
    const token = /https:\/\/dockify\.test\/reset\/([\w-]{43})/.exec(mail!.text)?.[1];
    expect(token).toBeDefined();
    const row = db.passwordReset.rows[0]!;
    expect(row.tokenHash).toBe(hashToken(token!));
    expect(JSON.stringify(db.passwordReset.rows)).not.toContain(token);
    expect((row.expiresAt as Date).getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(mail!.to).toBe("owner@example.com");
  });
});

describe("password reset link", () => {
  const setup = (over: Row = {}) => {
    const db = fakeDb();
    const token = "t".repeat(43);
    db.passwordReset.rows.push({ id: "r1", userId: "u1", tokenHash: hashToken(token), usedAt: null, expiresAt: new Date(Date.now() + 60_000), ...over });
    db.passwordReset.findUnique = async ({ where }: { where: Row }) => {
      const r = db.passwordReset.rows.find((x) => x.tokenHash === where.tokenHash);
      return r ? { ...r, user: db.user.rows.find((u) => u.id === r.userId) } : null;
    };
    db.session.rows.push({ id: "s1", userId: "u1", revokedAt: null }, { id: "s2", userId: "u1", revokedAt: null });
    return { db, token };
  };

  it("previews the account masked, then resets once and ends every session", async () => {
    const { db, token } = setup();
    const preview = await call<{ email: string }>(emailAuthHandlers["auth.reset.get"], { params: { token }, ctx: ctxOf(db) });
    expect(preview.email).toBe("o***@example.com");
    await call(emailAuthHandlers["auth.reset"], { params: { token }, body: { password: "a long new password" }, req: fakeReq(), ctx: ctxOf(db) });
    const user = db.user.rows[0]!;
    expect(String(user.passwordHash)).toMatch(/^\$argon2id\$/);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(db.session.rows.every((s) => s.revokedAt instanceof Date)).toBe(true);
    expect(db.activityLog.rows.some((a) => a.action === "auth.reset")).toBe(true);
    const again = await rejects(call(emailAuthHandlers["auth.reset"], { params: { token }, body: { password: "another long one" }, req: fakeReq(), ctx: ctxOf(db) }));
    expect(again).toMatchObject({ status: 410, code: "RESET_USED" });
  });

  it("refuses an expired or unknown link", async () => {
    const { db, token } = setup({ expiresAt: new Date(Date.now() - 1) });
    expect(await rejects(call(emailAuthHandlers["auth.reset.get"], { params: { token }, ctx: ctxOf(db) }))).toMatchObject({ status: 410, code: "RESET_EXPIRED" });
    expect(await rejects(call(emailAuthHandlers["auth.reset.get"], { params: { token: "u".repeat(43) }, ctx: ctxOf(db) }))).toMatchObject({ status: 404 });
  });

  it("validates the token shape and the new password in the contract", () => {
    expect(auth.ResetParams.safeParse({ token: "short" }).success).toBe(false);
    expect(auth.PasswordResetBody.safeParse({ password: "short" }).success).toBe(false);
    expect(auth.ForgotBody.safeParse({ email: "a@b.co", extra: 1 }).success).toBe(false);
  });

  it("takes a new password of 12 characters and refuses 11, on every path that sets one", () => {
    const eleven = "a".repeat(11);
    const twelve = "a".repeat(12);
    const short = auth.PasswordResetBody.safeParse({ password: eleven });
    expect(short.success).toBe(false);
    expect(short.error?.issues[0]?.message).toBe("Use at least 12 characters");
    expect(auth.PasswordResetBody.safeParse({ password: twelve }).success).toBe(true);
    expect(auth.AcceptInviteBody.safeParse({ name: "Dev", password: eleven }).success).toBe(false);
    expect(auth.AcceptInviteBody.safeParse({ name: "Dev", password: twelve }).success).toBe(true);
    expect(auth.SetupBody.safeParse({ instanceName: "Acme", name: "Owner", email: "owner@example.com", password: eleven }).success).toBe(false);
    expect(auth.ChangePasswordBody.safeParse({ current: "x", next: eleven }).success).toBe(false);
    expect(auth.ChangePasswordBody.safeParse({ current: "x", next: twelve }).success).toBe(true);
  });
});

describe("email codes", () => {
  const ask = (db: unknown, body: Row, elevated = false, limits?: RateLimits) =>
    call<{ purpose: string; email: string }>(emailAuthHandlers["me.email.code"], { body, actor: session(elevated), req: fakeReq(), reply: fakeReply(), ctx: ctxOf(db, limits) });
  const confirm = (db: unknown, code: string, limits?: RateLimits) =>
    call<{ email: string; emailVerified: boolean }>(emailAuthHandlers["me.email.confirm"], { body: { code }, actor: session(), req: fakeReq(), reply: fakeReply(), ctx: ctxOf(db, limits) });

  it("needs email, and a step-up to move the account", async () => {
    expect((await rejects(ask(fakeDb({ email: false }), {}))).code).toBe("EMAIL_NOT_CONFIGURED");
    expect((await rejects(ask(fakeDb(), { email: "new@example.com" }))).code).toBe("STEP_UP_REQUIRED");
    const db = fakeDb();
    db.user.rows.push({ id: "u9", email: "taken@example.com", name: "Other" });
    expect((await rejects(ask(db, { email: "taken@example.com" }, true))).code).toBe("EMAIL_TAKEN");
  });

  it("stores only a keyed hash and mails the code to the address being proven", async () => {
    const db = fakeDb();
    const r = await ask(db, { email: "New@Example.com" }, true);
    expect(r).toMatchObject({ purpose: "change", email: "new@example.com" });
    const [mail] = await queued(db);
    const code = /^(\d{6}) is your/.exec(mail!.subject)?.[1];
    const row = db.emailCode.rows[0]!;
    expect(mail!.to).toBe("new@example.com");
    expect(row.codeHash).toBe(codeHash(ring, String(row.id), code!));
    expect(row.codeHash).not.toBe(hashToken(code!));
    expect(JSON.stringify(db.emailCode.rows)).not.toContain(code);
  });

  it("allows five tries, then voids the code", async () => {
    const db = fakeDb();
    await ask(db, {});
    const limits = new RateLimits();
    for (let i = 1; i < MAX_CODE_TRIES; i++) expect((await rejects(confirm(db, "000000", limits))).code).toMatch(/INVALID_CODE|CODE_EXPIRED/);
    const last = await rejects(confirm(db, "000000", limits));
    expect(last).toMatchObject({ status: 410, code: "CODE_EXPIRED" });
    expect(db.emailCode.rows[0]!.consumedAt).toBeInstanceOf(Date);
  });

  it("verifies the current address with the right code", async () => {
    const db = fakeDb();
    await ask(db, {});
    const code = /^(\d{6})/.exec((await queued(db))[0]!.subject)![1]!;
    const me = await confirm(db, code);
    expect(me.emailVerified).toBe(true);
    expect((await rejects(confirm(db, code))).code).toBe("CODE_EXPIRED");
  });

  it("moves the account and tells the old address", async () => {
    const db = fakeDb();
    await ask(db, { email: "new@example.com" }, true);
    const code = /^(\d{6})/.exec((await queued(db))[0]!.subject)![1]!;
    const me = await confirm(db, code);
    expect(me.email).toBe("new@example.com");
    const mails = await queued(db);
    expect(mails[1]).toMatchObject({ to: "owner@example.com" });
    expect(mails[1]!.text).toContain("n***@example.com");
  });

  it("hands an email change on PATCH /me to the code flow while email is on", async () => {
    const e = await rejects(call(accountHandlers["me.patch"], { body: { email: "x@example.com" }, actor: session(true), req: fakeReq(), ctx: ctxOf(fakeDb()) }));
    expect(e).toMatchObject({ status: 409, code: "EMAIL_CODE_REQUIRED" });
  });
});

describe("password change codes", () => {
  const CURRENT = "correct horse battery";
  const NEXT = "a brand new password";
  const withPassword = async (email = true) => {
    const db = fakeDb({ email });
    db.user.rows[0]!.passwordHash = await argonHash(CURRENT);
    return db;
  };
  const ask = (db: unknown, current = CURRENT, limits?: RateLimits) =>
    call<{ email: string; expiresAt: string }>(emailAuthHandlers["me.password.code"], { body: { current }, actor: session(), req: fakeReq(), reply: fakeReply(), ctx: ctxOf(db, limits) });
  const change = (db: unknown, code?: string, limits?: RateLimits) =>
    call(accountHandlers["me.password"], { body: { current: CURRENT, next: NEXT, ...(code ? { code } : {}) }, actor: session(), req: fakeReq(), reply: fakeReply(), ctx: ctxOf(db, limits) });
  const mailedCode = async (db: ReturnType<typeof fakeDb>) => /^(\d{6}) is your/.exec((await queued(db)).at(-1)!.subject)![1]!;

  it("needs email, and the current password before anything is mailed", async () => {
    expect((await rejects(ask(await withPassword(false)))).code).toBe("EMAIL_NOT_CONFIGURED");
    const db = await withPassword();
    expect((await rejects(ask(db, "wrong password"))).code).toBe("INVALID_CREDENTIALS");
    expect(db.job.rows).toHaveLength(0);
    expect(db.emailCode.rows).toHaveLength(0);
  });

  it("mails a code to the account address and answers with the address masked", async () => {
    const db = await withPassword();
    const r = await ask(db);
    expect(r.email).toBe("o***@example.com");
    const [mail] = await queued(db);
    expect(mail!.to).toBe("owner@example.com");
    expect(mail!.subject).toMatch(/^\d{6} is your Acme Cloud password change code$/);
    const code = await mailedCode(db);
    const row = db.emailCode.rows[0]!;
    expect(row).toMatchObject({ purpose: "password", email: "owner@example.com" });
    expect(row.codeHash).toBe(codeHash(ring, String(row.id), code));
    expect(JSON.stringify(db.emailCode.rows)).not.toContain(code);
  });

  it("changes nothing without the right code, then changes the password once", async () => {
    const db = await withPassword();
    const before = db.user.rows[0]!.passwordHash;
    await ask(db);
    const code = await mailedCode(db);
    expect((await rejects(change(db))).code).toBe("EMAIL_CODE_REQUIRED");
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await rejects(change(db, wrong))).code).toBe("INVALID_CODE");
    expect(db.user.rows[0]!.passwordHash).toBe(before);
    await change(db, code);
    expect(db.user.rows[0]!.passwordHash).not.toBe(before);
    expect(db.emailCode.rows[0]!.consumedAt).toBeInstanceOf(Date);
    // The code is spent: replaying it with the new password as the current one fails.
    const replay = call(accountHandlers["me.password"], { body: { current: NEXT, next: "another new password", code }, actor: session(), req: fakeReq(), reply: fakeReply(), ctx: ctxOf(db) });
    expect((await rejects(replay)).code).toBe("CODE_EXPIRED");
  });

  it("allows five tries, then voids the code", async () => {
    const db = await withPassword();
    await ask(db);
    const code = await mailedCode(db);
    const wrong = code === "000000" ? "111111" : "000000";
    const limits = new RateLimits();
    for (let i = 1; i < MAX_CODE_TRIES; i++) expect((await rejects(change(db, wrong, limits))).code).toMatch(/INVALID_CODE|CODE_EXPIRED/);
    expect(await rejects(change(db, wrong, limits))).toMatchObject({ status: 410, code: "CODE_EXPIRED" });
    expect((await rejects(change(db, code))).code).toBe("CODE_EXPIRED");
  });

  it("keeps password codes and address codes apart", async () => {
    const db = await withPassword();
    await ask(db);
    const code = await mailedCode(db);
    // A password code never verifies an address, and an address code never voids it.
    const e = await rejects(call(emailAuthHandlers["me.email.confirm"], { body: { code }, actor: session(), req: fakeReq(), reply: fakeReply(), ctx: ctxOf(db) }));
    expect(e.code).toBe("CODE_EXPIRED");
    await call(emailAuthHandlers["me.email.code"], { body: {}, actor: session(), req: fakeReq(), reply: fakeReply(), ctx: ctxOf(db) });
    await change(db, code);
    expect(db.user.rows[0]!.emailVerifiedAt).toBeNull();
  });

  it("needs no code while email is off", async () => {
    const db = await withPassword(false);
    const before = db.user.rows[0]!.passwordHash;
    await change(db);
    expect(db.user.rows[0]!.passwordHash).not.toBe(before);
  });
});

describe("email integration", () => {
  const SETTINGS = { host: "smtp.acme.dev", port: 465, tlsMode: "implicit", username: "mailer", fromName: "Acme", fromAddress: "ops@acme.dev" };
  const PASSWORD = "the-mail-password-value";
  const mailer = (fail?: () => MailError) => {
    const verified: SmtpServer[] = [];
    const sent: Array<{ server: SmtpServer; email: OutgoingEmail }> = [];
    const mail: Mailer = {
      verify: async (server) => {
        verified.push(server);
        if (fail) throw fail();
      },
      send: async (server, email) => {
        sent.push({ server, email });
        if (fail) throw fail();
        return { id: "<x@acme.dev>" };
      },
    };
    return { handlers: emailHandlers(defaultDeps({ mail })), verified, sent };
  };
  const connect = (h: ReturnType<typeof mailer>["handlers"], db: unknown, body: Row) =>
    call<Record<string, unknown>>(h["integrations.email.connect"], { body, actor: session(true), req: fakeReq(), ctx: ctxOf(db) });
  const testSend = (h: ReturnType<typeof mailer>["handlers"], db: unknown, body?: Row) =>
    call<{ to: string }>(h["integrations.email.test"], { body, actor: session(true), req: fakeReq(), reply: fakeReply(), ctx: ctxOf(db) });
  /** A database with the integration connected and its password really sealed. */
  const connected = async () => {
    const db = fakeDb();
    const { storeSecret } = await import("@dockify/db");
    db.integration.rows[0]!.createdAt = new Date();
    db.integration.rows[0]!.secretId = await storeSecret(db as never, ring, { kind: "integration_token", ownerType: "integration", ownerId: "int1" }, PASSWORD, null);
    return db;
  };

  it("tries the settings before keeping them, seals the password and never answers any of it", async () => {
    const db = fakeDb({ email: false });
    const { handlers, verified } = mailer();
    const view = await connect(handlers, db, { ...SETTINGS, password: PASSWORD });
    expect(verified[0]).toEqual({ host: "smtp.acme.dev", port: 465, tlsMode: "implicit", username: "mailer", password: PASSWORD });
    expect(JSON.stringify(view)).not.toContain(PASSWORD);
    expect(view).toMatchObject({ host: "smtp.acme.dev", port: 465, tlsMode: "implicit", username: "mailer", hasPassword: true, error: null });
    expect(I.EmailIntegration.safeParse(view).success).toBe(true);
    expect(db.secret.rows[0]).toMatchObject({ kind: "integration_token" });
    // No part of a password is kept as a hint.
    expect(db.secret.rows[0]!.hint ?? "").toBe("");
    expect(JSON.stringify(db.integration.rows[0]!.config)).not.toContain(PASSWORD);
  });

  it("saves nothing when the settings do not work, and names the field", async () => {
    const db = fakeDb({ email: false });
    const refused = mailer(() => new MailError("auth", "smtp.acme.dev refused the login. Check the username and password fields.", { field: "password", smtpCode: 535 }));
    expect(await rejects(connect(refused.handlers, db, { ...SETTINGS, password: "wrong-password" }))).toMatchObject({ status: 400, code: "EMAIL_LOGIN", extra: { field: "password" } });
    expect(db.integration.rows).toHaveLength(0);
    expect(db.secret.rows).toHaveLength(0);
    const blockedPort = mailer(() => new MailError("unreachable", "Could not reach smtp.acme.dev on port 465.", { field: "port" }));
    expect(await rejects(connect(blockedPort.handlers, db, { ...SETTINGS, password: "pw-value" }))).toMatchObject({ status: 502, code: "EMAIL_PORT", extra: { field: "port" }, message: "Could not reach smtp.acme.dev on port 465." });
    const tls = mailer(() => new MailError("tls", "no TLS", { field: "tlsMode" }));
    expect(await rejects(connect(tls.handlers, db, { ...SETTINGS, password: "pw-value" }))).toMatchObject({ code: "EMAIL_TLS", extra: { field: "tlsMode" } });
    const none = await rejects(connect(mailer().handlers, db, SETTINGS));
    expect(none).toMatchObject({ code: "EMAIL_LOGIN", extra: { field: "password" } });
  });

  it("refuses a private host, this server's own name and any other port before dialling", async () => {
    const before = process.env.DOCKIFY_PUBLIC_URL;
    process.env.DOCKIFY_PUBLIC_URL = "https://dash.acme.dev";
    try {
      const { handlers, verified } = mailer();
      const db = fakeDb({ email: false });
      for (const host of ["smtp.internal", "dash.acme.dev"]) expect(await rejects(connect(handlers, db, { ...SETTINGS, host, password: "pw-value" })), host).toMatchObject({ code: "EMAIL_HOST", extra: { field: "host" } });
      expect(await rejects(connect(handlers, db, { ...SETTINGS, port: 22, password: "pw-value" }))).toMatchObject({ code: "EMAIL_PORT", extra: { field: "port" } });
      expect(verified).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.DOCKIFY_PUBLIC_URL;
      else process.env.DOCKIFY_PUBLIC_URL = before;
    }
  });

  it("keeps the stored password on a blank field, only for the server and login it was saved for", async () => {
    const db = await connected();
    const same = mailer();
    await connect(same.handlers, db, { ...SETTINGS, fromName: "Acme ops", port: 2465 });
    expect(same.verified[0]).toMatchObject({ port: 2465, password: PASSWORD });
    expect(db.secret.rows).toHaveLength(1);
    const elsewhere = mailer();
    for (const moved of [{ host: "smtp.evil.example" }, { username: "someone-else" }]) {
      const e = await rejects(connect(elsewhere.handlers, db, { ...SETTINGS, ...moved }));
      expect(e, JSON.stringify(moved)).toMatchObject({ code: "EMAIL_LOGIN", extra: { field: "password" } });
      expect(e.message).toContain("Enter the password again");
    }
    expect(elsewhere.verified).toEqual([]);
    // Typing it again is allowed.
    await connect(elsewhere.handlers, db, { ...SETTINGS, host: "smtp.other.example", password: "new-password-value" });
    expect(elsewhere.verified[0]).toMatchObject({ host: "smtp.other.example", password: "new-password-value" });
  });

  it("sends the test to the signed-in user only", async () => {
    const db = await connected();
    const ok = mailer();
    const out = await testSend(ok.handlers, db);
    expect(out.to).toBe("owner@example.com");
    expect(ok.sent[0]!.email).toMatchObject({ to: "owner@example.com", fromName: "Acme", fromAddress: "ops@acme.dev" });
    expect(ok.sent[0]!.server).toMatchObject({ host: "smtp.acme.dev", password: PASSWORD });
  });

  it("tests the form's unsaved values without touching the row, and the stored password stays with its server", async () => {
    const db = await connected();
    const m = mailer();
    await testSend(m.handlers, db, { ...SETTINGS, port: 2465 });
    expect(m.sent[0]!.server).toMatchObject({ port: 2465, password: PASSWORD });
    expect(await rejects(testSend(m.handlers, db, { ...SETTINGS, host: "smtp.evil.example" }))).toMatchObject({ extra: { field: "password" } });
    expect(m.sent).toHaveLength(1);
    await testSend(m.handlers, db, { ...SETTINGS, host: "smtp.new.example", password: "typed-password" });
    expect(m.sent[1]!.server).toMatchObject({ host: "smtp.new.example", password: "typed-password" });
    expect(db.integration.rows[0]!.config).toMatchObject({ host: "smtp.acme.dev", port: 465 });
    // A draft that fails says nothing about the stored settings.
    const bad = mailer(() => new MailError("auth", "refused", { field: "password" }));
    await rejects(testSend(bad.handlers, db, { ...SETTINGS, host: "smtp.new.example", password: "typed-password" }));
    expect(db.integration.rows[0]!.status).toBe("connected");
    // And needs no row at all during setup.
    const fresh = fakeDb({ email: false });
    await testSend(m.handlers, fresh, { ...SETTINGS, password: "typed-password" });
    expect(m.sent[2]!.email.to).toBe("owner@example.com");
  });

  it("a refused login on the stored settings marks the card; a working test clears it; a refused recipient does neither", async () => {
    const db = await connected();
    const refused = mailer(() => new MailError("auth", "refused", { field: "password", smtpCode: 535 }));
    expect(await rejects(testSend(refused.handlers, db))).toMatchObject({ status: 400, code: "EMAIL_LOGIN" });
    expect(db.integration.rows[0]).toMatchObject({ status: "error", error: "The mail server refused the stored username or password" });
    await testSend(mailer().handlers, db);
    expect(db.integration.rows[0]).toMatchObject({ status: "connected", error: null });
    const recipient = mailer(() => new MailError("recipient", "The mail server refused this recipient.", { smtpCode: 550, detail: "550 no such user" }));
    expect(await rejects(testSend(recipient.handlers, db))).toMatchObject({ status: 400, code: "EMAIL_REFUSED", message: "The mail server refused this recipient. The server said: 550 no such user" });
    expect(db.integration.rows[0]).toMatchObject({ status: "connected", error: null });
  });

  it("says not connected when nothing is stored", async () => {
    expect(await rejects(testSend(mailer().handlers, fakeDb({ email: false })))).toMatchObject({ status: 409, code: "NOT_CONNECTED" });
  });
});
