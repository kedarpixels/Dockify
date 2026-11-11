/**
 * The email half of auth: reset links and 6-digit codes. Without email every route answers EMAIL_NOT_CONFIGURED.
 * At rest, reset tokens are SHA-256 (256-bit random, so no KDF is needed) and codes a hash keyed by the master key.
 * Links are built from DOCKIFY_PUBLIC_URL, never from a request header.
 */
import { passwordMatches } from "../passwords.ts";
import { meta, requireSession } from "../actor.ts";
import { randomInt, randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { hash as argonHash } from "@node-rs/argon2";
import { hashToken, keyedHash, newToken, safeEqual, type Keyring } from "@dockify/crypto";
import type { Db, Tx } from "@dockify/db";
import { emailChanged, maskEmail, passwordChangeCode, passwordReset, verifyEmail, CODE_MINUTES, RESET_MINUTES } from "@dockify/email";
import type { SessionActor } from "../actor.ts";
import { audit } from "../audit.ts";
import { HttpError, isUniqueViolation, rateLimited, stepUpRequired } from "../errors.ts";
import { allowRecipient, emailEnabled, instanceName, queueEmail, queueEmailTx } from "../mailer.ts";
import { sendSecurityNotice } from "../security-notice.ts";
import { revokeApiTokens, revokeSessions, voidResetLinks } from "../sessions.ts";
import type { Ctx, Handlers } from "../app.ts";
import { describeDevice, meView } from "./account.ts";

export const RESET_MS = RESET_MINUTES * 60_000;
export const CODE_MS = CODE_MINUTES * 60_000;
export const MAX_CODE_TRIES = 5;
/** Settled codes and reset links are kept this long for the activity trail, then pruned. */
const KEEP_SETTLED_MS = 24 * 3600_000;

/** No user agent means no Device row in the email, rather than a guessed "Unknown device". */
const requestedFrom = (req: FastifyRequest) => {
  const ua = req.headers["user-agent"] ?? null;
  return { device: ua ? describeDevice(ua).device : null, ip: req.clientIp || null };
};

const notConfigured = () => new HttpError(409, "Email is not set up on this server", "EMAIL_NOT_CONFIGURED");

async function requireEmail(db: Tx): Promise<void> {
  if (!(await emailEnabled(db))) throw notConfigured();
}

/** A 6-digit code from the CSPRNG, zero padded. */
export const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** The stored form of a code: keyed by the master key and bound to its row. */
export const codeHash = (ring: Keyring, id: string, code: string) => keyedHash(ring, "email-code", `${id}:${code}`);

export const resetUrl = (publicOrigin: string, token: string) => `${publicOrigin.replace(/\/+$/, "")}/reset/${token}`;

/** Runs after the 202 has gone out, so the answer and its timing are the same for every address. */
export async function startPasswordReset(ctx: Ctx, email: string, req: FastifyRequest, now = new Date()): Promise<"sent" | "skipped"> {
  const { db, ring, config, limits } = ctx;
  const user = await db.user.findUnique({ where: { email }, include: { member: true } });
  if (!user || user.disabledAt || !user.member || !allowRecipient(limits, user.email)) return "skipped";

  const token = newToken();
  const message = passwordReset({ instanceName: await instanceName(db), origin: config.publicUrl.origin, url: resetUrl(config.publicUrl.origin, token), ...requestedFrom(req) });
  await db.$transaction(async (tx) => {
    await tx.passwordReset.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - KEEP_SETTLED_MS) } } });
    // One live link per account: a new request voids the ones before it.
    await tx.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
    await tx.passwordReset.create({ data: { userId: user.id, tokenHash: hashToken(token), ip: req.clientIp || null, expiresAt: new Date(now.getTime() + RESET_MS) } });
    await queueEmailTx(tx, ring, user.email, message);
    await audit(tx, { category: "access", action: "auth.forgot", verb: "asked for a password reset link", actorType: "user", actorId: user.id, actorName: user.name, ...meta(req) });
  });
  return "sent";
}

type ResetRow = { id: string; userId: string; usedAt: Date | null; expiresAt: Date; user: { email: string; disabledAt: Date | null } };

