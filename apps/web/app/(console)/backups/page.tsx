import type { Metadata } from "next";
import { BackupsView } from "@/components/server-backups/backups-view";
import { getOverview } from "@/lib/data";
import { getBackups } from "@/lib/pages/server-backups";

export const metadata: Metadata = { title: "Backups" };

export default async function BackupsPage() {
  const [overview, backups] = await Promise.all([getOverview(), getBackups()]);
  return <BackupsView overview={overview} initial={backups} />;
}
