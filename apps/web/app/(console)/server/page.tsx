import type { Metadata } from "next";
import { headers } from "next/headers";
import { ServerView } from "@/components/server-backups/server-view";
import { isSslipHost } from "@/lib/dashboard-domain";
import { getOverview } from "@/lib/data";
import { getServer } from "@/lib/pages/server-backups";

export const metadata: Metadata = { title: "Server" };

export default async function ServerPage() {
  const [overview, server] = await Promise.all([getOverview(), getServer()]);
  // The address the visitor came in on: the note is for a dashboard still on its sslip.io name.
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(":")[0] ?? "";
  const preview = server.source === "preview";
  return <ServerView overview={overview} initial={server} temporaryAddress={preview || isSslipHost(host)} />;
}