function assertUsable(row: ResetRow | null, now: Date): asserts row is ResetRow {
  if (!row || row.user.disabledAt) throw new HttpError(404, "This reset link is not valid", "RESET_INVALID");
  if (row.usedAt) throw new HttpError(410, "This reset link was already used", "RESET_USED", { reason: "used" });
  if (row.expiresAt <= now) throw new HttpError(410, "This reset link has expired", "RESET_EXPIRED", { reason: "expired" });
}

const findReset = (db: Tx, token: string) =>
  db.passwordReset.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: { select: { email: true, disabledAt: true } } } });

/** Address codes (verify, change) and password codes live apart: one never spends or voids the other. */
const ADDRESS = { in: ["verify", "change"] as ("verify" | "change")[] };

async function latestOpenCode(db: Tx, userId: string, now: Date) {
  return db.emailCode.findFirst({ where: { userId, purpose: ADDRESS, consumedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } });
}

/** Counts a wrong code against its row, spends the row at the limit, and refuses. */
async function wrongCode(ctx: Ctx, a: SessionActor, rowId: string, now: Date, req: FastifyRequest, action: string, verb: string): Promise<never> {
  const { db, limits } = ctx;
  limits.emailConfirm.failed(a.userId);
  const { attempts } = await db.emailCode.update({ where: { id: rowId }, data: { attempts: { increment: 1 } }, select: { attempts: true } });
  await audit(db, { category: "access", action, verb, actorType: "user", actorId: a.userId, actorName: a.name, failed: true, ...meta(req) });
  if (attempts >= MAX_CODE_TRIES) {
    await db.emailCode.update({ where: { id: rowId }, data: { consumedAt: now } });
    throw new HttpError(410, "Too many wrong codes. Ask for a new one.", "CODE_EXPIRED", { field: "code" });
  }
  throw new HttpError(401, "That code didn't match", "INVALID_CODE", { field: "code" });
}

/** The current password, limited per user and audited when wrong. Answers with the user row. */
export async function proveCurrentPassword(ctx: Ctx, a: SessionActor, current: string, req: FastifyRequest, reply: FastifyReply) {
  const { db, limits } = ctx;
  const wait = limits.password.check(a.userId);
  if (wait !== null) throw rateLimited(reply, wait);
  const user = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
  if (!(await passwordMatches(user.passwordHash, current))) {
    limits.password.failed(a.userId);
    await audit(db, { category: "access", action: "me.password.denied", verb: "failed to change their password", actorType: "user", actorId: a.userId, actorName: a.name, failed: true, ...meta(req) });
    throw new HttpError(401, "Your current password is incorrect", "INVALID_CREDENTIALS", { field: "current" });
  }
  limits.password.succeeded(a.userId);
  return user;
}

/**
 * Checks the emailed code before anything changes and counts a wrong one. Returns the spend, which me.password
 * runs inside the transaction that writes the new hash, so the code works exactly once even if two submits race.
 */
