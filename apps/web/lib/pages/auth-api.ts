import "server-only";
import { apiRequest, type ApiResult } from "@/lib/api";

// Shared by auth-loaders.ts and auth.ts. Kept out of the "use server" module, which may export async functions only.

/** Sign in, verify and the rest wait at most 15 seconds for the API, then say so. */
const AUTH_TIMEOUT_MS = 15_000;
export const UNREACHABLE = "Cannot reach the Dockify API, try again in a moment";

export const RESET_TOKEN = /^[A-Za-z0-9_-]{20,200}$/;
/** Design preview: these two reset tokens show the expired and the used state. */
export const PREVIEW_RESET = { expired: "expired-token-preview-0000", used: "used-token-preview-00000" };

/** `cookie` replaces the visitor's cookies, for the one call made on behalf of a session the API has just started (stepUpNewSession in auth.ts). */
export function authCall<T>(path: string, method: "GET" | "POST", body?: unknown, cookie?: string): Promise<ApiResult<T>> {
  return apiRequest<T>(path, { method, body, timeoutMs: AUTH_TIMEOUT_MS, headers: cookie ? { cookie } : undefined });
}
