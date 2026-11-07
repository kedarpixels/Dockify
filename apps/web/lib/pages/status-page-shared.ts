/*
 * The client-safe half of the public status page: its types, the labels, and the figures the page
 * and the uptime bars compute. The loader (lib/pages/status-page.ts) re-exports all of it; client
 * components import from here, so the loader and its preview fixture never reach the browser.
 */

// -------------- Types --------------

export type StatusState = "operational" | "degraded" | "outage";
/** One UTC day of one app: ok, minor (degraded), major (down for part of it), or no data yet. */
export type DayState = "ok" | "minor" | "major" | "none";
export type IncidentImpact = "minor" | "major";
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";

export interface StatusDay {
  /** YYYY-MM-DD, UTC. */
  date: string;
  state: DayState;
  downMinutes: number;
  degradedMinutes: number;
}

export interface StatusComponent {
  /** The display name the project chose. Unique on the page. */
  name: string;
  state: StatusState;
  /** Exactly 90, oldest first. */
  days: StatusDay[];
}

export interface IncidentUpdate {
  at: string;
  status: IncidentStatus;
  body: string;
}

export interface Incident {
  /** Public, opaque and URL safe: the RSS guid and the anchor. Not an internal id. */
  key: string;
  title: string;
  impact: IncidentImpact;
  status: IncidentStatus;
  startedAt: string;
  resolvedAt: string | null;
  /** Display names from `components`. */
  affects: string[];
  /** Newest first. */
  updates: IncidentUpdate[];
}

export interface PublicStatus {
  slug: string;
  name: string;
  /** https URL or a same-origin path; null shows the folder tile. */
  logoUrl: string | null;
  state: StatusState;
  updatedAt: string;
  components: StatusComponent[];
  incidents: Incident[];
}

export type StatusResult =
  | { kind: "ok"; source: "api" | "preview"; data: PublicStatus }
  | { kind: "missing" }
  | { kind: "error"; error: string };

export const DAYS = 90;

/** The overall state as a headline: the page title, its metadata and the RSS feed agree. */
export const STATE_HEADLINE: Record<StatusState, string> = {
  operational: "All systems operational",
  degraded: "Degraded",
  outage: "Outage",
};

/** With nothing listed there is nothing to call operational. */
export const headlineOf = (s: Pick<PublicStatus, "state" | "components">): string => (s.components.length ? STATE_HEADLINE[s.state] : "No apps listed yet");

export const INCIDENT_LABEL: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

/** The worst state across the components: any outage wins, then any degraded. */
export function worst(states: StatusState[]): StatusState {
  if (states.includes("outage")) return "outage";
  return states.includes("degraded") ? "degraded" : "operational";
}

// -------------- Derived figures --------------

/** Share of the minutes with data that were up, 0 to 100, or null with no data at all. */
export function uptimePct(days: StatusDay[], now = Date.now()): number | null {
  const today = new Date(now).toISOString().slice(0, 10);
  const sinceMidnight = Math.max(1, Math.floor((now % 86_400_000) / 60_000));
  let total = 0;
  let down = 0;
  for (const d of days) {
    if (d.state === "none") continue;
    const span = d.date === today ? sinceMidnight : 1440;
    total += span;
    down += Math.min(span, d.downMinutes);
  }
  return total ? ((total - down) / total) * 100 : null;
}

/** "100%", "99.98%": floored to two places, so a day with downtime never prints as 100%. */
export function pctText(p: number | null): string {
  if (p === null) return "No data";
  if (p >= 100) return "100%";
  return `${(Math.floor(p * 100) / 100).toFixed(2)}%`;
}
