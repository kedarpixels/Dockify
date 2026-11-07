import "server-only";
import { isPreviewMode } from "./preview-mode";
import type { SecurityLevel, SecurityRelease } from "./security-release";

/*
 * Design preview only (DOCKIFY_PREVIEW=1, no API): the pending security release the fixture
 * offers, so the popup, the banner and the bell can be seen on the preview. It is the 0.9.2
 * release the Server page fixture already offers (lib/pages/server-backups.ts).
 *
 *   DOCKIFY_PREVIEW_SECURITY unset       a critical release (Remind me in 1 or 3 days)
 *   DOCKIFY_PREVIEW_SECURITY=important   an important one (1, 3 or 7 days)
 *   DOCKIFY_PREVIEW_SECURITY=0           none (or off, false, no), so screenshot runs of other pages
 *                                        are not covered by the popup
 *
 * A deployed build never reads any of this: every caller checks for the preview first.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The level the preview offers, or null when it offers no security release. */
function previewSecurityLevel(env: NodeJS.ProcessEnv = process.env): SecurityLevel | null {
  if (!isPreviewMode(env)) return null;
  const want = env.DOCKIFY_PREVIEW_SECURITY?.trim().toLowerCase() ?? "";
  if (/^(0|off|false|no)$/.test(want)) return null;
  return want === "important" ? "important" : "critical";
}

/** True when the preview should offer its security release. */
export const previewSecurityOn = (env: NodeJS.ProcessEnv = process.env) => previewSecurityLevel(env) !== null;

/**
 * The preview's security block. Sample text; the zeros in the CVE id mark it as a placeholder, and
 * the advisory link points at example.com, as the fixture's release notes do.
 */
export function previewSecurityRelease(now: Date, level: SecurityLevel = previewSecurityLevel() ?? "critical"): SecurityRelease {
  return {
    version: "0.9.2",
    level,
    summary: "A path check in the log viewer could read files outside the log folder, and session cookies outlived a step-up. Every install on 0.8 or 0.9 is affected.",
    advisory: "https://example.com/dockify/security/advisories/0.9.2",
    cves: ["CVE-2026-0000"],
    publishedAt: new Date(now.getTime() - DAY - 4 * HOUR).toISOString(),
    maxSnoozeDays: level === "critical" ? 3 : 7,
  };
}
