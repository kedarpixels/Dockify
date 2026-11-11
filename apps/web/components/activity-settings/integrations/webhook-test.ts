/* What a "Send test" answer does to a webhook's row. */

/** The API's code for a test that left the worker and the endpoint refused or never answered. */
const DELIVERY_FAILED = "WEBHOOK_FAILED";

type TestAnswer = { ok: true } | { ok: false; error: string; code?: string };
type TestState = { status: string; error: string | null; lastSentAt: string | null; lastFailedAt: string | null };

/**
 * The row after a test. Only a delivery that was tried and failed marks it failing: a test that
 * never left (worker down or busy, offline, signed out, rate limited) says nothing about the
 * endpoint, so the row keeps what it had.
 */
export function afterTest<W extends TestState>(w: W, r: TestAnswer, at: string): W {
  if (r.ok) return { ...w, status: "ok", error: null, lastSentAt: at };
  if (r.code !== DELIVERY_FAILED) return w;
  return { ...w, status: "failing", error: r.error, lastFailedAt: at };
}
