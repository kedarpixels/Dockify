import "server-only";
import { isRecord } from "@/lib/validation";
import { apiErrorMessage } from "./http-status";
import { STEP_UP_MESSAGE, STEP_UP_REQUIRED } from "./step-up";
import { upstreamHeaders } from "./upstream";

/*
 * Every call this server makes to the Dockify API goes through here: one URL rule, the visitor's
 * forwarded headers (lib/upstream.ts), no cache, a timeout on every call, and one way to read the
 * answer. A hung API therefore ends a render, a route or an action with a clear line instead of
 * holding it open, and an elevated route's step_up_required always comes back as the shared
 * refusal (lib/step-up.ts), never as raw text.
 */

/** A read gives up after 10 seconds, as the overview always did. */
const READ_TIMEOUT_MS = 10_000;
/** A write may do more work before it answers. */
const WRITE_TIMEOUT_MS = 30_000;

/** Why a call failed before the API answered, worded for the page that shows it. */
const UNREACHABLE = "The API did not answer";
const TIMED_OUT = "The API took too long to answer";
export const UNREADABLE = "The API sent something this dashboard cannot read";
const NO_API = "No data source, set DOCKIFY_API_URL for this dashboard";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiInit {
  method?: Method;
  /** Sent as JSON. */
  body?: unknown;
  /** Query parameters; empty values are left out. */
  query?: Record<string, string | null | undefined>;
  headers?: Record<string, string>;
  /** Defaults to READ_TIMEOUT_MS for GET and WRITE_TIMEOUT_MS for writes. */
  timeoutMs?: number;
  /** Forward the visitor's session cookie. Off for public reads. Default on. */
  cookie?: boolean;
  /**
   * A cached public read (the status page) instead of no-store. It forwards nothing of the
   * visitor (no cookie, no address), so every visitor shares one cached answer.
   */
  revalidate?: { seconds: number; tags: string[] };
  /** The browser's request: when the visitor leaves, the API call is cut too, so its work stops. */
  signal?: AbortSignal;
}

export interface ApiFailure {
  ok: false;
  /** The API's HTTP status, or 0 when it never answered. */
  status: number;
  /** One short line for the UI: the API's own message, else a line for the status. */
  error: string;
  /** The API's machine code (SLUG_TAKEN, ENV_CONFLICT), STEP_UP_REQUIRED, "timeout" or "unreachable". */
  code?: string;
  /** The parsed error body, for fields a caller reads (field, retryAfter, keys, refusals). */
  body?: Record<string, unknown>;
  headers?: Headers;
}

