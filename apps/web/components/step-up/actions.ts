"use server";

import { apiRequest } from "@/lib/api";
import { previewElevate } from "@/lib/preview-step-up";
import { STEP_UP_MINUTES } from "@/lib/step-up";
import { isPreviewMode } from "@/lib/preview-mode";

// A server action is a public endpoint, so the input is checked for shape here and only the checked
// field is forwarded. Nothing here logs, so a password or code never reaches the server output.

export type StepUpMethod = "code" | "password";

export type StepUpAnswer =
  | { ok: true; expiresAt: string }
  | {
      ok: false;
      error: string;
      field?: StepUpMethod;
      /** Seconds to wait after too many tries. */
      retryAfter?: number;
      /** The API asked for the other credential: the account's two-factor changed since the page loaded. */
      method?: StepUpMethod;
      /** The session itself is over: the page sends the visitor to sign in again. */
      expired?: true;
    };

const CODE = /^\d{6}$/;

const windowEnd = () => new Date(Date.now() + STEP_UP_MINUTES * 60_000).toISOString();

/** Null when the API cannot say; the dialog then takes either. */
export async function stepUpMethod(): Promise<StepUpMethod | null> {
  if (process.env.DOCKIFY_API_URL !== undefined) {
    const r = await apiRequest<{ twoFactor?: { enabled?: unknown } }>("/api/v1/me");
    const on = r.ok ? r.data?.twoFactor?.enabled : undefined;
    return typeof on === "boolean" ? (on ? "code" : "password") : null;
  }
  // The preview's account has two-factor off.
  return isPreviewMode() ? "password" : null;
}

export async function confirmStepUp(input: { code?: string; password?: string }): Promise<StepUpAnswer> {
  const raw: Record<string, unknown> = input && typeof input === "object" ? input : {};
  let body: { code: string } | { password: string };
  if (raw.code !== undefined) {
    if (typeof raw.code !== "string" || !CODE.test(raw.code)) return { ok: false, field: "code", error: "Enter all 6 digits" };
    body = { code: raw.code };
  } else if (typeof raw.password === "string" && raw.password.length > 0 && raw.password.length <= 256) {
    body = { password: raw.password };
  } else {
    return { ok: false, field: "password", error: "Enter your password" };
  }

  if (process.env.DOCKIFY_API_URL !== undefined) {
    const r = await apiRequest<{ expiresAt?: unknown }>("/api/v1/auth/step-up", { method: "POST", body, timeoutMs: 15_000 });
    if (r.ok) return { ok: true, expiresAt: typeof r.data?.expiresAt === "string" ? r.data.expiresAt : windowEnd() };
    if (r.status === 429) {
      const after = Number(r.body?.retryAfter ?? r.headers?.get("retry-after"));
      return { ok: false, error: "Too many tries. Wait a moment, then try again", retryAfter: Number.isFinite(after) && after > 0 ? Math.round(after) : 60 };
    }
    if (r.code === "INVALID_CREDENTIALS") {
      return "code" in body
        ? { ok: false, field: "code", error: "That code did not match, try the current one" }
        : { ok: false, field: "password", error: "That password is not right" };
    }
    if (r.code === "CODE_REQUIRED") return { ok: false, field: "code", method: "code", error: "Two-factor is on for this account. Enter the code from your authenticator app" };
    if (r.code === "PASSWORD_REQUIRED") return { ok: false, field: "password", method: "password", error: "Enter your password" };
    if (r.status === 401) return { ok: false, expired: true, error: "Your session ended. Sign in again" };
    return { ok: false, error: r.error };
  }
  // The preview checks nothing: any password, or any 6 digits, opens its window (lib/preview-step-up.ts).
  if (isPreviewMode()) return { ok: true, expiresAt: previewElevate() };
  return { ok: false, error: "No data source, set DOCKIFY_API_URL for this dashboard" };
}
