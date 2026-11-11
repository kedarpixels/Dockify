"use server";

// Server actions for the sign-in pages. Passwords pass straight through to the API and are never
// logged, stored or echoed back; every Set-Cookie the API answers with is forwarded unchanged.

import { cookies } from "next/headers";
import type { ApiFailure } from "@/lib/api";
import { parseSetCookie, SESSION_COOKIES } from "@/lib/forwarded";
import { newPasswordProblem } from "@/lib/password";
import { STEP_UP_REQUIRED } from "@/lib/step-up";
import type { OverviewSource } from "@/lib/types";
import { isPreviewMode } from "@/lib/preview-mode";
import { previewElevate } from "@/lib/preview-step-up";
import { authCall as call, PREVIEW_RESET, RESET_TOKEN, UNREACHABLE } from "./auth-api";

export type AuthField = "email" | "password" | "code" | "name" | "instanceName";

export interface AuthFailure {
  ok: false;
  error: string;
  field?: AuthField;
  retryAfter?: number;
  /** step_up_required (lib/step-up.ts) when the call needs a fresh step-up. */
  code?: string;
}

export type AuthResult<T extends object = object> = ({ ok: true } & T) | AuthFailure;

export interface SetupStatus {
  needsSetup: boolean;
  instanceName?: string;
  /** Email is connected: Forgot password and email codes work. */
  emailEnabled: boolean;
}

export interface ResetPreview {
  /** The account, masked ("s***@example.com"). */
  email: string;
  expiresAt: string;
}

export interface ResetResult {
  source: OverviewSource;
  data: ResetPreview | null;
  reason?: "invalid" | "expired" | "used" | "unreachable";
}

export interface SetupStatusResult {
  source: OverviewSource;
  data: SetupStatus | null;
  error?: string;
}

export interface Invite {
  email: string;
  role: string;
  invitedBy: string;
  instanceName: string;
  expiresAt: string;
}

export interface InviteResult {
  source: OverviewSource;
  data: Invite | null;
  /** Why there is no invite: unknown token, expired, already used, or no API to ask. */
  reason?: "invalid" | "expired" | "used" | "unreachable";
}

export interface TotpSecret {
  /** Base32 secret for manual entry. */
  secret: string;
  /** otpauth:// link, opens the authenticator app on phones. */
  uri: string;
  /** A real QR image when the API renders one. */
  qrDataUrl?: string | null;
  /** Preview only: the UI may draw its stand-in grid, which is not scannable. */
  preview?: boolean;
}

const PREVIEW_PASSWORD = "dockify";
const PREVIEW_CODE = "123456";

const NO_API: AuthFailure = { ok: false, error: "The Dockify API is not configured on this server" };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELDS: readonly string[] = ["email", "password", "code", "name", "instanceName"];


/** Copies each Set-Cookie from the API onto the browser response (session, pending 2FA). */
async function forwardCookies(headers: Headers | undefined) {
  const lines = headers?.getSetCookie() ?? [];
  if (!lines.length) return;
  const jar = await cookies();
  for (const line of lines) {
    const c = parseSetCookie(line);
    if (c) jar.set(c.name, c.value, c.opts);
  }
}

/** What a wrong authenticator code says, whatever the API worded it as. */
const CODE_MISS = "That code did not match, try the current one";

/** Turns a failed call into an AuthFailure, with retryAfter on 429. `miss` replaces the API's words for a rejected code (401). */
function failure(r: ApiFailure, fallback: string, on401?: AuthField, miss?: string): AuthFailure {
  if (r.status === 0) return { ok: false, error: r.code === "timeout" ? "The Dockify API took too long to answer, try again in a moment" : UNREACHABLE };
  if (r.status === 401 && miss) return { ok: false, error: miss, field: on401 };
  if (r.status === 429) {
    const header = Number(r.headers?.get("retry-after"));
    const sent = typeof r.body?.retryAfter === "number" ? r.body.retryAfter : undefined;
    const retryAfter = Math.max(1, Math.round(sent ?? (Number.isFinite(header) && header > 0 ? header : 60)));
    return { ok: false, error: "Too many attempts", retryAfter };
  }
  // A rejected credential belongs under its field; anything else is a message for the whole form.
  const said = typeof r.body?.error === "string" || typeof r.body?.message === "string" || r.code === STEP_UP_REQUIRED;
  const field = typeof r.body?.field === "string" && FIELDS.includes(r.body.field) ? (r.body.field as AuthField) : r.status === 401 ? on401 : undefined;
  return { ok: false, error: said ? r.error : fallback, field, code: r.code };
}

/** Forwards the API's cookies on failures too, so a cleared pending 2FA cookie reaches the browser. Only `result` may go back to the browser. */
async function send<T extends object>(path: string, body: unknown, fallback: string, on401?: AuthField, miss?: string): Promise<{ result: AuthResult<Partial<T>>; headers?: Headers }> {
  const r = await call<Partial<T>>(path, "POST", body);
  await forwardCookies(r.headers);
  return { result: r.ok ? { ok: true, ...(r.data ?? {}) } : failure(r, fallback, on401, miss), headers: r.headers };
}

