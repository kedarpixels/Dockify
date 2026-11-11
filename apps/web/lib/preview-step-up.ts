import "server-only";
import { STEP_UP_MINUTES } from "./step-up";

// Design preview only: the step-up window the API would keep on the session. It lives on globalThis,
// so one confirmation holds for 5 minutes across every route and action of the preview process.

const KEY = Symbol.for("dockify.preview.stepUpUntil");
const slot = globalThis as unknown as Record<symbol, number | undefined>;

export const previewElevated = () => (slot[KEY] ?? 0) > Date.now();

/** Opens the preview's step-up window and answers when it ends, as POST /api/v1/auth/step-up does. */
export function previewElevate(): string {
  const until = Date.now() + STEP_UP_MINUTES * 60_000;
  slot[KEY] = until;
  return new Date(until).toISOString();
}
