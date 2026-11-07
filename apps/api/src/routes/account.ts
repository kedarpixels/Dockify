/**
 * The signed-in user's own account: profile, password, two-factor off, and the session list. Each
 * handler re-proves what it needs inside (the current password, or a fresh TOTP code), so a
 * borrowed session cookie alone can neither lock the owner out nor keep itself alive once the
 * owner revokes it.
 */
import { passwordMatches } from "../passwords.ts";
import { meta, requireSession } from "../actor.ts";
import { hash as argonHash } from "@node-rs/argon2";
import { sniffImage } from "@dockify/contracts";
import type { Db, Tx } from "@dockify/db";
import type { SessionActor } from "../actor.ts";
import { audit } from "../audit.ts";
import { HttpError, isUniqueViolation, rateLimited, stepUpRequired } from "../errors.ts";
import { consumeTotp, totpSecretOf } from "../mfa.ts";
import { revokeSessions, voidResetLinks } from "../sessions.ts";
import { emailEnabled } from "../mailer.ts";
import { checkPasswordCode, proveCurrentPassword } from "./email-auth.ts";
import { sendSecurityNotice } from "../security-notice.ts";
import type { Ctx, Handlers } from "../app.ts";


export async function meView(db: Db, userId: string, role: SessionActor["role"]) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role,
    avatarUrl: user.avatarUrl,
    twoFactor: { enabled: !!user.totpConfirmedAt },
    emailVerified: !!user.emailVerifiedAt,
    githubLogin: user.githubLogin,
    githubVerified: !!user.githubLogin && !!user.githubVerifiedAt,
    timeZone: user.timeZone,
    hour12: user.hour12,
    notify: { deployFailed: user.emailDeployFailed, security: role === "admin" || user.emailSecurity },
  };
}

/**
 * The schema only checks the data URL's prefix. The bytes must really be the image it names, so a
 * picture every member's dashboard renders can never be markup or a decoder's surprise.
 */
export function checkAvatar(dataUrl: string): void {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
  const bytes = m ? Buffer.from(m[2]!, "base64") : null;
  const sniffed = bytes ? sniffImage(bytes) : null;
  if (!m || !sniffed || sniffed.mime !== m[1]) throw new HttpError(400, "Use a PNG, JPEG or WebP image", "INVALID_IMAGE", { field: "avatar" });
}

/** A short device label and form factor from a user agent, for the session list. */
export function describeDevice(ua: string | null): { device: string; kind: "desktop" | "mobile" | "tablet" | "unknown" } {
  const s = ua ?? "";
  const browser = /Edg\//.test(s) ? "Edge" : /OPR\//.test(s) ? "Opera" : /Firefox\//.test(s) ? "Firefox"
    : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : null;
  const os = /Windows/.test(s) ? "Windows" : /iPhone|iPad/.test(s) ? "iOS" : /Mac OS X/.test(s) ? "macOS"
    : /Android/.test(s) ? "Android" : /Linux/.test(s) ? "Linux" : null;
  const device = browser && os ? `${browser} on ${os}` : browser ?? os ?? "Unknown device";
  // The shape of the device, for its icon. An iPad, or an Android browser without "Mobile" in its
  // agent string, is a tablet. Nothing recognised (a script, an empty agent) is unknown, not a desktop.
  const tablet = /iPad|Tablet/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s));
  const kind = tablet ? "tablet" : /Mobi|iPhone|iPod|Android/i.test(s) ? "mobile" : browser || os ? "desktop" : "unknown";
  return { device, kind };
}

/**
 * Checks a fresh TOTP code for a user with MFA on and spends its step. Rate limited per user with a
 * hard lockout: only the session holder can try, and the code is the proof being asked for.
 */
async function requireTotp(ctx: Ctx, userId: string, code: string, reply: Parameters<typeof rateLimited>[0]) {
  const { db, ring, limits } = ctx;
  const wait = limits.totp.check(userId);
  if (wait !== null) throw rateLimited(reply, wait);
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.totpConfirmedAt) throw new HttpError(409, "Two-factor sign in is not on", "MFA_DISABLED");
  const secret = await totpSecretOf(db, ring, user);
  const ok = !!secret && (await consumeTotp(db, secret, user.id, code)) !== null;
  if (!ok) {
    limits.totp.failed(userId);
    throw new HttpError(401, "That code didn't match", "INVALID_CODE", { field: "code" });
  }
  limits.totp.succeeded(userId);
  return user;
}

/** Ends every other session and every remembered browser of a user, and any pending sign in. */
async function evictOthers(tx: Tx, userId: string, keepSessionId: string): Promise<void> {
  await revokeSessions(tx, userId, keepSessionId);
  await tx.trustedDevice.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  await tx.loginChallenge.updateMany({ where: { userId, consumedAt: null }, data: { consumedAt: new Date() } });
}

