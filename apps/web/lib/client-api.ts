import { isRecord } from "@/lib/validation";
import { apiErrorMessage } from "./http-status";
import { apiFetch } from "./hooks";

// Goes through `apiFetch`, so a 401 ends the session the same way everywhere. Never throws: a
// dropped connection comes back as an answer too.

export const OFFLINE = "Could not reach the dashboard. Check your connection";

export type Answer<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      /** 0 when nothing answered (offline, or the call was aborted). */
      status: number;
      error: string;
      /** The route's machine code, such as step_up_required (lib/step-up.ts). */
      code?: string;
      /** The parsed error body, for fields a caller reads. */
      body?: Record<string, unknown>;
      aborted?: boolean;
    };

export interface CallInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Sent as JSON. */
  body?: unknown;
  signal?: AbortSignal;
}

const record = (v: unknown): Record<string, unknown> | undefined => (isRecord(v) ? v : undefined);

/** One same-origin JSON call. A success carries the parsed body (null when there is none). */
export async function callJson<T>(url: string, init: CallInit = {}): Promise<Answer<T>> {
  const hasBody = init.body !== undefined;
  let res: Response;
  try {
    res = await apiFetch(url, {
      method: init.method ?? (hasBody ? "POST" : "GET"),
      cache: "no-store",
      headers: { accept: "application/json", ...(hasBody ? { "content-type": "application/json" } : {}) },
      body: hasBody ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch {
    return { ok: false, status: 0, error: OFFLINE, aborted: init.signal?.aborted || undefined };
  }
  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = undefined;
  }
  const body = record(parsed);
  if (!res.ok) {
    const said = typeof body?.error === "string" && body.error.trim() ? body.error.trim() : apiErrorMessage(res.status);
    return { ok: false, status: res.status, error: said, code: typeof body?.code === "string" ? body.code : undefined, body };
  }
  if (parsed === undefined) return { ok: false, status: res.status, error: "This dashboard sent something it cannot read" };
  return { ok: true, status: res.status, data: parsed as T };
}
