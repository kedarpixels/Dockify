import type { Metadata } from "next";
import { LogsView } from "@/components/logs/logs-view";
import { filtersFrom, queryOf } from "@/components/logs/model";
import { getOverview } from "@/lib/data";
import { getLogs } from "@/lib/pages/logs";

export const metadata: Metadata = { title: "Logs" };

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function LogsPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const filters = filtersFrom((k) => {
    const v = sp[k];
    return typeof v === "string" ? v : undefined;
  });
  // A server component renders once per request, so the relative window starts at this request.
  // eslint-disable-next-line react-hooks/purity -- not a client render: nothing re-renders here, and the window must be anchored on the clock.
  const asked = queryOf(filters, Date.now());
  // A pattern that cannot run never reaches the API; the view says why in the log box.
  const [initial, overview] = await Promise.all([asked ? getLogs(asked) : null, getOverview()]);
  return <LogsView initial={initial} overview={overview} filters={filters} />;
}
