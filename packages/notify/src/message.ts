/**
 * One notification, before it is shaped for a provider. Plain JSON on purpose: a queued
 * webhook_send job carries it as it is. Every string here is already redacted by its producer;
 * the formatters still escape each one for their provider's markup.
 */
export type Severity = "critical" | "warning" | "info" | "success";

export interface NotifyField {
  name: string;
  value: string;
}

export interface NotifyMessage {
  /** Stable across retries of one message: the generic webhook's X-Dockify-Delivery. */
  id: string;
  /** One of NOTIFY_EVENTS. */
  event: string;
  severity: Severity;
  title: string;
  /** One paragraph of plain text. */
  text: string;
  /** Where the dashboard shows it, or null. */
  url: string | null;
  fields: NotifyField[];
  /** ISO time the event happened. */
  at: string;
  instance: { name: string; url: string | null };
  /**
   * Structured data for the generic webhook only, merged into the top of its JSON: an alert's
   * { alert, app, service } (the shape earlier versions sent), or an update's { update }.
   */
  data?: Record<string, unknown>;
}

export const NOTIFY_EVENTS = ["alert.firing", "alert.resolved", "update.available", "update.updated", "update.failed", "update.rolled_back", "deploy.failed", "backup.failed", "job.failed", "tls.expiring", "test"] as const;

const SEVERITIES: readonly Severity[] = ["critical", "warning", "info", "success"];
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
/** A link the message shows (never fetched): the dashboard's own origin, https, or http on a local dev box. */
const link = (v: unknown): boolean => str(v, 2048) && /^https?:\/\/[^\s]+$/.test(v);

/** A message read back from a job payload, or null when it is not one this version writes. */
export function parseNotifyMessage(raw: unknown): NotifyMessage | null {
  const m = raw as Partial<NotifyMessage> | null;
  if (!m || typeof m !== "object") return null;
  if (!str(m.id, 64) || !/^[\w-]{8,64}$/.test(m.id)) return null;
  if (!str(m.event, 40) || !(NOTIFY_EVENTS as readonly string[]).includes(m.event)) return null;
  if (!SEVERITIES.includes(m.severity as Severity)) return null;
  if (!str(m.title, 300) || !str(m.text, 4000) || !str(m.at, 40) || Number.isNaN(Date.parse(m.at))) return null;
  if (m.url !== null && !link(m.url)) return null;
  if (!Array.isArray(m.fields) || m.fields.length > 25 || !m.fields.every((f) => f && str(f.name, 100) && str(f.value, 1000))) return null;
  const inst = m.instance;
  if (!inst || !str(inst.name, 200) || !(inst.url === null || link(inst.url))) return null;
  if (m.data !== undefined && (typeof m.data !== "object" || m.data === null || Array.isArray(m.data))) return null;
  return {
    id: m.id, event: m.event, severity: m.severity as Severity, title: m.title, text: m.text, url: m.url ?? null,
    fields: m.fields.map((f) => ({ name: f.name, value: f.value })), at: m.at, instance: { name: inst.name, url: inst.url ?? null },
    ...(m.data ? { data: m.data } : {}),
  };
}

/** The message "Send test" posts. */
export function testMessage(id: string, instance: { name: string; url: string | null }, now = new Date()): NotifyMessage {
  return {
    id,
    event: "test",
    severity: "info",
    title: "Test notification",
    text: `This webhook is connected to ${instance.name}. Alerts and update notices you choose will arrive here.`,
    url: instance.url,
    fields: [],
    at: now.toISOString(),
    instance,
  };
}
