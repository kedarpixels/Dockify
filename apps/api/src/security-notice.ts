/** Security mail about a user's own account. Best effort: a failure to queue never fails the request that triggered it. */
import type { FastifyRequest } from "fastify";
import type { Db } from "@dockify/db";
import { securityNotice, type SecurityEvent } from "@dockify/email";
import type { Ctx } from "./app.ts";
import { allowRecipient, emailEnabled, instanceName, queueEmail } from "./mailer.ts";
import { describeDevice } from "./routes/account.ts";

/** How far back a device label counts as known for the sign in notice. */
export const KNOWN_DEVICE_DAYS = 90;

/** Admins always get it; a viewer can turn it off. */
export function wantsSecurityMail(user: { emailSecurity: boolean; disabledAt: Date | null; member: { role: string } | null }): boolean {
  if (user.disabledAt || !user.member) return false;
  return user.member.role === "admin" || user.emailSecurity;
}

/** True when no other session of this user in the window came from the same browser and system. */
export async function isNewDevice(db: Db, userId: string, sessionId: string, userAgent: string | null, now = Date.now()): Promise<boolean> {
  const label = describeDevice(userAgent).device;
  const earlier = await db.session.findMany({
    where: { userId, id: { not: sessionId }, createdAt: { gte: new Date(now - KNOWN_DEVICE_DAYS * 86_400_000) } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { userAgent: true },
  });
  return !earlier.some((s) => describeDevice(s.userAgent).device === label);
}

export async function sendSecurityNotice(ctx: Pick<Ctx, "db" | "ring" | "limits" | "config">, userId: string, event: SecurityEvent, req: FastifyRequest): Promise<boolean> {
  const { db, ring, limits } = ctx;
  try {
    if (!(await emailEnabled(db))) return false;
    const user = await db.user.findUnique({ where: { id: userId }, include: { member: { select: { role: true } } } });
    if (!user || !wantsSecurityMail(user) || !allowRecipient(limits, user.email)) return false;
    const ua = req.headers["user-agent"] ?? null;
    const message = securityNotice({
      instanceName: await instanceName(db),
      origin: ctx.config.publicUrl.origin,
      event,
      at: new Date(),
      device: ua ? describeDevice(ua).device : null,
      ip: req.clientIp || null,
      url: new URL("/settings?section=security", ctx.config.publicUrl).toString(),
    });
    await queueEmail(db, ring, user.email, message);
    return true;
  } catch (e) {
    req.log?.error?.({ err: e }, "security notice not queued");
    return false;
  }
}
