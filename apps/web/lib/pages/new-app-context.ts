import type { IntegrationsConnected, IntegrationsSummary } from "./integrations";
import type { NewAppContext } from "./new-app";

/** Only what the flow needs from the summary: registry names and the Vercel account. */
export function toContext(summary: Pick<IntegrationsSummary, "registries" | "vercel"> | IntegrationsConnected | null | undefined): NewAppContext {
  // A Viewer's small answer says what is connected, in booleans, and names nothing to pick from.
  const s = summary && !("limited" in summary) ? summary : null;
  return {
    registries: (s?.registries ?? []).map((r) => ({ id: r.id, host: r.host, username: r.username, error: r.error })),
    vercel: s?.vercel ? { account: s.vercel.account.username, team: s.vercel.team?.name ?? null } : null,
  };
}
