import "server-only";
import { STEP_UP_MINUTES } from "./step-up";

/*
 * Design preview only (DOCKIFY_PREVIEW=1, no API): the step-up window the API would keep on the
 * session, so the preview asks "Confirm it is you" exactly where the API would refuse an elevated
 * write. It lives on globalThis, shared by every route and action of this one preview process, so
 * one confirmation holds for 5 minutes across pages, as it does on the API. A deployed build never
 * reads it: every caller checks for the preview first.
 */

const KEY = Symbol.for("dockify.preview.stepUpUntil");
const slot = globalThis as unknown as Record<symbol, number | undefined>;

/** True inside the preview's step-up window. */
export const previewElevated = () => (slot[KEY] ?? 0) > Date.now();

/** Opens the preview's step-up window and answers when it ends, as POST /api/v1/auth/step-up does. */
export function previewElevate(): string {
  const until = Date.now() + STEP_UP_MINUTES * 60_000;
  slot[KEY] = until;
  return new Date(until).toISOString();
}
