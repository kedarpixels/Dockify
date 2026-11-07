import "server-only";
import { crossSiteRefusal } from "./same-origin";

/*
 * The route handler kit: one no-store header, one JSON answer, one refusal shape, the write guard
 * and the JSON body reader. Every route under app/api uses these, so the same-origin rule and the
 * error envelope cannot drift between routes again.
 */

/** Every API route answer is private to the visitor and never cached. */
export const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * What a loader hands its route handler: the HTTP status and the JSON body, the error envelope on a
 * refusal. The handler answers it as it is (`json(body, status)`).
 */
export interface RouteAnswer<T> {
  status: number;
  body: T | { error: string; code?: string };
}

/** A JSON answer that is never cached. */
export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

/** The one refusal shape: `{ ok: false, error }`, plus `code` and anything else the client reads. */
export const refuse = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ ok: false, error, ...extra }, status);

/**
 * The guard in front of every write route: same origin only (lib/same-origin.ts), and a JSON
 * content type unless `json` is false (a bodiless DELETE). A cross-site form cannot send JSON, so
 * the content type is a second wall. Returns the refusal to send, or null when the call may pass.
 */
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

/**
 * The status a route answers for a failed API call: the API's own 4xx passes through, so the
 * browser sees 401 (session over), 403 (step-up or no access), 404, 409 and 429 as they are;
 * anything else, including no answer at all (status 0), reads as a bad gateway.
 */
export const upstreamStatus = (status: number) => (status >= 400 && status < 500 ? status : 502);
