import "server-only";
import { crossSiteRefusal } from "./same-origin";

// The route handler kit. Every route under app/api uses it, so the same-origin rule and the error
// envelope cannot drift between routes.

/** Every API route answer is private to the visitor and never cached. */
export const NO_STORE = { "cache-control": "no-store" } as const;

/** What a loader hands its route handler, answered as it is: `json(body, status)`. */
export interface RouteAnswer<T> {
  status: number;
  body: T | { error: string; code?: string };
}

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

/** The one refusal shape: `{ ok: false, error }`, plus `code` and anything else the client reads. */
export const refuse = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ ok: false, error, ...extra }, status);

/** Same origin only, plus a JSON content type unless `json` is false (a bodiless DELETE): a cross-site
 * form cannot send JSON. Returns the refusal to send, or null when the call may pass. */
export function guardWrite(req: Request, { json: needsJson = true }: { json?: boolean } = {}): Response | null {
  const reason = crossSiteRefusal(req.headers);
  if (reason) return refuse(403, reason);
  if (needsJson && !req.headers.get("content-type")?.toLowerCase().includes("application/json")) return refuse(415, "Expected JSON");
  return null;
}

/** 256 KB: more than any form here sends, and a cap on what a caller can make the server parse. */
const MAX_BODY = 262_144;

/** The JSON body, or why it cannot be read. Over `maxBytes` is refused before parsing. */
export async function readJsonBody(req: Request, maxBytes = MAX_BODY): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const text = await req.text().catch(() => null);
  if (text === null) return { ok: false, status: 400, error: "The request body could not be read" };
  if (text.length > maxBytes) return { ok: false, status: 413, error: "That request is too large" };
  if (!text) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, error: "The request body is not JSON" };
  }
}

/** A JSON object body, or an empty object for anything else; the route's own checks refuse it. */
export async function readJsonObject(req: Request, maxBytes = MAX_BODY): Promise<Record<string, unknown>> {
  const r = await readJsonBody(req, maxBytes);
  return r.ok && r.value && typeof r.value === "object" && !Array.isArray(r.value) ? (r.value as Record<string, unknown>) : {};
}

/** The API's own 4xx passes through to the browser; anything else, including no answer (0), reads as 502. */
export const upstreamStatus = (status: number) => (status >= 400 && status < 500 ? status : 502);