export const accountHandlers: Handlers = {
  "me.patch": async ({ body, actor, req, ctx }) => {
    const a = requireSession(actor);
    const { db } = ctx;
    const user = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
    const email = body.email?.toLowerCase();
    const emailChanges = email !== undefined && email !== user.email;
    // With email on, a new address must prove itself with a code first (me.email.code).
    if (emailChanges && (await emailEnabled(db))) {
      throw new HttpError(409, "Confirm the new address with a code first", "EMAIL_CODE_REQUIRED", { field: "email" });
    }
    // The email is where a password reset link goes, so moving it needs a fresh step-up.
    if (emailChanges && !a.elevated) throw stepUpRequired();
    const data: { name?: string; email?: string; emailVerifiedAt?: null; avatarUrl?: string | null } = {};
    if (body.name !== undefined && body.name !== user.name) data.name = body.name;
    if (emailChanges) {
      data.email = email;
      data.emailVerifiedAt = null;
    }
    if (body.avatar) checkAvatar(body.avatar);
    if (body.avatar !== undefined) data.avatarUrl = body.avatar;
    if (Object.keys(data).length) {
      try {
        await db.$transaction(async (tx) => {
          await tx.user.update({ where: { id: a.userId }, data });
          if (emailChanges) await voidResetLinks(tx, a.userId);
          await audit(tx, {
            category: "access", action: "me.patch", verb: "updated their profile",
            suffix: emailChanges ? "and changed their email" : null,
            actorType: "user", actorId: a.userId, actorName: data.name ?? a.name, ...meta(req),
          });
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw new HttpError(409, "An account with this email already exists", "EMAIL_TAKEN", { field: "email" });
        throw e;
      }
    }
    return meView(db, a.userId, a.role);
  },

  "me.preferences": async ({ body, actor, req, ctx }) => {
    const a = requireSession(actor);
    const { db } = ctx;
    const user = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
    const next = {
      timeZone: body.timeZone === undefined ? user.timeZone : body.timeZone,
      hour12: body.hour12 ?? user.hour12,
      emailDeployFailed: body.notify?.deployFailed ?? user.emailDeployFailed,
      // Admins cannot turn security mail off; the stored choice waits for a move to Viewer.
      emailSecurity: a.role === "admin" ? user.emailSecurity : (body.notify?.security ?? user.emailSecurity),
    };
    const changes = (Object.keys(next) as Array<keyof typeof next>)
      .filter((k) => next[k] !== user[k])
      .map((k) => ({ key: k, before: String(user[k] ?? "browser"), after: String(next[k] ?? "browser") }));
    if (changes.length) {
      await db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: a.userId }, data: next });
        await audit(tx, {
          category: "config", action: "me.preferences", verb: "changed their preferences",
          actorType: "user", actorId: a.userId, actorName: a.name, changes, ...meta(req),
        });
      });
    }
    return meView(db, a.userId, a.role);
  },

  /**
   * Links the caller's own GitHub login. Nothing proves the login is theirs, so only an admin's link
   * is verified on the spot; a viewer's waits for an admin to approve it in team.change. A verified
   * login is never taken over. An unverified one gives way to an admin who links it, so a viewer
   * cannot squat the admin's login to collect their pushes or keep them from linking it.
   */
  "me.github": async ({ body, actor, req, ctx }) => {
    const a = requireSession(actor);
    const { db } = ctx;
    const user = await db.user.findUniqueOrThrow({ where: { id: a.userId } });
    const verifiedAt = body.login && a.role === "admin" ? new Date() : null;
    // Relinking the same login never drops a verification, and only an admin's relink adds one.
    const unchanged = body.login === user.githubLogin && (!body.login || !!user.githubVerifiedAt || !verifiedAt);
    if (!unchanged) {
      try {
        await db.$transaction(async (tx) => {
          const holder = body.login
            ? await tx.user.findUnique({ where: { githubLogin: body.login }, select: { id: true, name: true, githubVerifiedAt: true } })
            : null;
          if (holder && holder.id !== a.userId) {
            if (holder.githubVerifiedAt || !verifiedAt) throw new HttpError(409, "Another member already linked this GitHub account", "GITHUB_TAKEN", { field: "login" });
            await tx.user.update({ where: { id: holder.id }, data: { githubLogin: null, githubVerifiedAt: null } });
            await audit(tx, {
              category: "config", action: "team.github.reclaim", verb: "took over the GitHub login of",
              targetType: "user", targetId: holder.id, targetLabel: holder.name, suffix: `(${body.login}, unverified)`,
              actorType: "user", actorId: a.userId, actorName: a.name,
              changes: [{ key: "githubLogin", before: body.login, after: null }], ...meta(req),
            });
          }
          await tx.user.update({ where: { id: a.userId }, data: { githubLogin: body.login, githubVerifiedAt: verifiedAt } });
          await audit(tx, {
            category: "config", action: body.login ? "me.github.link" : "me.github.unlink",
            verb: body.login ? "linked GitHub account" : "unlinked GitHub account",
            targetLabel: body.login ?? user.githubLogin, actorType: "user", actorId: a.userId, actorName: a.name,
            suffix: body.login && !verifiedAt ? "(unverified until an admin approves it)" : null,
            changes: [{ key: "githubLogin", before: user.githubLogin, after: body.login }, { key: "githubVerified", before: !!user.githubVerifiedAt, after: !!verifiedAt }],
            ...meta(req),
          });
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw new HttpError(409, "Another member already linked this GitHub account", "GITHUB_TAKEN", { field: "login" });
        throw e;
      }
    }
    return meView(db, a.userId, a.role);
  },

  "me.password": async ({ body, actor, req, reply, ctx }) => {
    const a = requireSession(actor);
    const { db, limits } = ctx;
    const user = await proveCurrentPassword(ctx, a, body.current, req, reply);
    // While email is on, the change also needs the code me.password.code mailed. It is checked
    // here, before anything changes, and spent in the transaction that writes the new hash.
    const spendCode = (await emailEnabled(db)) ? await checkPasswordCode(ctx, a, body.code, req, reply) : null;
    const passwordHash = await argonHash(body.next);
    await db.$transaction(async (tx) => {
      if (spendCode) await spendCode(tx);
      await tx.user.update({ where: { id: a.userId }, data: { passwordHash, passwordChangedAt: new Date() } });
      // A new password ends every other session. API tokens stay: a change
      // proves the current password, and Settings is right there to revoke one. A reset ends them.
      await evictOthers(tx, a.userId, a.sessionId);
      await voidResetLinks(tx, a.userId);
      await audit(tx, { category: "access", action: "me.password", verb: "changed their password", actorType: "user", actorId: a.userId, actorName: a.name, ...meta(req) });
    });
    await sendSecurityNotice(ctx, a.userId, "password", req);
    return undefined;
  },

  "me.2fa.disable": async ({ body, actor, req, reply, ctx }) => {
    const a = requireSession(actor);
    const user = await requireTotp(ctx, a.userId, body.code, reply);
    await ctx.db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { totpSecretId: null, totpConfirmedAt: null, totpLastUsedStep: null } });
      if (user.totpSecretId) await tx.secret.delete({ where: { id: user.totpSecretId } });
      await evictOthers(tx, user.id, a.sessionId);
      await audit(tx, { category: "access", action: "auth.mfa.disable", verb: "turned off two-factor sign in", actorType: "user", actorId: a.userId, actorName: a.name, ...meta(req) });
    });
    await sendSecurityNotice(ctx, a.userId, "mfaOff", req);
    return undefined;
  },

  "me.sessions.list": async ({ actor, ctx }) => {
    const a = requireSession(actor);
    const now = new Date();
    const rows = await ctx.db.session.findMany({
      where: { userId: a.userId, revokedAt: null, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
      orderBy: { lastSeenAt: "desc" },
      take: 200,
    });
    return rows.map((s) => ({
      id: s.id,
      ...describeDevice(s.userAgent),
      ip: s.ip ?? "",
      location: null,
      lastSeenAt: s.lastSeenAt.toISOString(),
      createdAt: s.createdAt.toISOString(),
      current: s.id === a.sessionId,
    }));
  },

  "me.sessions.revoke": async ({ params, actor, req, ctx }) => {
    const a = requireSession(actor);
    const r = await ctx.db.session.updateMany({ where: { id: params.id, userId: a.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (r.count !== 1) throw new HttpError(404, "That session is not active", "NOT_FOUND");
    await audit(ctx.db, { category: "access", action: "me.sessions.revoke", verb: "signed out a session", actorType: "user", actorId: a.userId, actorName: a.name, ...meta(req) });
    return undefined;
  },

  "me.sessions.revokeOthers": async ({ actor, req, ctx }) => {
    const a = requireSession(actor);
    const ended = await revokeSessions(ctx.db, a.userId, a.sessionId);
    await audit(ctx.db, { category: "access", action: "me.sessions.revokeOthers", verb: "signed out every other session", suffix: `(${ended})`, actorType: "user", actorId: a.userId, actorName: a.name, ...meta(req) });
    return undefined;
  },
};
