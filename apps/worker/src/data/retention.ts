/**
 * Which stored dumps retention may remove. Pure, so the api can preview exactly what the worker
 * will do. The rules exist because a lowered retention is how backup history gets destroyed:
 *
 *   - Only ready backups with a stored object are candidates; running and failed rows hold nothing.
 *   - Manual backups are never removed by a schedule's retention. Someone took them on purpose.
 *   - The newest MIN_KEEP ready backups always stay, whatever the age, so a stopped schedule or a
 *     long outage never ages out the last good copies.
 *   - Everything else older than retentionDays expires. The row stays (expiredAt is set) so the
 *     history still shows it; only the object is deleted.
 */

export const MIN_KEEP = 3;
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
}

export function selectExpired<T extends RetentionCandidate>(backups: readonly T[], retentionDays: number, now: Date = new Date()): T[] {
  const days = Math.max(1, Math.floor(retentionDays));
  const cutoff = now.getTime() - days * DAY_MS;
  const stored = backups
    .filter((b) => b.status === "ready" && b.objectKey && !b.expiredAt)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const protectedIds = new Set(stored.slice(0, MIN_KEEP).map((b) => b.id));
  return stored.filter((b) => !protectedIds.has(b.id) && b.trigger !== "manual" && b.createdAt.getTime() < cutoff);
}

export function failedRowsToDelete<T extends RetentionCandidate>(backups: readonly T[], now: Date = new Date()): T[] {
  const cutoff = now.getTime() - FAILED_ROW_DAYS * DAY_MS;
  return backups.filter((b) => b.status === "failed" && b.createdAt.getTime() < cutoff);
}

/** True when a schedule change would let retention remove more than it does today. */
export function isRetentionDecrease(before: { retentionDays: number; enabled: boolean }, after: { retentionDays: number; enabled: boolean }): boolean {
  return after.retentionDays < before.retentionDays || (before.enabled && !after.enabled);
}
