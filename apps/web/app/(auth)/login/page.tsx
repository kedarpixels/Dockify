import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginView, type LoginReason } from "@/components/auth/login-view";
import { safeNext } from "@/components/auth/util";
import { getSetupStatus } from "@/lib/pages/auth-loaders";

export const metadata: Metadata = { title: "Sign in" };

/*
 * /login. A fresh server with no users goes to /setup first. `?reason=` explains how the visitor
 * got here: "expired" when the console bounced an ended session, "signed-out" after Sign out.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; reason?: string | string[] }>;
}) {
  const [{ next, reason }, status] = await Promise.all([searchParams, getSetupStatus()]);
  if (status.source === "api" && status.data?.needsSetup) redirect("/setup");

  const notice =
    status.source === "none"
      ? "The Dockify API is not configured on this server, so sign in cannot work yet."
      : status.error
        ? "Cannot reach the Dockify API right now. Sign in works again once it is back."
        : undefined;

  const r = Array.isArray(reason) ? reason[0] : reason;
  const why: LoginReason | undefined = r === "expired" || r === "signed-out" ? r : undefined;

  return <LoginView instanceName={status.data?.instanceName} next={safeNext(next)} notice={notice} reason={why} emailEnabled={status.data?.emailEnabled === true} />;
}
