import "server-only";
import { isPreviewMode } from "./preview-mode";
import type { SecurityLevel, SecurityRelease } from "./security-release";

// Design preview only. DOCKIFY_PREVIEW_SECURITY: unset is a critical release, "important" an
// important one, and 0, off, false or no gives none, so screenshots of other pages stay uncovered.

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The level the preview offers, or null when it offers no security release. */
function previewSecurityLevel(env: NodeJS.ProcessEnv = process.env): SecurityLevel | null {
  if (!isPreviewMode(env)) return null;
  const want = env.DOCKIFY_PREVIEW_SECURITY?.trim().toLowerCase() ?? "";
  if (/^(0|off|false|no)$/.test(want)) return null;
  return want === "important" ? "important" : "critical";
}

export const previewSecurityOn = (env: NodeJS.ProcessEnv = process.env) => previewSecurityLevel(env) !== null;

/** Sample text: the zeros in the CVE id mark it as a placeholder. */
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
