/** The API's code for a test that left the worker and the endpoint refused or never answered. */
const DELIVERY_FAILED = "WEBHOOK_FAILED";

type TestAnswer = { ok: true } | { ok: false; error: string; code?: string };
type TestState = { status: string; error: string | null; lastSentAt: string | null; lastFailedAt: string | null };

/** Only a tried and failed delivery marks the row failing: a test that never left says nothing about the endpoint. */
export function afterTest<W extends TestState>(w: W, r: TestAnswer, at: string): W {
  if (r.ok) return { ...w, status: "ok", error: null, lastSentAt: at };
  if (r.code !== DELIVERY_FAILED) return w;
  return { ...w, status: "failing", error: r.error, lastFailedAt: at };
}
