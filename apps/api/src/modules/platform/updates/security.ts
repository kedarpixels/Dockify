/**
 * Security releases in the console: the pending security block (release.ts pendingSecurity, read
 * from the stored verified feed only) with this member's "Remind me in", for the banner every
 * member sees and the popup Admins see.
 *
 * Reminder rules: 1, 3 or 7 days, never past the level's cap (critical 3, important 7). A reminder
 * holds only for the alert it was taken for, keyed <version>:<level>, so a newer security release,
 * or the same one raised to critical, opens the popup again at once. The popup's close key counts
 * as one day.
 */
import type { Db, User } from "@dockify/db";
import { bare, chooseRelease, MAX_SNOOZE_DAYS, pendingSecurity, securityInfo, type PendingSecurity, type SecurityLevel } from "./release.ts";
import { storedFeed, type UpdateEnv } from "./state.ts";

export { MAX_SNOOZE_DAYS } from "./release.ts";

const DAY_MS = 86_400_000;
/** Clock skew a stored reminder may run past its cap before it is no longer trusted. */
const SKEW_MS = 60_000;

/** The "Remind me in" choices, in days. */
export const SNOOZE_DAYS = [1, 3, 7] as const;
export type SnoozeDays = (typeof SNOOZE_DAYS)[number];

/** The alert a reminder belongs to. */
export const remindKey = (s: Pick<PendingSecurity, "version" | "level">) => `${bare(s.version)}:${s.level}`;

/** When the popup opens again after "Remind me in `days`": never later than the level allows. */
export function remindAt(level: SecurityLevel, days: number, now: Date): Date {
  const d = Math.max(1, Math.min(Math.floor(days) || 1, MAX_SNOOZE_DAYS[level]));
  return new Date(now.getTime() + d * DAY_MS);
}

type Reminder = Pick<User, "securityRemindKey" | "securityRemindAt">;

/**
 * Until when the popup stays closed for this member, or null when it is due: no reminder, one for
 * another alert (a newer release, a raised level), one that has passed, or one longer than the
 * level allows (taken before the level was raised, or written by hand).
 */
export function activeReminder(alert: PendingSecurity | null, r: Reminder | null | undefined, now: Date): Date | null {
  if (!alert || !r?.securityRemindKey || !r.securityRemindAt) return null;
  if (r.securityRemindKey !== remindKey(alert)) return null;
  const at = r.securityRemindAt.getTime();
  if (at <= now.getTime() || at > now.getTime() + MAX_SNOOZE_DAYS[alert.level] * DAY_MS + SKEW_MS) return null;
  return r.securityRemindAt;
}

/** The pending security release, from the stored verified feed of the channel in use, or null. */
export function pendingFrom(inst: { latestRelease: unknown; updateChannel: string } | null, current: string): { security: PendingSecurity | null; target: string | null } {
  const feed = storedFeed(inst?.latestRelease);
  if (!feed || feed.channel !== inst?.updateChannel) return { security: null, target: null };
  return { security: pendingSecurity(feed, current), target: chooseRelease(feed, current).target?.version ?? null };
}

export interface SecurityAlert {
  release: ReturnType<typeof securityInfo>;
  current: string;
  target: string | null;
  snoozedUntil: string | null;
  updating: { kind: "update" | "rollback"; version: string } | null;
}

/** GET server.updates.security: the pending security release and this member's reminder. */
export async function securityAlert(db: Db, env: UpdateEnv, userId: string, now = new Date()): Promise<SecurityAlert> {
  const [inst, user, live] = await Promise.all([
    db.instance.findUnique({ where: { id: 1 }, select: { releaseVersion: true, latestRelease: true, updateChannel: true } }),
    db.user.findUnique({ where: { id: userId }, select: { securityRemindKey: true, securityRemindAt: true } }),
    db.releaseUpdate.findFirst({ where: { state: { in: ["running", "waiting"] } }, orderBy: { startedAt: "desc" }, select: { kind: true, version: true } }),
  ]);
  const current = inst?.releaseVersion ?? env.version;
  const { security, target } = pendingFrom(inst, current);
  const until = activeReminder(security, user, now);
  return {
    release: securityInfo(security),
    current,
    target,
    snoozedUntil: until?.toISOString() ?? null,
    updating: live ? { kind: live.kind, version: live.version } : null,
  };
}

/**
 * POST server.updates.security.snooze. Puts the popup off for the release the member saw. When
 * that is no longer the pending alert (a newer security release came in meanwhile), nothing is
 * stored and the fresh alert comes back, so the popup shows the newer release instead.
 */
export async function snoozeSecurity(db: Db, env: UpdateEnv, userId: string, body: { version: string; days: number }, now = new Date()): Promise<{ alert: SecurityAlert; stored: Date | null }> {
  const alert = await securityAlert(db, env, userId, now);
  const rel = alert.release;
  if (!rel || bare(rel.version) !== bare(body.version)) return { alert, stored: null };
  const at = remindAt(rel.level, body.days, now);
  await db.user.update({ where: { id: userId }, data: { securityRemindKey: remindKey(rel), securityRemindAt: at } });
  return { alert: { ...alert, snoozedUntil: at.toISOString() }, stored: at };
}
