import "server-only";
import { connection } from "next/server";
import { buildPreviewOverview } from "@/lib/preview-fixture";
import { isPreviewMode } from "@/lib/preview-mode";
import { apiErrorMessage } from "../http-status";
import { authCall as call, PREVIEW_RESET, RESET_TOKEN, UNREACHABLE } from "./auth-api";
import type { Invite, InviteResult, ResetPreview, ResetResult, SetupStatus, SetupStatusResult } from "./auth";

/*
 * The sign-in pages' loaders: setup status, an invite and a reset link, read on the server for
 * /login, /forgot, /recover, /setup, /invite/[token] and /reset/[token]. Server only, and outside
 * the "use server" module (auth.ts), so none of them is a callable action. The API contract is in
 * auth.ts.
 */

/** GET /api/v1/auth/setup-status: whether the first admin still has to be created. */
export async function getSetupStatus(): Promise<SetupStatusResult> {
  await connection();
  if (process.env.DOCKIFY_API_URL) {
    const r = await call<Partial<SetupStatus>>("/api/v1/auth/setup-status", "GET");
    if (!r.ok) return { source: "api", data: null, error: r.status === 0 ? UNREACHABLE : apiErrorMessage(r.status) };
    const data = r.data;
    return data && typeof data.needsSetup === "boolean"
      ? { source: "api", data: { needsSetup: data.needsSetup, instanceName: data.instanceName, emailEnabled: data.emailEnabled === true } }
      : { source: "api", data: null, error: "The API sent something this page cannot read" };
  }
  // Design preview: setup stays reachable so the flow can be reviewed; the instance is the fixture host.
  if (isPreviewMode()) {
    return { source: "preview", data: { needsSetup: true, instanceName: "Dockify", emailEnabled: true } };
  }
  return { source: "none", data: null };
}

/** GET /api/v1/auth/invite/:token: who is invited, by whom, and until when. */
export async function getInvite(token: string): Promise<InviteResult> {
  await connection();
  if (!/^[A-Za-z0-9_-]{6,200}$/.test(token)) return { source: process.env.DOCKIFY_API_URL ? "api" : "none", data: null, reason: "invalid" };

  if (process.env.DOCKIFY_API_URL) {
    const r = await call<Invite>(`/api/v1/auth/invite/${encodeURIComponent(token)}`, "GET");
    if (!r.ok) {
      if (r.status === 410) return { source: "api", data: null, reason: r.body?.reason === "used" ? "used" : "expired" };
      return { source: "api", data: null, reason: r.status === 0 || r.status >= 500 ? "unreachable" : "invalid" };
    }
    return r.data ? { source: "api", data: r.data } : { source: "api", data: null, reason: "unreachable" };
  }

  // Design preview: invited by the fixture's admin onto the fixture's host.
  if (isPreviewMode()) {
    if (token === "expired") return { source: "preview", data: null, reason: "expired" };
    const o = buildPreviewOverview(new Date());
    return {
      source: "preview",
      data: {
        email: "teammate@example.com",
        role: "Viewer",
        invitedBy: o.viewer?.name ?? "An admin",
        instanceName: "Dockify",
        expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      },
    };
  }
  return { source: "none", data: null, reason: "unreachable" };
}

/** GET /api/v1/auth/reset/:token: whose password the link resets, masked, and until when. */
export async function getReset(token: string): Promise<ResetResult> {
  await connection();
  if (!RESET_TOKEN.test(token)) return { source: process.env.DOCKIFY_API_URL ? "api" : "none", data: null, reason: "invalid" };

  if (process.env.DOCKIFY_API_URL) {
    const r = await call<ResetPreview>(`/api/v1/auth/reset/${encodeURIComponent(token)}`, "GET");
    if (!r.ok) {
      if (r.status === 410) return { source: "api", data: null, reason: r.body?.reason === "used" ? "used" : "expired" };
      return { source: "api", data: null, reason: r.status === 0 || r.status >= 500 ? "unreachable" : "invalid" };
    }
    return r.data && typeof r.data.email === "string" ? { source: "api", data: r.data } : { source: "api", data: null, reason: "unreachable" };
  }

  if (isPreviewMode()) {
    if (token === PREVIEW_RESET.expired) return { source: "preview", data: null, reason: "expired" };
    if (token === PREVIEW_RESET.used) return { source: "preview", data: null, reason: "used" };
    return { source: "preview", data: { email: "a***@example.com", expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() } };
  }
  return { source: "none", data: null, reason: "unreachable" };
}
