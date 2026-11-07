/**
 * Alert delivery to notification webhooks and to email (owners and admins, over SMTP). Each
 * send is one job on the leased queue (kind alert_notify), one per webhook, so
 * retries, backoff and a worker crash mid-send are the queue's problem and one dead webhook never
 * holds up another. The in-app bell needs no delivery: the AlertEvent row is what the bell lists.
 *
 * A webhook's URL is its credential. It is opened only right before the send (integrations/
 * webhooks.ts), sent through net-guard, and never logged; failures name the provider and status.
 */
import { appLabel } from "@dockify/contracts";
import type { Db, SecretVault } from "@dockify/db";
import type { Metric } from "./alerts.ts";
import { createHttpClient, type HttpClient } from "@dockify/net-guard";
import type { NotifyMessage, Severity } from "@dockify/notify";
import { createMailer, mailPolicyFromEnv, type AlertKind, type AppRef, type Mailer } from "@dockify/email";
import { mailIconLinks, mailIconSigner, SHOWN_APP_ICON, SHOWN_PROJECT_ICON } from "../icons/mail.ts";
import { sendAlertEmails } from "../integrations/email.ts";
import { eventOn, metricEvent } from "../integrations/events.ts";
import { DeferJobError, PermanentJobError } from "../errors.ts";
import { sendToWebhook, type WebhookTargets } from "../integrations/webhooks.ts";

export type Transition = "firing" | "resolved";

/**
 * One delivery. email: the owners and admins. webhook: one notification webhook by id. legacy: a
 * job queued by a version before the webhook list, naming the old single Discord or generic
 * channel; it goes to the rule's webhooks of that provider, which the migration linked.
 */
export type NotifyTarget = { kind: "email" } | { kind: "webhook"; webhookId: string } | { kind: "legacy"; provider: "discord" | "generic" };

