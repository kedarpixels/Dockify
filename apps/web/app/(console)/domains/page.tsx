import type { Metadata } from "next";
import { DomainsView } from "@/components/resources-domains/domains-view";
import { getOverview } from "@/lib/data";
import { getDomains } from "@/lib/pages/resources-domains";

export const metadata: Metadata = { title: "Domains" };

export default async function DomainsPage() {
  const [overview, domains] = await Promise.all([getOverview(), getDomains()]);
  return <DomainsView overview={overview} initial={domains} />;
}
