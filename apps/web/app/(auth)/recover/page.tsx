import type { Metadata } from "next";
import { RecoverView } from "@/components/auth/recover-view";
import { getSetupStatus } from "@/lib/pages/auth-loaders";

export const metadata: Metadata = { title: "Recover access" };

export default async function RecoverPage() {
  const status = await getSetupStatus();
  return <RecoverView emailEnabled={status.data?.emailEnabled === true} />;
}