export interface ApiSuccess<T> {
  ok: true;
  status: number;
  data: T;
  headers: Headers;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

const isTimeout = (e: unknown) => e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
const record = (v: unknown): Record<string, unknown> | undefined => (isRecord(v) ? v : undefined);

/** Builds the API URL for `path`, or the reason it cannot. */
function urlFor(path: string, query?: ApiInit["query"]): URL | ApiFailure {
  const base = process.env.DOCKIFY_API_URL;
  if (base === undefined) return { ok: false, status: 503, error: NO_API, code: "no_api" };
  let url: URL;
  try {
    url = new URL(path, base);
  } catch {
    return { ok: false, status: 0, error: "DOCKIFY_API_URL is not a valid URL", code: "unreachable" };
  }
  for (const [k, v] of Object.entries(query ?? {})) if (v) url.searchParams.set(k, v);
  return url;
}

/**
 * The failure for a non-2xx answer. A step-up refusal becomes the shared refusal, and the raw
 * "step_up_required" text never survives as a message.
 */
function failureOf(status: number, raw: unknown, headers?: Headers): ApiFailure {
  const body = record(raw);
  const said = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "";
  const code = typeof body?.code === "string" ? body.code : undefined;
  if (status === 403 && (said === STEP_UP_REQUIRED || code === "STEP_UP_REQUIRED")) {
    return { ok: false, status, error: STEP_UP_MESSAGE, code: STEP_UP_REQUIRED, body, headers };
  }
  return { ok: false, status, error: said.trim() && said !== STEP_UP_REQUIRED ? said.trim() : apiErrorMessage(status), code, body, headers };
}

/** Failures made here, not by the API: their own line is the one to show. */
const LOCAL = new Set(["timeout", "unreachable", "unreadable", "no_api", STEP_UP_REQUIRED]);

/**
 * The generic line for a failure, for reads that never show the API's own wording: the reason when
 * the API never answered, sent something unreadable or wants a step-up, else the status line.
 */
export const plainError = (f: ApiFailure) => (f.code && LOCAL.has(f.code) ? f.error : apiErrorMessage(f.status));

/** One JSON call to the Dockify API. Never throws. A 204 or an empty 2xx body is `data: null`. */
export async function apiRequest<T>(path: string, init: ApiInit = {}): Promise<ApiResult<T>> {
  const url = urlFor(path, init.query);
  if (!(url instanceof URL)) return url;
  const method = init.method ?? "GET";
  const hasBody = init.body !== undefined;
  let res: Response;
  let text: string;
  try {
    const fwd = init.revalidate ? {} : await upstreamHeaders({}, { cookie: init.cookie !== false });
    res = await fetch(url, {
      method,
      ...(init.revalidate ? { next: { revalidate: init.revalidate.seconds, tags: init.revalidate.tags } } : { cache: "no-store" as const }),
      // A redirect is never a JSON answer: it reads as a failure instead of being followed elsewhere.
      redirect: "manual",
      headers: { ...fwd, accept: "application/json", ...(hasBody ? { "content-type": "application/json" } : {}), ...init.headers },
      body: hasBody ? JSON.stringify(init.body) : undefined,
      signal: (() => {
        const timeout = AbortSignal.timeout(init.timeoutMs ?? (method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS));
        return init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      })(),
    });
    text = await res.text();
  } catch (e) {
    return isTimeout(e) ? { ok: false, status: 0, error: TIMED_OUT, code: "timeout" } : { ok: false, status: 0, error: UNREACHABLE, code: "unreachable" };
  }
  let body: unknown = null;
  let readable = true;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      readable = false;
    }
  }
  if (!res.ok) return failureOf(res.status, body, res.headers);
  if (!readable) return { ok: false, status: 502, error: UNREADABLE, code: "unreadable", headers: res.headers };
  return { ok: true, status: res.status, data: body as T, headers: res.headers };
}

/**
 * A call whose answer is streamed on (a log tail, a backup file, an icon). The timeout covers only
 * the wait for the response head, so a long stream is never cut; `signal` (the browser's request)
 * still ends it when the visitor leaves. A non-2xx answer is read and returned as a failure.
 */
export async function apiStream(path: string, init: ApiInit & { accept: string }): Promise<{ ok: true; res: Response } | ApiFailure> {
  const url = urlFor(path, init.query);
  if (!(url instanceof URL)) return url;
  const head = new AbortController();
  const timer = setTimeout(() => head.abort(new DOMException("The API took too long to answer", "TimeoutError")), init.timeoutMs ?? READ_TIMEOUT_MS);
  try {
    const fwd = await upstreamHeaders({}, { cookie: init.cookie !== false });
    const res = await fetch(url, {
      method: init.method ?? "GET",
      cache: "no-store",
      redirect: "manual",
      headers: { ...fwd, accept: init.accept, ...init.headers },
      signal: init.signal ? AbortSignal.any([init.signal, head.signal]) : head.signal,
    });
    if (res.ok && res.body) return { ok: true, res };
    const raw = await res.text().catch(() => "");
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    return failureOf(res.ok ? 502 : res.status, body, res.headers);
  } catch (e) {
    return isTimeout(e) ? { ok: false, status: 0, error: TIMED_OUT, code: "timeout" } : { ok: false, status: 0, error: UNREACHABLE, code: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
