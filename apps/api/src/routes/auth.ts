import { passwordMatches } from "../passwords.ts";
import { meta, requireSession } from "../actor.ts";
import type { FastifyRequest } from "fastify";
import { hash as argonHash } from "@node-rs/argon2";
import { hashToken, newToken, safeEqual } from "@dockify/crypto";
import { storeSecret, type Tx } from "@dockify/db";
import { ELEVATION_MS, sessionFromCookie } from "../actor.ts";
import { audit } from "../audit.ts";
import { clearCookie, readCookie, setCookie } from "../cookies.ts";
import { LOGIN_KNOWN_NETWORK_MS, networkKey } from "../ratelimit.ts";
import { HttpError, rateLimited } from "../errors.ts";
import { totpSecretOf } from "../mfa.ts";
import { revokeSessions, startSession } from "../sessions.ts";
import { generateTotpSecret, otpauthUri, totpMatchedCounter } from "../totp.ts";
import type { Ctx, Handlers } from "../app.ts";
import { accountHandlers, meView, proveTotp } from "./account.ts";
import { emailAuthHandlers } from "./email-auth.ts";
import { emailEnabled } from "../mailer.ts";
import { isNewDevice, sendSecurityNotice } from "../security-notice.ts";

const CHALLENGE_MS = 5 * 60_000;
const TRUSTED_DEVICE_MS = 30 * 24 * 3600_000;
const MAX_CODE_ATTEMPTS = 5;
/** Open second-factor challenges one user may hold; a new sign in expires the oldest beyond it. */
export const MAX_OPEN_CHALLENGES = 3;

const BAD_LOGIN = "Email or password is incorrect";


async function instanceName(ctx: Ctx): Promise<string> {
  const row = await ctx.db.instance.findUnique({ where: { id: 1 }, select: { name: true } });
  return row?.name ?? "Dockify";
}

/** Only for a device this account has not used recently. */
async function noticeSignIn(ctx: Ctx, userId: string, sessionId: string, req: FastifyRequest): Promise<void> {
  const fresh = await isNewDevice(ctx.db, userId, sessionId, req.headers["user-agent"] ?? null).catch(() => false);
  if (fresh) await sendSecurityNotice(ctx, userId, "signIn", req);
}

