import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ForgotView } from "@/components/auth/forgot-view";
import { getSetupStatus } from "@/lib/pages/auth-loaders";

export const metadata: Metadata = { title: "Forgot password" };

/**
 * /forgot: only while email is set up. Without it there is nothing to send, so the visitor lands
 * on /recover (the reset over SSH) instead.
 */
export default async function ForgotPage() {
  const status = await getSetupStatus();
  if (status.data && !status.data.emailEnabled) redirect("/recover");
  if (status.source === "api" && status.data?.needsSetup) redirect("/setup");
  return <ForgotView />;
}
