import type { IconName } from "@/components/icon";
import { appTitle, plural } from "@/lib/format";
import type { AlertApp, AlertChannel, AlertMetric, ControlService } from "@/lib/pages/alerts";

/** The glyph for each kind of rule, in rows, the history and the editor. */
export const METRIC_ICON: Record<AlertMetric, IconName> = {
  disk: "layers",
  service: "server",
  down: "activity",
  crashLoop: "refresh",
  memory: "cpu",
};

/** The condition's name in the editor's dropdown; a rule's title adds its threshold (ruleTitle). */
export const METRIC_NAME: Record<AlertMetric, string> = {
  disk: "Disk usage above",
  service: "Control-plane service down",
  down: "App down",
  crashLoop: "Crash loop",
  memory: "Memory above",
};

/** What the editor says under each condition. */
export const METRIC_HINT: Record<AlertMetric, string> = {
  disk: "Percent of the server disk in use.",
  service: "The API, worker, proxy or database of Dockify itself stops answering.",
  down: "The container stops or fails its health check. Pressing Stop does not count.",
  crashLoop: "The container restarts this many times within the window.",
  memory: "Percent of the app’s memory limit in use.",
};

export const SERVICE_NAME: Record<ControlService, string> = {
  any: "Any service",
  api: "API",
  worker: "Worker",
  proxy: "Proxy",
  // Dockify's own database, named as the Server page's service list names it.
  database: "Postgres",
};

/** Email and the bell; each webhook carries its own name and mark (components/.../webhook-mark.tsx). */
export const CHANNEL_NAME: Record<AlertChannel, string> = { email: "Email", bell: "In-app bell" };
export const CHANNEL_ICON: Record<AlertChannel, IconName> = { email: "mail", bell: "bell" };

/** "horseai / Storefront": the app as people read it, its display name when it has one. */
export const appName = (a: AlertApp) => `${a.projectSlug} / ${appTitle(a)}`;

const minutes = (n: number) => plural(n, "minute");

interface RuleLike {
  metric: AlertMetric;
  service: ControlService | null;
  threshold: number | null;
  durationMin: number;
}

/**
 * The rule's title, the editor's condition name plus its threshold, the same in the rule rows and
 * the history: "Disk usage above 85%", "Crash loop", "Worker down".
 */
export function ruleTitle(r: RuleLike): string {
  switch (r.metric) {
    case "disk":
    case "memory":
      return `${METRIC_NAME[r.metric]} ${r.threshold}%`;
    case "crashLoop":
      return "Crash loop";
    case "down":
      return "App down";
    case "service":
      return !r.service || r.service === "any" ? METRIC_NAME.service : `${SERVICE_NAME[r.service]} down`;
  }
}

/** The rule's condition in words: "For 10 minutes", "3 restarts within 10 minutes". */
export function ruleWhen(r: RuleLike): string {
  if (r.metric === "crashLoop") return `${plural(r.threshold ?? 0, "restart")} within ${minutes(r.durationMin)}`;
  return `For ${minutes(r.durationMin)}`;
}
