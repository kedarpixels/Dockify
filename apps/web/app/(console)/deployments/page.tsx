import type { Metadata } from "next";
import { DeploymentsView } from "@/components/deployments/deployments-view";
import { getOverview } from "@/lib/data";
import { getDeployments, isFilter } from "@/lib/pages/deployments";

export const metadata: Metadata = { title: "Deployments" };

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function DeploymentsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const one = (k: string) => {
    const v = sp[k];
    return typeof v === "string" ? v : undefined;
  };
  const status = one("status");
  const query = { status: isFilter(status) ? status : "all", project: one("project"), q: one("q") } as const;
  const [initial, overview] = await Promise.all([getDeployments(query), getOverview()]);
  return <DeploymentsView initial={initial} overview={overview} query={query} />;
}
