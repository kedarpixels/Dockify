import type { Metadata } from "next";
import { OverviewView } from "@/components/overview/overview-view";
import { getOverview } from "@/lib/data";

export const metadata: Metadata = { title: "Overview" };

/* In the (home) route group so its loading.tsx is its own, not the fallback of every console page without one. */
export default async function OverviewPage() {
  return <OverviewView initial={await getOverview()} />;
}