export async function checkPasswordCode(
  ctx: Ctx,
  a: SessionActor,
  code: string | undefined,
  req: FastifyRequest,
  reply: Parameters<typeof rateLimited>[0],
): Promise<(tx: Tx) => Promise<void>> {
  const { db, ring, limits } = ctx;
  if (!code) throw new HttpError(409, "Enter the code we emailed you", "EMAIL_CODE_REQUIRED", { field: "code" });
  const wait = limits.emailConfirm.check(a.userId);
  if (wait !== null) throw rateLimited(reply, wait);
  const now = new Date();
  const gone = () => new HttpError(410, "This code has expired. Ask for a new one.", "CODE_EXPIRED", { field: "code" });
  const row = await db.emailCode.findFirst({ where: { userId: a.userId, purpose: "password", consumedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" } });
  if (!row) throw gone();
  if (!safeEqual(codeHash(ring, row.id, code), row.codeHash)) {
    return await wrongCode(ctx, a, row.id, now, req, "me.password.denied", "entered a wrong password change code");
  }
  limits.emailConfirm.succeeded(a.userId);
  return async (tx) => {
    const spent = await tx.emailCode.updateMany({ where: { id: row.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
    if (spent.count !== 1) throw gone();
  };
}

export const emailAuthHandlers: Handlers = {
  "auth.forgot": async ({ body, req, reply, ctx }) => {
    const email = body.email.toLowerCase();
    await requireEmail(ctx.db);
    const wait = ctx.limits.forgot.rate(email);
    if (wait !== null) throw rateLimited(reply, wait);
    // Detached on purpose: the lookup, the token and the queue write start after the answer, so
    // an address with an account takes exactly as long to answer as one without.
    setImmediate(() => {
      startPasswordReset(ctx, email, req).catch((e: unknown) => {
        req.log.error({ err: e instanceof Error ? e.name : "error" }, "password reset request failed");
      });
    });
    return undefined;
  },

  "auth.reset.get": async ({ params, ctx }) => {
    const row = await findReset(ctx.db, params.token);
    assertUsable(row, new Date());
    return { email: maskEmail(row.user.email), expiresAt: row.expiresAt.toISOString() };
  },

  "auth.reset": async ({ params, body, req, ctx }) => {
    const { db } = ctx;
    // Hashed before the lookup, so a bad token and a good one cost the same.
    const passwordHash = await argonHash(body.password);
    const now = new Date();
    const userId = await db.$transaction(async (tx) => {
      const row = await findReset(tx, params.token);
      assertUsable(row, now);
      // Spend the link exactly once, even if two submits race.
      const claimed = await tx.passwordReset.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (claimed.count !== 1) throw new HttpError(410, "This reset link was already used", "RESET_USED", { reason: "used" });
      // Following the link proves the inbox, so the address counts as verified from here on.
      const user = await tx.user.update({
        where: { id: row.userId },
        data: { passwordHash, passwordChangedAt: now, emailVerifiedAt: now },
        select: { id: true, name: true },
      });
      await voidResetLinks(tx, user.id, now);
      await revokeSessions(tx, user.id);
      // A reset is what someone does after losing control of an account, so a token minted meanwhile must not outlive it.
      const tokens = await revokeApiTokens(tx, user.id, now);
      if (tokens) await audit(tx, { category: "access", action: "token.revoke", verb: "revoked their API tokens", suffix: `(${tokens}) with a password reset`, actorType: "user", actorId: user.id, actorName: user.name, ...meta(req) });
      await tx.trustedDevice.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
      await tx.loginChallenge.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: now } });
      await audit(tx, { category: "access", action: "auth.reset", verb: "reset their password from an emailed link", actorType: "user", actorId: user.id, actorName: user.name, ...meta(req) });
      return user.id;
    });
    const reset = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (reset) ctx.limits.login.trustAfterReset(reset.email, req.clientIp);
    await sendSecurityNotice(ctx, userId, "passwordReset", req);
    return {};
  },

  "me.email.code": async ({ body, actor, req, reply, ctx }) => {
    const a = requireSession(actor);
    const { db, ring, limits } = ctx;
    await requireEmail(db);
    const user = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
    const target = body.email?.toLowerCase();
    const change = target !== undefined && target !== user.email;
    // Moving the account is as sensitive as it was through PATCH /me: it needs a fresh step-up.
    if (change && !a.elevated) throw stepUpRequired();
    const to = change ? target : user.email;
    if (change && (await db.user.findUnique({ where: { email: to }, select: { id: true } }))) {
      throw new HttpError(409, "An account with this email already exists", "EMAIL_TAKEN", { field: "email" });
    }
    const wait = limits.emailCode.check(a.userId);
    if (wait !== null) throw rateLimited(reply, wait);
    if (!allowRecipient(limits, to)) throw rateLimited(reply, 120);

    const now = new Date();
    const id = randomUUID();
    const code = newCode();
    const expiresAt = new Date(now.getTime() + CODE_MS);
    const message = verifyEmail({ instanceName: await instanceName(db), origin: ctx.config.publicUrl.origin, code });
    await db.$transaction(async (tx) => {
      await tx.emailCode.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - KEEP_SETTLED_MS) } } });
      // A new code voids the open ones, so only the latest email works.
      await tx.emailCode.updateMany({ where: { userId: a.userId, purpose: ADDRESS, consumedAt: null }, data: { consumedAt: now } });
      await tx.emailCode.create({ data: { id, userId: a.userId, purpose: change ? "change" : "verify", email: to, codeHash: codeHash(ring, id, code), expiresAt } });
      await queueEmailTx(tx, ring, to, message);
      await audit(tx, {
        category: "access", action: "me.email.code", verb: "asked for an email code", suffix: change ? "to change their email" : "to verify their email",
        actorType: "user", actorId: a.userId, actorName: a.name, ...meta(req),
      });
    });
    return { email: to, purpose: change ? ("change" as const) : ("verify" as const), expiresAt: expiresAt.toISOString() };
  },

  /** Step one of a password change while email is on; me.password takes the code and checks it first. */
  "me.password.code": async ({ body, actor, req, reply, ctx }) => {
    const a = requireSession(actor);
    const { db, ring, limits } = ctx;
    await requireEmail(db);
    const user = await proveCurrentPassword(ctx, a, body.current, req, reply);
    const sendWait = limits.emailCode.check(a.userId);
    if (sendWait !== null) throw rateLimited(reply, sendWait);
    if (!allowRecipient(limits, user.email)) throw rateLimited(reply, 120);

    const now = new Date();
    const id = randomUUID();
    const code = newCode();
    const expiresAt = new Date(now.getTime() + CODE_MS);
    const message = passwordChangeCode({ instanceName: await instanceName(db), origin: ctx.config.publicUrl.origin, code, ...requestedFrom(req) });
    await db.$transaction(async (tx) => {
      await tx.emailCode.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - KEEP_SETTLED_MS) } } });
      // Only the latest password code works; address codes are left alone.
      await tx.emailCode.updateMany({ where: { userId: a.userId, purpose: "password", consumedAt: null }, data: { consumedAt: now } });
      await tx.emailCode.create({ data: { id, userId: a.userId, purpose: "password", email: user.email, codeHash: codeHash(ring, id, code), expiresAt } });
      await queueEmailTx(tx, ring, user.email, message);
      await audit(tx, {
        category: "access", action: "me.password.code", verb: "asked for an email code", suffix: "to change their password",
        actorType: "user", actorId: a.userId, actorName: a.name, ...meta(req),
      });
    });
    return { email: maskEmail(user.email), expiresAt: expiresAt.toISOString() };
  },

  "me.email.confirm": async ({ body, actor, req, reply, ctx }) => {
    const a = requireSession(actor);
    const { db, ring, limits } = ctx;
    const wait = limits.emailConfirm.check(a.userId);
    if (wait !== null) throw rateLimited(reply, wait);
    const now = new Date();
    const row = await latestOpenCode(db, a.userId, now);
    const gone = () => new HttpError(410, "This code has expired. Ask for a new one.", "CODE_EXPIRED", { field: "code" });
    if (!row) throw gone();

    if (!safeEqual(codeHash(ring, row.id, body.code), row.codeHash)) {
      return await wrongCode(ctx, a, row.id, now, req, "me.email.denied", "entered a wrong email code");
    }
    limits.emailConfirm.succeeded(a.userId);

    const user = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
    const oldEmail = user.email;
    try {
      await db.$transaction(async (tx) => {
        const spent = await tx.emailCode.updateMany({ where: { id: row.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
        if (spent.count !== 1) throw gone();
        if (row.purpose === "verify") {
          // A code for an address the account has since left proves nothing about the current one.
          if (row.email !== user.email) throw gone();
          await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: now } });
          await audit(tx, { category: "access", action: "me.email.verify", verb: "verified their email", actorType: "user", actorId: a.userId, actorName: a.name, ...meta(req) });
          return;
        }
        await tx.user.update({ where: { id: user.id }, data: { email: row.email, emailVerifiedAt: now } });
        await voidResetLinks(tx, user.id, now);
        await audit(tx, { category: "access", action: "me.email.change", verb: "changed their email", suffix: "with an emailed code", actorType: "user", actorId: a.userId, actorName: a.name, ...meta(req) });
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, "An account with this email already exists", "EMAIL_TAKEN", { field: "email" });
      throw e;
    }
    if (row.purpose === "change") await noticeOldAddress(ctx, oldEmail, row.email, req, now);
    return meView(db, a.userId, a.role);
  },
};

/** Tells the address an account just left. Best effort: the change already happened. */
async function noticeOldAddress(ctx: Ctx, oldEmail: string, newEmail: string, req: FastifyRequest, at: Date): Promise<void> {
  if (!allowRecipient(ctx.limits, oldEmail)) return;
  const message = emailChanged({ instanceName: await instanceName(ctx.db), origin: ctx.config.publicUrl.origin, newEmail, at, ...requestedFrom(req) });
  await queueEmail(ctx.db as Db, ctx.ring, oldEmail, message).catch((e: unknown) => {
    req.log.error({ err: e instanceof Error ? e.name : "error" }, "email change notice was not queued");
  });
}
