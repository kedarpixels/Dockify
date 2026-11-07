import type { Metadata } from "next";
import { AlertsView } from "@/components/alerts/alerts-view";
import { getOverview } from "@/lib/data";
import { getAlerts } from "@/lib/pages/alerts";

export const metadata: Metadata = { title: "Alerts" };

export default async function AlertsPage() {
  const [overview, alerts] = await Promise.all([getOverview(), getAlerts()]);
  return <AlertsView overview={overview} initial={alerts} />;
}