const post = async <T extends object>(path: string, body: unknown, fallback: string, on401?: AuthField, miss?: string) => (await send<T>(path, body, fallback, on401, miss)).result;

/** Opens a step-up window on the session the API just started, because the authenticator step that follows calls elevated routes. Best effort. */
async function stepUpNewSession(headers: Headers | undefined, password: string) {
  const names: readonly string[] = process.env.DOCKIFY_SESSION_COOKIE ? [process.env.DOCKIFY_SESSION_COOKIE] : SESSION_COOKIES;
  // The raw name=value pair, exactly as the API set it.
  const pair = (headers?.getSetCookie() ?? []).map((line) => line.split(";")[0]?.trim() ?? "").find((p) => names.includes(p.slice(0, p.indexOf("="))) && p.indexOf("=") < p.length - 1);
  if (pair) await call("/api/v1/auth/step-up", "POST", { password }, pair);
}

/* Shared input checks, so obvious mistakes never cost an API round trip or a rate-limit slot. */
function checkEmail(email: string): AuthFailure | null {
  if (!email.trim()) return { ok: false, field: "email", error: "Enter your email" };
  if (!EMAIL.test(email.trim())) return { ok: false, field: "email", error: "Enter a valid email address" };
  return null;
}

function checkNewPassword(password: string): AuthFailure | null {
  const problem = newPasswordProblem(password);
  return problem ? { ok: false, field: "password", error: problem } : null;
}

