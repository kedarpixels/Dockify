import { z } from "zod";
import { Iso } from "./common.ts";

/*
 * The `security` block rides inside the signed release feed, so only the release signature can raise an
 * alert or take one away.
 */

/** How serious the fixed issue is. Critical caps "Remind me in" at 3 days, important at 7. */
export const SecurityLevel = z.enum(["critical", "important"]);
export type SecurityLevel = z.infer<typeof SecurityLevel>;


export const SECURITY_SNOOZE_CAP: Record<SecurityLevel, number> = { critical: 3, important: 7 };

/**
 * The newest release above the running version that carries a security block, at the highest level of every
 * pending one. A newer release without a block never hides an older pending fix.
 */
export const SecurityRelease = z.object({
  /** The release that carries the block, without a leading v. */
  version: z.string(),
  level: SecurityLevel,
  /** Plain text from the signed feed: what the fix closes. Shown escaped, never as markup. */
  summary: z.string(),
  advisory: z.string().nullable(),
  /** CVE ids, newest release first. */
  cves: z.array(z.string()),
  publishedAt: Iso,
  maxSnoozeDays: z.number(),
});

export const SecurityAlert = z.object({
  release: SecurityRelease.nullable(),
  current: z.string(),
  /** The release Update now installs: the newest this install may move to now, or null. */
  target: z.string().nullable(),
  /** Until when this member put the popup off for `release`, or null when it is due. The banner stays either way. */
  snoozedUntil: Iso.nullable(),
  /** An update or rollback in flight: the popup stays closed and the banner says so. */
  updating: z.object({ kind: z.enum(["update", "rollback"]), version: z.string() }).nullable(),
});

/** "Remind me in": the release it is for (a newer one opens the popup again) and 1, 3 or 7 days. */
export const SecuritySnoozeBody = z.strictObject({
  version: z.string().regex(/^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/),
  days: z.union([z.literal(1), z.literal(3), z.literal(7)]),
});
