/**
 * Long-lived responses (SSE log streams) outlive the request's own policy check. A reauthorizer
 * re-runs that check at most once per interval, so a revoked session, a removed member or a
 * disabled user stops receiving data within one interval instead of when the stream times out.
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