/** Keeps at most MAX_OPEN_CHALLENGES - 1 open challenges, so the new one makes the cap. */
export async function expireOldChallenges(db: Tx, userId: string, now = new Date()): Promise<number> {
  const open = await db.loginChallenge.findMany({
    where: { userId, consumedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const stale = open.slice(MAX_OPEN_CHALLENGES - 1).map((c) => c.id);
  if (!stale.length) return 0;
  const r = await db.loginChallenge.updateMany({ where: { id: { in: stale }, consumedAt: null }, data: { consumedAt: now } });
  return r.count;
}

/**
 * Whether this client already belongs to the account: a live trusted-device cookie, a network it signed in
 * from recently, or the network that just finished a password reset. Read only once the ceiling refuses a
 * request, so ordinary sign-ins never pay for it; the password and the per-network bucket still apply.
 */
async function knownClient(ctx: Ctx, email: string, req: FastifyRequest): Promise<boolean> {
  if (ctx.limits.login.trustedAfterReset(email, req.clientIp)) return true;
  const user = await ctx.db.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return false;
  const now = Date.now();
  const trusted = readCookie(req, ctx.web, "trusted");
  if (trusted) {
    const device = await ctx.db.trustedDevice.findUnique({ where: { tokenHash: hashToken(trusted) } });
    if (device && device.userId === user.id && !device.revokedAt && device.expiresAt.getTime() > now) return true;
  }
  const network = networkKey(req.clientIp);
  const recent = await ctx.db.session.findMany({ where: { userId: user.id, createdAt: { gte: new Date(now - LOGIN_KNOWN_NETWORK_MS) } }, orderBy: { createdAt: "desc" }, take: 50, select: { ip: true } });
  return recent.some((s) => !!s.ip && networkKey(s.ip) === network);
}

export const authHandlers: Handlers = {
  "auth.setupStatus": async ({ ctx }) => {
    const [row, email] = await Promise.all([
      ctx.db.instance.findUnique({ where: { id: 1 }, select: { name: true, setupCompletedAt: true } }),
      emailEnabled(ctx.db),
    ]);
    return row?.setupCompletedAt ? { needsSetup: false, instanceName: row.name, emailEnabled: email } : { needsSetup: true, emailEnabled: email };
  },

  "auth.setup": async ({ body, req, reply, ctx }) => {
    const { config, db, web } = ctx;
    if (config.setupToken && !(body.setupToken && safeEqual(body.setupToken, config.setupToken))) {
      throw new HttpError(
        403,
        body.setupToken ? "That setup token is not right. Paste the one the installer printed; the server also keeps it in secrets/setup_token in the install folder" : "This server needs the setup token the installer printed",
        "SETUP_TOKEN",
      );
    }
    const email = body.email.toLowerCase();
    const passwordHash = await argonHash(body.password);

    // One advisory lock serialises concurrent setups, so exactly one first admin can ever exist.
    const userId = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dockify.setup'))`;
      const inst = await tx.instance.findUnique({ where: { id: 1 } });
      if (!inst) throw new HttpError(503, "The instance is not initialised yet", "NOT_READY");
      if (inst.setupCompletedAt || (await tx.user.count()) > 0) throw new HttpError(409, "An admin already exists", "SETUP_DONE");
      const user = await tx.user.create({ data: { email, name: body.name, passwordHash, passwordChangedAt: new Date() } });
      const team = await tx.team.create({ data: { name: body.instanceName } });
      await tx.member.create({ data: { teamId: team.id, userId: user.id, role: "admin" } });
      await tx.instance.update({ where: { id: 1 }, data: { name: body.instanceName, setupCompletedAt: new Date() } });
      await tx.server.updateMany({ where: { isPrimary: true }, data: { name: body.instanceName } });
      await audit(tx, { category: "access", action: "auth.setup", verb: "created the first admin", actorType: "user", actorId: user.id, actorName: user.name, ...meta(req) });
      return user.id;
    });
    await startSession(db, reply, req, web, userId);
    return {};
  },

  "auth.login": async ({ body, req, reply, ctx }) => {
    const { db, web, limits } = ctx;
    const email = body.email.toLowerCase();
    // Only failures count against an account (ratelimit.ts LoginGuard). The per-address bucket already ran in the hook.
    let wait = limits.login.attempt(email, req.clientIp);
    // Several networks together can hold the account's ceiling down for good, so a client the
    // account already knows goes on, held only to its own network's rate.
    let ceiling = true;
    if (wait !== null && limits.login.onlyCeiling(email, req.clientIp)) {
      if (await knownClient(ctx, email, req)) {
        ceiling = false;
        wait = limits.login.attempt(email, req.clientIp, Date.now(), false);
      } else if (limits.login.reportCeiling(email)) {
        const held = await db.user.findUnique({ where: { email }, select: { id: true } });
        if (held) await audit(db, { category: "access", action: "auth.login.ceiling", verb: "had too many failed sign ins from several networks; new networks are refused for now", actorType: "user", actorId: held.id, actorName: email, failed: true, ...meta(req) });
      }
    }
    if (wait !== null) throw rateLimited(reply, wait);

    const user = await db.user.findUnique({ where: { email }, include: { member: true } });
    const ok = (await passwordMatches(user?.passwordHash, body.password)) && !!user && !user.disabledAt && !!user.member;
    if (!ok || !user) {
      await audit(db, { category: "access", action: "auth.login.denied", verb: "failed to sign in", actorType: "user", actorId: user?.id ?? null, actorName: email, failed: true, ...meta(req) });
      throw new HttpError(401, BAD_LOGIN, "INVALID_CREDENTIALS", { field: "password" });
    }
    limits.login.succeeded(email, req.clientIp, ceiling);

    if (user.totpConfirmedAt) {
      const trusted = readCookie(req, web, "trusted");
      const device = trusted ? await db.trustedDevice.findUnique({ where: { tokenHash: hashToken(trusted) } }) : null;
      const deviceOk = !!device && device.userId === user.id && !device.revokedAt && device.expiresAt > new Date();
      if (!deviceOk) {
        await expireOldChallenges(db, user.id);
        const token = newToken();
        await db.loginChallenge.create({
          data: { userId: user.id, tokenHash: hashToken(token), ip: req.clientIp, expiresAt: new Date(Date.now() + CHALLENGE_MS) },
        });
        setCookie(reply, web, "pending", token, CHALLENGE_MS);
        return { next: "verify" as const };
      }
      await db.trustedDevice.update({ where: { id: device.id }, data: { lastUsedAt: new Date() } });
    }

    const sessionId = await startSession(db, reply, req, web, user.id);
    await audit(db, { category: "access", action: "auth.login", verb: "signed in", actorType: "user", actorId: user.id, actorName: user.name, ...meta(req) });
    await noticeSignIn(ctx, user.id, sessionId, req);
    return { next: "done" as const };
  },

  "auth.verify": async ({ body, req, reply, ctx }) => {
    const { db, web } = ctx;
    const raw = readCookie(req, web, "pending");
    const expired = () => {
      clearCookie(reply, web, "pending");
      return new HttpError(410, "This sign in expired. Sign in again.", "CHALLENGE_EXPIRED");
    };
    if (!raw) throw expired();
    const challenge = await db.loginChallenge.findUnique({ where: { tokenHash: hashToken(raw) }, include: { user: true } });
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= new Date()) throw expired();

    // One lockout per user for every code check (mfa.ts), so a fresh challenge per sign in does
    // not reset the count. The guess that locks ends every open challenge, this one included.
    const accepted = await proveTotp(ctx, challenge.user, body.code, req, reply).catch((e: unknown) => {
      if (e instanceof HttpError && e.code === "MFA_LOCKED") clearCookie(reply, web, "pending");
      throw e;
    });
    if (!accepted) {
      const { failedAttempts } = await db.loginChallenge.update({
        where: { id: challenge.id },
        data: { failedAttempts: { increment: 1 } },
        select: { failedAttempts: true },
      });
      await audit(db, { category: "access", action: "auth.mfa.denied", verb: "entered a wrong code", actorType: "user", actorId: challenge.userId, actorName: challenge.user.name, failed: true, ...meta(req) });
      if (failedAttempts >= MAX_CODE_ATTEMPTS) {
        await db.loginChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
        clearCookie(reply, web, "pending");
        throw new HttpError(401, "Too many incorrect codes. Sign in again.", "CHALLENGE_LOCKED", { field: "code" });
      }
      throw new HttpError(401, "That code didn't match", "INVALID_CODE", { field: "code" });
    }

    // Spend the challenge exactly once, even if two verifies race.
    const spent = await db.loginChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (spent.count !== 1) throw expired();

    clearCookie(reply, web, "pending");
    const sessionId = await startSession(db, reply, req, web, challenge.userId);
    if (body.remember) {
      const token = newToken();
      await db.trustedDevice.create({ data: { userId: challenge.userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + TRUSTED_DEVICE_MS) } });
      setCookie(reply, web, "trusted", token, TRUSTED_DEVICE_MS);
    }
    await audit(db, { category: "access", action: "auth.login", verb: "signed in", actorType: "user", actorId: challenge.userId, actorName: challenge.user.name, ...meta(req) });
    await noticeSignIn(ctx, challenge.userId, sessionId, req);
    return {};
  },

  "auth.logout": async ({ req, reply, ctx }) => {
    const { db, web } = ctx;
    const actor = await sessionFromCookie(db, req, web);
    if (actor) {
      await db.session.update({ where: { id: actor.sessionId }, data: { revokedAt: new Date() } });
      await audit(db, { category: "access", action: "auth.logout", verb: "signed out", actorType: "user", actorId: actor.userId, actorName: actor.name, ...meta(req) });
    }
    clearCookie(reply, web, "session");
    return {};
  },

  "auth.invite.get": async ({ params, ctx }) => {
    const invite = await ctx.db.invite.findUnique({ where: { tokenHash: hashToken(params.token) }, include: { invitedBy: true } });
    if (!invite || invite.revokedAt) throw new HttpError(404, "This invite link is not valid", "INVITE_INVALID");
    if (invite.usedAt) throw new HttpError(410, "This invite was already used", "INVITE_USED", { reason: "used" });
    if (invite.expiresAt <= new Date()) throw new HttpError(410, "This invite has expired", "INVITE_EXPIRED", { reason: "expired" });
    return {
      email: invite.email,
      role: invite.role,
      invitedBy: invite.invitedBy?.name ?? "An admin",
      instanceName: await instanceName(ctx),
      expiresAt: invite.expiresAt.toISOString(),
    };
  },

  "auth.invite.accept": async ({ params, body, req, reply, ctx }) => {
    const { db, web } = ctx;
    const passwordHash = await argonHash(body.password);
    const userId = await db.$transaction(async (tx) => {
      const invite = await tx.invite.findUnique({ where: { tokenHash: hashToken(params.token) } });
      if (!invite || invite.revokedAt) throw new HttpError(404, "This invite link is not valid", "INVITE_INVALID");
      // Claim it with one conditional update, so a link can be used once even under a race.
      const claimed = await tx.invite.updateMany({
        where: { id: invite.id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) {
        const used = !!invite.usedAt;
        throw new HttpError(410, used ? "This invite was already used" : "This invite has expired", used ? "INVITE_USED" : "INVITE_EXPIRED", { reason: used ? "used" : "expired" });
      }
      const email = invite.email.toLowerCase();
      if (await tx.user.findUnique({ where: { email } })) throw new HttpError(409, "An account with this email already exists", "EMAIL_TAKEN");
      const user = await tx.user.create({ data: { email, name: body.name, passwordHash, passwordChangedAt: new Date() } });
      await tx.member.create({ data: { teamId: invite.teamId, userId: user.id, role: invite.role } });
      await audit(tx, { category: "access", action: "team.join", verb: "joined the team", suffix: `as ${invite.role}`, actorType: "user", actorId: user.id, actorName: user.name, ...meta(req) });
      return user.id;
    });
    await startSession(db, reply, req, web, userId);
    return {};
  },

  "auth.stepUp": async ({ body, actor, req, reply, ctx }) => {
    const { db, limits } = ctx;
    const a = requireSession(actor);
    const user = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
    let ok: boolean;
    if (user.totpConfirmedAt) {
      if (!body.code) throw new HttpError(400, "Enter the code from your authenticator app", "CODE_REQUIRED", { field: "code" });
      // The same per-user lockout as sign in and two-factor off, not one more budget per session.
      ok = await proveTotp(ctx, user, body.code, req, reply);
    } else {
      const wait = limits.stepUp.check(a.sessionId);
      if (wait !== null) throw rateLimited(reply, wait);
      if (!body.password) throw new HttpError(400, "Enter your password", "PASSWORD_REQUIRED", { field: "password" });
      ok = await passwordMatches(user.passwordHash, body.password);
      if (ok) limits.stepUp.succeeded(a.sessionId);
      else limits.stepUp.failed(a.sessionId);
    }
    if (!ok) {
      await audit(db, { category: "access", action: "auth.stepUp.denied", verb: "failed to confirm their identity", actorType: "user", actorId: a.userId, actorName: a.name, failed: true, ...meta(req) });
      throw new HttpError(401, user.totpConfirmedAt ? "That code didn't match" : "Incorrect password", "INVALID_CREDENTIALS", { field: user.totpConfirmedAt ? "code" : "password" });
    }
    const expiresAt = new Date(Date.now() + ELEVATION_MS);
    await db.session.update({ where: { id: a.sessionId }, data: { elevatedUntil: expiresAt } });
    await audit(db, { category: "access", action: "auth.stepUp", verb: "confirmed their identity", actorType: "user", actorId: a.userId, actorName: a.name, ...meta(req) });
    return { expiresAt: expiresAt.toISOString() };
  },

  "me.get": async ({ actor, ctx }) => meView(ctx.db, actor!.userId, actor!.role),

  "me.2fa.setup": async ({ actor, ctx }) => {
    const { db, ring } = ctx;
    const a = requireSession(actor);
    const user = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
    if (user.totpConfirmedAt) throw new HttpError(409, "Two-factor sign in is already on", "MFA_ENABLED");
    const secret = generateTotpSecret();
    await db.$transaction(async (tx) => {
      const secretId = await storeSecret(tx, ring, { kind: "totp", ownerType: "user", ownerId: user.id }, secret, null);
      await tx.user.update({ where: { id: user.id }, data: { totpSecretId: secretId, totpLastUsedStep: null } });
      if (user.totpSecretId) await tx.secret.delete({ where: { id: user.totpSecretId } });
    });
    return { secret, otpauthUrl: otpauthUri(secret, user.email, await instanceName(ctx)), qrDataUrl: null };
  },

  "me.2fa.verify": async ({ body, actor, req, reply, ctx }) => {
    const { db, ring, limits } = ctx;
    const a = requireSession(actor);
    const wait = limits.totp.check(a.sessionId);
    if (wait !== null) throw rateLimited(reply, wait);
    const user = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
    if (user.totpConfirmedAt) throw new HttpError(409, "Two-factor sign in is already on", "MFA_ENABLED");
    const secret = await totpSecretOf(db, ring, user);
    if (!secret) throw new HttpError(409, "Start the authenticator setup first", "MFA_NOT_STARTED");
    const counter = totpMatchedCounter(secret, body.code, Date.now());
    if (counter === null) {
      limits.totp.failed(a.sessionId);
      throw new HttpError(401, "That code didn't match, try the current one", "INVALID_CODE", { field: "code" });
    }
    limits.totp.succeeded(a.sessionId);
    await db.$transaction(async (tx) => {
      // A new authenticator starts unlocked: turning the old one off on the host leaves its lockout behind.
      await tx.user.update({ where: { id: user.id }, data: { totpConfirmedAt: new Date(), totpLastUsedStep: counter, totpFailedCount: 0, totpLockouts: 0, totpLockedUntil: null } });
      // Turning MFA on ends every other session. The route is elevated, so
      // the password was proven in this window before anyone else can be signed out.
      await revokeSessions(tx, user.id, a.sessionId);
      await audit(tx, { category: "access", action: "auth.mfa.enable", verb: "turned on two-factor sign in", actorType: "user", actorId: a.userId, actorName: a.name, ...meta(req) });
    });
    await sendSecurityNotice(ctx, a.userId, "mfaOn", req);
    return undefined;
  },
  ...accountHandlers,
  ...emailAuthHandlers,
};
