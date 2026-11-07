import type { FastifyReply, FastifyRequest } from "fastify";
import { hashToken, newToken } from "@dockify/crypto";
import type { Tx } from "@dockify/db";
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from "./actor.ts";
import { setCookie, type WebOrigin } from "./cookies.ts";

/** Mints a session row and sets its cookie. The raw token only ever lives in the cookie. */
export async function startSession(
  db: Tx,
  reply: FastifyReply,
  req: FastifyRequest,
  web: WebOrigin,
  userId: string,
  now = new Date(),
): Promise<string> {
  const token = newToken();
  const session = await db.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      ip: req.clientIp || null,
      userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_IDLE_MS),
      absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
    },
  });
  setCookie(reply, web, "session", token, SESSION_ABSOLUTE_MS);
  return session.id;
}

/** Voids the open password reset links of a user: a link mailed before a password or address change must not outlive it. */
export async function voidResetLinks(db: Tx, userId: string, now = new Date()): Promise<void> {
  await db.passwordReset.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
}

/** Revokes every live API token of a user. Returns how many. */
export async function revokeApiTokens(db: Tx, userId: string, now = new Date()): Promise<number> {
  const r = await db.apiToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  return r.count;
}

/** Ends every session of a user, optionally keeping one. Returns how many were ended. */
export async function revokeSessions(db: Tx, userId: string, keepSessionId?: string): Promise<number> {
  const r = await db.session.updateMany({
    where: { userId, revokedAt: null, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return r.count;
}