/* A random base32 secret, for the preview only. */
function randomFrom(alphabet: string, n: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** The answer never says whether the address has an account, so the page shows one message either way. */
export async function requestPasswordReset(input: { email: string }): Promise<AuthResult> {
  const email = input.email.trim();
  const bad = checkEmail(email);
  if (bad) return bad;

  if (isPreviewMode()) {
    if (email.includes("limit")) return { ok: false, error: "Too many attempts", retryAfter: 120 };
    return { ok: true };
  }
  if (!process.env.DOCKIFY_API_URL) return NO_API;
  return post("/api/v1/auth/forgot", { email }, "Could not send the reset link, try again in a moment");
}

/** Sets a new password from an emailed link. Signs nobody in: the visitor signs in next. */
export async function resetPassword(input: { token: string; password: string }): Promise<AuthResult> {
  if (!RESET_TOKEN.test(input.token)) return { ok: false, error: "This reset link is not valid" };
  const bad = checkNewPassword(input.password);
  if (bad) return bad;

  if (isPreviewMode()) {
    if (input.token === PREVIEW_RESET.expired) return { ok: false, error: "This reset link has expired" };
    if (input.token === PREVIEW_RESET.used) return { ok: false, error: "This reset link was already used" };
    return { ok: true };
  }
  if (!process.env.DOCKIFY_API_URL) return NO_API;
  return post(`/api/v1/auth/reset/${encodeURIComponent(input.token)}`, { password: input.password }, "Could not reset the password");
}

/** Sends a 6-digit code to the signed-in user's own address (the optional setup step). */
export async function sendVerifyCode(): Promise<AuthResult<{ email: string }>> {
  if (isPreviewMode()) return { ok: true, email: "admin@example.com" };
  if (!process.env.DOCKIFY_API_URL) return NO_API;
  const r = await post<{ email: string }>("/api/v1/me/email/code", {}, "Could not send the code");
  if (!r.ok) return r;
  return { ok: true, email: r.email ?? "" };
}

export async function confirmVerifyCode(input: { code: string }): Promise<AuthResult> {
  const code = input.code.replace(/\D/g, "");
  if (code.length !== 6) return { ok: false, field: "code", error: "Enter all 6 digits" };
  if (isPreviewMode()) return code === PREVIEW_CODE ? { ok: true } : { ok: false, field: "code", error: "That code did not match. In the preview, use 123456" };
  if (!process.env.DOCKIFY_API_URL) return NO_API;
  return post("/api/v1/me/email/confirm", { code }, "That code did not match", "code", "That code did not match");
}

/** Step one of sign in. Answers whether a second factor is needed. */
export async function signIn(input: { email: string; password: string }): Promise<AuthResult<{ next: "verify" | "done" }>> {
  const email = input.email.trim();
  const bad = checkEmail(email);
  if (bad) return bad;
  if (!input.password) return { ok: false, field: "password", error: "Enter your password" };

  if (isPreviewMode()) {
    if (email.includes("limit")) return { ok: false, error: "Too many attempts", retryAfter: 120 };
    if (input.password !== PREVIEW_PASSWORD) return { ok: false, field: "password", error: "Email or password is incorrect" };
    return { ok: true, next: email.includes("2fa") ? "verify" : "done" };
  }
  if (!process.env.DOCKIFY_API_URL) return NO_API;

  const r = await post<{ next: "verify" | "done" }>("/api/v1/auth/login", { email, password: input.password }, "Email or password is incorrect", "password");
  if (!r.ok) return r;
  return { ok: true, next: r.next === "verify" ? "verify" : "done" };
}

/** Step two: the 6-digit code from the authenticator app. There is no other second factor. */
export async function verifySecondFactor(input: { code: string; remember?: boolean }): Promise<AuthResult> {
  const code = input.code.replace(/\D/g, "");
  if (code.length !== 6) return { ok: false, field: "code", error: "Enter all 6 digits" };

  if (isPreviewMode()) {
    return code === PREVIEW_CODE ? { ok: true } : { ok: false, field: "code", error: `${CODE_MISS}. In the preview, use 123456` };
  }
  if (!process.env.DOCKIFY_API_URL) return NO_API;

  return post("/api/v1/auth/verify", { code, remember: Boolean(input.remember) }, CODE_MISS, "code", CODE_MISS);
}

export async function createAdmin(input: { instanceName: string; name: string; email: string; password: string; setupToken: string }): Promise<AuthResult> {
  if (!input.instanceName.trim()) return { ok: false, field: "instanceName", error: "Name this instance" };
  if (!input.name.trim()) return { ok: false, field: "name", error: "Enter your name" };
  if (!input.setupToken.trim()) return { ok: false, error: "Paste the setup token the installer printed" };
  const bad = checkEmail(input.email) ?? checkNewPassword(input.password);
  if (bad) return bad;

  if (isPreviewMode()) {
    // As stepUpNewSession does on the API, so the preview's next steps ask for nothing either.
    previewElevate();
    return { ok: true };
  }
  if (!process.env.DOCKIFY_API_URL) return NO_API;
  const r = await send(
    "/api/v1/auth/setup",
    { instanceName: input.instanceName.trim(), name: input.name.trim(), email: input.email.trim(), password: input.password, setupToken: input.setupToken.trim() },
    "Could not create the admin account",
  );
  if (r.result.ok) await stepUpNewSession(r.headers, input.password);
  return r.result;
}

export async function acceptInvite(input: { token: string; name: string; password: string }): Promise<AuthResult> {
  if (!input.name.trim()) return { ok: false, field: "name", error: "Enter your name" };
  const bad = checkNewPassword(input.password);
  if (bad) return bad;

  if (isPreviewMode()) return input.token === "expired" ? { ok: false, error: "This invite has expired" } : { ok: true };
  if (!process.env.DOCKIFY_API_URL) return NO_API;
  const r = await send(`/api/v1/auth/invite/${encodeURIComponent(input.token)}`, { name: input.name.trim(), password: input.password }, "Could not accept this invite");
  if (r.result.ok) await stepUpNewSession(r.headers, input.password);
  return r.result;
}

export async function startTotp(): Promise<AuthResult<TotpSecret>> {
  if (isPreviewMode()) {
    const secret = randomFrom("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 32);
    return { ok: true, preview: true, secret, uri: `otpauth://totp/Dockify:admin?secret=${secret}&issuer=Dockify&digits=6&period=30` };
  }
  if (!process.env.DOCKIFY_API_URL) return NO_API;
  const r = await post<{ secret: string; otpauthUrl: string; qrDataUrl: string | null }>("/api/v1/me/2fa/setup", {}, "Could not start authenticator setup");
  if (!r.ok) return r;
  if (!r.secret || !r.otpauthUrl) return { ok: false, error: "Could not get a setup key from the API" };
  return { ok: true, secret: r.secret, uri: r.otpauthUrl, qrDataUrl: r.qrDataUrl ?? null };
}

export async function enableTotp(input: { code: string }): Promise<AuthResult> {
  const code = input.code.replace(/\D/g, "");
  if (code.length !== 6) return { ok: false, field: "code", error: "Enter all 6 digits" };

  if (isPreviewMode()) {
    return code === PREVIEW_CODE ? { ok: true } : { ok: false, field: "code", error: `${CODE_MISS}. In the preview, use 123456` };
  }
  if (!process.env.DOCKIFY_API_URL) return NO_API;
  const r = await post("/api/v1/me/2fa/verify", { code }, CODE_MISS, "code", CODE_MISS);
  return r.ok ? { ok: true } : r;
}

/** The session cookie is also dropped here, so a browser is never left holding it. A refusal is reported, never swallowed. */
export async function signOut(): Promise<AuthResult> {
  if (isPreviewMode()) return { ok: true };
  const r = await call("/api/v1/auth/logout", "POST", {});
  await forwardCookies(r.headers);
  if (!r.ok) return failure(r, "Sign out failed, try again");
  const jar = await cookies();
  for (const name of SESSION_COOKIES) {
    // __Host- cookies only clear with Secure and Path=/, the attributes the API set them with.
    if (jar.get(name)?.value) jar.set(name, "", { maxAge: 0, path: "/", httpOnly: true, sameSite: "strict", secure: name.startsWith("__Host-") });
  }
  return { ok: true };
}
