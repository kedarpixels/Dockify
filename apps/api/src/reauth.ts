/**
 * Long-lived responses (SSE log streams) outlive the request's own policy check, so it is re-run at most
 * once per interval: a revoked session or a removed member stops receiving data within one interval.
 */
export const REAUTH_MS = 60_000;

export type Reauthorizer = (now?: number) => Promise<boolean>;

export function createReauthorizer(check: () => Promise<unknown>, everyMs = REAUTH_MS, start = Date.now()): Reauthorizer {
  let last = start;
  let denied = false;
  return async (now = Date.now()) => {
    if (denied) return false;
    if (now - last < everyMs) return true;
    last = now;
    try {
      await check();
      return true;
    } catch {
      denied = true;
      return false;
    }
  };
}
