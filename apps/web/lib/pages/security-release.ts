import "server-only";
import { cookies } from "next/headers";
import { apiRequest } from "@/lib/api";
import { upstreamStatus } from "@/lib/http";
import { previewSecurityOn, previewSecurityRelease } from "@/lib/preview-security";
import { readAlert, remindKey, SNOOZE_CAP, type SecurityAlert, type SecurityAlertResult, type SecurityRelease, type SnoozeDays } from "@/lib/security-release";
import { isPreviewMode } from "@/lib/preview-mode";

/*
 * Loader for the console's security release banner and popup (lib/security-release.ts).
 *
 * Read by the console layout on every page load and polled by the banner (app/api/server/updates/
 * security). Without DOCKIFY_API_URL the design preview serves its fixture (lib/preview-security.ts)
 * and keeps each browser's "Remind me in" in a cookie of its own.
 */

const DAY = 86_400_000;

/** Design preview only: this browser's reminder, "<version>:<level>|<ISO until>". */
const PREVIEW_REMINDER = "dockify-preview-security-reminder";

/** The fixture's versions, as the Server page fixture has them. */
const PREVIEW_CURRENT = "0.9.0";
const PREVIEW_TARGET = "0.9.2";

async function previewReminder(release: SecurityRelease, now: number): Promise<string | null> {
  const raw = (await cookies()).get(PREVIEW_REMINDER)?.value ?? "";
  const [key, until] = raw.split("|");
  const at = Date.parse(until ?? "");
  // The same rules as the API: the same alert, not passed, never longer than the level allows.
  if (key !== remindKey(release) || !(at > now) || at > now + SNOOZE_CAP[release.level] * DAY + 60_000) return null;
  return new Date(at).toISOString();
}

async function previewAlert(now: Date): Promise<SecurityAlert> {
  const release = previewSecurityOn() ? previewSecurityRelease(now) : null;
  return {
    release,
    current: PREVIEW_CURRENT,
    target: PREVIEW_TARGET,
    snoozedUntil: release ? await previewReminder(release, now.getTime()) : null,
    updating: null,
  };
}

/** The alert for the signed-in member. A failed read is no alert: the banner never guesses. */
export async function getSecurityAlert(): Promise<SecurityAlertResult> {
  if (process.env.DOCKIFY_API_URL) {
    const r = await apiRequest<unknown>("/api/v1/server/updates/security");
    return { source: "api", data: r.ok ? readAlert(r.data) : null };
  }
  if (isPreviewMode()) return { source: "preview", data: await previewAlert(new Date()) };
  return { source: "none", data: null };
}

export interface SnoozeOutcome {
  status: number;
  body: SecurityAlert | { error: string; code?: string };
}

/** "Remind me in" for the signed-in member. The API refuses it for a Viewer and caps it by level. */
export async function snoozeSecurityAlert(version: string, days: SnoozeDays): Promise<SnoozeOutcome> {
  if (process.env.DOCKIFY_API_URL) {
    const r = await apiRequest<unknown>("/api/v1/server/updates/security/snooze", { method: "POST", body: { version, days } });
    if (!r.ok) return { status: upstreamStatus(r.status), body: { error: r.error, code: r.code } };
    const alert = readAlert(r.data);
    return alert ? { status: 200, body: alert } : { status: 502, body: { error: "The API sent something this dashboard cannot read" } };
  }
  if (isPreviewMode()) {
    const now = new Date();
    const alert = await previewAlert(now);
    const rel = alert.release;
    // Another release than the one the member saw: nothing is stored, the fresh alert comes back.
    if (!rel || rel.version !== version.replace(/^v/, "")) return { status: 200, body: alert };
    const until = new Date(now.getTime() + Math.min(days, SNOOZE_CAP[rel.level]) * DAY).toISOString();
    (await cookies()).set(PREVIEW_REMINDER, `${remindKey(rel)}|${until}`, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 8 * 86_400 });
    return { status: 200, body: { ...alert, snoozedUntil: until } };
  }
  return { status: 503, body: { error: "No data source" } };
}
