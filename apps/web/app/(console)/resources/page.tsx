import type { Metadata } from "next";
import { ResourcesView } from "@/components/resources-domains/resources-view";
import { getOverview } from "@/lib/data";
import { getResources } from "@/lib/pages/resources-domains";

export const metadata: Metadata = { title: "Resources" };

export default async function ResourcesPage() {
  const [overview, resources] = await Promise.all([getOverview(), getResources()]);
  return <ResourcesView overview={overview} initial={resources} />;
}
