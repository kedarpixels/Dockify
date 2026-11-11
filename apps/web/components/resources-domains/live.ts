import type { DomainRow, ResourceRow } from "@/lib/pages/resources-domains";
import type { Resource } from "@/lib/types";

/** How often each page reads its list again while its tab is visible. */
export const RESOURCES_POLL_MS = 15_000;
export const DOMAINS_POLL_MS = 8_000;

/** The resources list itself does not say where an app runs or its status now; the polled overview does. */
export function liveResources(rows: ResourceRow[], seen: Resource[] | undefined): ResourceRow[] {
  const live = new Map(seen?.map((r) => [r.id, r]) ?? []);
  return rows.map((r) => {
    const now = live.get(r.id);
    return now ? { ...r, status: now.status, ...(now.onVercel ? { onVercel: true as const } : {}) } : r;
  });
}

/** Rows with a container here. An app on Vercel has none, so it reserves and uses nothing on this server. */
export const onServer = (rows: ResourceRow[]): ResourceRow[] => rows.filter((r) => !r.onVercel);

/** True while the server is still settling it by itself. One waiting for the owner to create a record is not: only a recheck moves that. */
export const domainSettling = (d: Pick<DomainRow, "tls" | "dns" | "test">): boolean =>
  d.dns.status === "unchecked" || (d.tls.status === "pending" && (d.dns.status === "ok" || d.test === true));
