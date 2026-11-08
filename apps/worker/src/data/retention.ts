/**
 * Which stored dumps retention may remove. Pure, so the api can preview exactly what the worker
 * will do. Retention runs per tier (a backup counts in the tier its destination names), and its
 * rules exist because a lowered retention is how backup history gets destroyed:
 *
 *   - Only ready backups with a stored object are candidates; running and failed rows hold nothing,
 *     so a failed run is never counted and never pushes a good one out.
 *   - Manual backups are never removed and never counted. Someone took them on purpose.
 *   - The newest `keep` automatic backups always stay, whatever their age, so a stopped schedule or
 *     a long outage never ages out the last good copies. With `keepDays`, every one newer than that
 *     stays too.
 *   - The newest one whose restore test did not fail stays as well, so the only good copy of a tier
 *     is never removed in favour of one known to be broken.
 *   - A backup a restore or restore test is reading is never removed under it.
 *   - Everything else expires. The row stays (expiredAt is set) so the history still shows it;
 *     only the object is deleted.
 */

/** Failed rows carry no object; they are deleted after this long so the list does not fill up. */
export const FAILED_ROW_DAYS = 30;

const DAY_MS = 86_400_000;

export interface RetentionCandidate {
  id: string;
  status: "running" | "ready" | "failed";
  trigger: "schedule" | "manual" | "pre_deploy" | "pre_update" | "pre_restore";
  createdAt: Date;
  objectKey: string | null;
  expiredAt: Date | null;
  restoreTestStatus?: "passed" | "failed" | "running" | "not_tested";
}

export interface RetentionPolicy {
  /** The newest this many automatic backups always stay; at least 1. */
  keep: number;
  /** Also kept: every automatic backup newer than this many days. Null keeps by count alone. */
  keepDays: number | null;
}

export function selectExpired<T extends RetentionCandidate>(backups: readonly T[], policy: RetentionPolicy, now: Date = new Date(), inUse: ReadonlySet<string> = new Set()): T[] {
  const keep = Math.max(1, Math.floor(policy.keep));
  const cutoff = policy.keepDays === null ? null : now.getTime() - Math.max(1, Math.floor(policy.keepDays)) * DAY_MS;
  const counted = backups
    .filter((b) => b.status === "ready" && b.objectKey && !b.expiredAt && b.trigger !== "manual")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const kept = new Set(counted.slice(0, keep).map((b) => b.id));
  const good = counted.find((b) => b.restoreTestStatus !== "failed");
  if (good) kept.add(good.id);
  return counted.filter((b) => !kept.has(b.id) && !inUse.has(b.id) && (cutoff === null || b.createdAt.getTime() < cutoff));
}

export function failedRowsToDelete<T extends RetentionCandidate>(backups: readonly T[], now: Date = new Date()): T[] {
  const cutoff = now.getTime() - FAILED_ROW_DAYS * DAY_MS;
  return backups.filter((b) => b.status === "failed" && b.createdAt.getTime() < cutoff);
}

/** True when a schedule change would let retention remove more than it does today. */
export function isRetentionDecrease(before: RetentionPolicy & { enabled: boolean }, after: RetentionPolicy & { enabled: boolean }): boolean {
  const days = (p: RetentionPolicy) => p.keepDays ?? 0;
  return after.keep < before.keep || days(after) < days(before) || (before.enabled && !after.enabled);
}