export interface NotifyPayload {
  eventId: string;
  transition: Transition;
  to: NotifyTarget;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseNotifyPayload(raw: unknown): NotifyPayload {
  const p = raw as { eventId?: unknown; channel?: unknown; webhookId?: unknown; transition?: unknown } | null;
  const transition: Transition | null = p?.transition === "firing" ? "firing" : p?.transition === "resolved" ? "resolved" : null;
  if (!p || typeof p.eventId !== "string" || !UUID.test(p.eventId) || !transition) throw new PermanentJobError("alert_notify payload is malformed");
  const base = { eventId: p.eventId, transition };
  if (p.channel === "email") return { ...base, to: { kind: "email" } };
  if (p.channel === "webhook" && typeof p.webhookId === "string" && UUID.test(p.webhookId)) return { ...base, to: { kind: "webhook", webhookId: p.webhookId } };
  if (p.channel === "webhook" && p.webhookId === undefined) return { ...base, to: { kind: "legacy", provider: "generic" } };
  if (p.channel === "discord") return { ...base, to: { kind: "legacy", provider: "discord" } };
  throw new PermanentJobError("alert_notify payload is malformed");
}

/** Contract spelling of a metric, the one webhook consumers and the web see. */
export const PUBLIC_METRIC: Record<Metric, string> = {
  disk: "disk", service: "service", down: "down", crash_loop: "crashLoop", memory: "memory",
};
const TITLE: Record<Metric, string> = {
  disk: "Disk almost full", service: "Control plane service down", down: "App down",
  crash_loop: "App crash loop", memory: "App memory high",
};
/** An app or a service that is down is critical; a resource running high is a warning. */
const FIRING: Record<Metric, Severity> = { disk: "warning", service: "critical", down: "critical", crash_loop: "critical", memory: "warning" };

export interface AlertView {
  id: string;
  metric: Metric;
  service: string | null;
  detail: string;
  href: string;
  startedAt: Date;
  resolvedAt: Date | null;
  /** `shown` is what people read as the app's name, its display name when it has one; `name` stays its identity. */
  app: { name: string; shown?: string; projectSlug: string; environment: string } | null;
  /** The app as the email's project chip shows it (name, kind, icon links); only the email channel reads it. */
  chip?: AppRef | null;
}

const whereOf = (a: AlertView): string => (a.app ? `${a.app.projectSlug} / ${a.app.environment} / ${a.app.shown ?? a.app.name}` : a.service ? `service ${a.service}` : "host");

/**
 * One alert as every webhook gets it, shaped per provider by @dockify/notify. The generic
 * webhook's JSON keeps the shape earlier versions sent (event, alert, app, service, occurredAt).
 */
export function alertMessage(a: AlertView, t: Transition, publicUrl: string | null, instanceName: string): NotifyMessage {
  const url = publicUrl ? new URL(a.href, publicUrl).toString() : null;
  const at = t === "firing" ? a.startedAt : (a.resolvedAt ?? new Date());
  return {
    id: `${a.id}-${t}`,
    event: `alert.${t}`,
    severity: t === "firing" ? FIRING[a.metric] : "success",
    title: `${t === "firing" ? "Firing" : "Resolved"}: ${TITLE[a.metric]}`,
    text: a.detail.slice(0, 2000),
    url,
    fields: [{ name: "Where", value: whereOf(a) }],
    at: at.toISOString(),
    instance: { name: instanceName, url: publicUrl ? new URL(publicUrl).origin : null },
    data: {
      alert: {
        id: a.id, metric: PUBLIC_METRIC[a.metric], detail: a.detail, startedAt: a.startedAt.toISOString(),
        resolvedAt: a.resolvedAt?.toISOString() ?? null, url: url ?? a.href,
      },
      // The shape earlier versions sent: the app by its name, which is its identity.
      app: a.app ? { name: a.app.name, projectSlug: a.app.projectSlug, environment: a.app.environment } : null,
      service: a.service,
    },
  };
}

export interface NotifyDeps {
  db: Db;
  vault: SecretVault;
  publicUrl: string | null;
  /** The net-guard client, for webhooks. Tests pass a fake. */
  http?: HttpClient;
  /** The SMTP sender, for email. Tests pass a fake. */
  mail?: Mailer | undefined;
  /** DOCKIFY_INTERNAL_TOKEN, to sign the icon links in an alert email; without it the chip shows the tiles. */
  internalToken?: string | undefined;
  /** What this process last opened, for an api outage (integrations/webhooks.ts). */
  targets?: WebhookTargets | undefined;
}

const EMAIL_KIND: Partial<Record<Metric, AlertKind>> = { down: "appDown", crash_loop: "appDown" };

/** The email channel: one message per owner and admin. Throws to retry, PermanentJobError to stop. */
async function deliverEmail(deps: NotifyDeps, a: AlertView, t: Transition): Promise<"sent" | "skipped"> {
  if (!deps.publicUrl) throw new PermanentJobError("email channel needs DOCKIFY_PUBLIC_URL for its link");
  const where = a.chip ?? whereOf(a);
  const n = await sendAlertEmails(
    { db: deps.db, vault: deps.vault, mail: deps.mail ?? createMailer(mailPolicyFromEnv()) },
    {
      eventId: a.id, transition: t, kind: EMAIL_KIND[a.metric] ?? "alert", title: TITLE[a.metric], detail: a.detail, where,
      at: t === "firing" ? a.startedAt : (a.resolvedAt ?? new Date()), url: new URL(a.href, deps.publicUrl).toString(),
      // Brand assets come from the configured dashboard, never from wherever the alert links.
      origin: new URL(deps.publicUrl).origin,
    },
  );
  return n ? "sent" : "skipped";
}

/** The webhooks a legacy job means: the rule's linked webhooks of the old channel's provider. */
async function legacyTargets(db: Db, ruleId: string | null, provider: "discord" | "generic"): Promise<string[]> {
  if (!ruleId) return [];
  const links = await db.alertRuleWebhook.findMany({ where: { ruleId, webhook: { provider } }, select: { webhookId: true } });
  return links.map((l) => l.webhookId);
}

/** The alert_notify job body. Throws to retry, PermanentJobError to stop. */
export async function deliverAlert(deps: NotifyDeps, raw: unknown): Promise<"sent" | "skipped"> {
  const p = parseNotifyPayload(raw);
  const ev = await deps.db.alertEvent.findUnique({
    where: { id: p.eventId },
    include: {
      app: {
        select: {
          ...SHOWN_APP_ICON,
          name: true, displayName: true, kind: true,
          environment: { select: { name: true, project: { select: { ...SHOWN_PROJECT_ICON, slug: true, name: true } } } },
        },
      },
    },
  });
  if (!ev || ev.muted) return "skipped";
  // The bell still lists it: the switch is about what leaves this server.
  const event = metricEvent(ev.metric);
  if (event && !(await eventOn(deps.db, event))) return "skipped";
  // A firing that is still waiting for the api goes first, so nobody hears "resolved" about an alert
  // they never heard of, or hears the two the wrong way round.
  if (p.transition === "resolved" && p.to.kind !== "legacy") {
    const key = `alert:${ev.id}:${p.to.kind === "email" ? "email" : `webhook:${p.to.webhookId}`}:firing`;
    if (await deps.db.job.findFirst({ where: { kind: "alert_notify", dedupeKey: key, completedAt: null, failedAt: null }, select: { id: true } })) {
      throw new DeferJobError("The firing message for this alert has not gone out yet", 15_000);
    }
  }
  const origin = deps.publicUrl ? new URL(deps.publicUrl).origin : undefined;
  const project = ev.app?.environment.project;
  const view: AlertView = {
    id: ev.id, metric: ev.metric as Metric, service: ev.service, detail: ev.detail, href: ev.href,
    startedAt: ev.startedAt, resolvedAt: ev.resolvedAt,
    app: ev.app && project ? { name: ev.app.name, shown: appLabel(ev.app), projectSlug: project.slug, environment: ev.app.environment.name } : null,
    // The email's project chip: the dashboard's names and icons; webhooks keep their own shape.
    chip: ev.app && project
      ? {
          projectName: project.name, projectSlug: project.slug, env: ev.app.environment.name, appName: appLabel(ev.app), appKind: ev.app.kind,
          ...mailIconLinks(origin, mailIconSigner(deps.internalToken), ev.app, project),
        }
      : null,
  };
  if (p.to.kind === "email") {
    const out = await deliverEmail(deps, view, p.transition);
    if (out === "sent" && p.transition === "firing") await deps.db.alertEvent.update({ where: { id: ev.id }, data: { notifiedAt: new Date() } });
    return out;
  }

  const ids = p.to.kind === "webhook" ? [p.to.webhookId] : await legacyTargets(deps.db, ev.ruleId, p.to.provider);
  if (!ids.length) return "skipped";
  const instance = (await deps.db.instance.findUnique({ where: { id: 1 }, select: { name: true } }))?.name ?? "Dockify";
  const message = alertMessage(view, p.transition, deps.publicUrl, instance);
  const http = deps.http ?? createHttpClient();
  let sent = false;
  let retry: string | null = null;
  let refused: string | null = null;
  for (const id of ids) {
    const out = await sendToWebhook({ db: deps.db, vault: deps.vault, http, ...(deps.targets ? { targets: deps.targets } : {}) }, id, message);
    if (out === "skipped") continue;
    if (out.ok) sent = true;
    else if (out.retry) retry ??= out.reason;
    else refused ??= out.reason;
  }
  if (sent && p.transition === "firing") await deps.db.alertEvent.update({ where: { id: ev.id }, data: { notifiedAt: new Date() } });
  if (retry) throw new Error(retry);
  if (refused) throw new PermanentJobError(refused);
  return sent ? "sent" : "skipped";
}
