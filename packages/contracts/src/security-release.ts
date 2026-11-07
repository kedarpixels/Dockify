import { z } from "zod";
import { Iso } from "./common.ts";

/*
 * Security releases: the optional `security` block of a signed release (the release feed,
 * apps/api/src/modules/platform/updates/release.ts), as the dashboard reads it. The block rides
 * inside the signed feed, so only the release signature can raise an alert or take one away.
 *
 *   server.updates                 UpdateStatus.security: the pending security release, or null
 *   server.updates.security        the same for this user, with their "Remind me in" and any update in flight
 *   server.updates.security.snooze "Remind me in" 1, 3 or 7 days, capped by the level
 */

/** How serious the fixed issue is. Critical caps "Remind me in" at 3 days, important at 7. */
export const SecurityLevel = z.enum(["critical", "important"]);
export type SecurityLevel = z.infer<typeof SecurityLevel>;


/** The longest "Remind me in" each level allows, in days. */
export const SECURITY_SNOOZE_CAP: Record<SecurityLevel, number> = { critical: 3, important: 7 };

/**
 * The pending security release: the newest release above the running version that carries a
 * security block, at the highest level of every pending one, with every pending CVE id. A newer
 * release without a block never hides an older pending fix.
 */
export const SecurityRelease = z.object({
  /** The release that carries the block, without a leading v. */
  version: z.string(),
  level: SecurityLevel,
  /** Plain text from the signed feed: what the fix closes. Shown escaped, never as markup. */
  summary: z.string(),
  /** The advisory, an https URL, or null. */
  advisory: z.string().nullable(),
  /** CVE ids, newest release first. */
  cves: z.array(z.string()),
  publishedAt: Iso,
  /** The longest "Remind me in" this level allows, in days (SECURITY_SNOOZE_CAP). */
  maxSnoozeDays: z.number(),
});

/** What the console's banner and popup read for the signed-in member. */
export const SecurityAlert = z.object({
  /** The pending security release, or null when nothing newer than the running version carries a block. */
  release: SecurityRelease.nullable(),
  /** The version this install runs. */
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
