/**
 * The instance event switches in Settings, Notifications. This is the only file in the worker that
 * reads them; everything that sends goes through eventOn, at the moment it would send, so a switch
 * turned off also stops what was already queued.
 *
 *   deployFailed        deploy_notify (integrations/deploy-notify.ts): webhooks and the member who started it,
 *                       for a deploy on this server or on Vercel (integrations/vercel-mirror.ts queues those)
 *   appDown             alert_notify for a down or crash loop rule (observe/channels.ts); the bell still lists it
 *   backupFailed        event_notify, here: a scheduled backup that failed
 *   tlsExpiring         event_notify, here: a certificate with less than 14 days left
 *   previewDeployments  preview_notify (integrations/preview-notify.ts)
 *   jobFailed           event_notify, from jobs/run.ts: a scheduled job that started failing
 */
import { auth as A } from "@dockify/contracts";
import { enqueue, type Db, type Prisma } from "@dockify/db";
import { alert, type AlertKind } from "@dockify/email";
import type { NotifyMessage, Severity } from "@dockify/notify";
import { PermanentJobError } from "../errors.ts";
import { loadSender, mailEach, type EmailDeps } from "./email.ts";

export async function eventOn(db: Db, event: A.NotifyEventName): Promise<boolean> {
  const row = await db.instance.findUnique({ where: { id: 1 }, select: { notifyEvents: true } });
  return A.notifyEvents(row?.notifyEvents)[event];
}

/** The switch an alert rule's metric answers to. A metric with none (disk, memory) is only its rule's business. */
export const metricEvent = (metric: string): A.NotifyEventName | null => (metric === "down" || metric === "crash_loop" ? "appDown" : null);

/**
 * Queues a message for every enabled webhook, each its own job so one dead webhook holds up nothing.
 * A job row of any age counts, so a retry of the job calling this never sends a webhook twice.
 */
export async function webhooksOnce(db: Db, key: string, message: NotifyMessage): Promise<number> {
  const hooks = await db.notificationWebhook.findMany({ where: { enabled: true }, select: { id: true }, orderBy: { createdAt: "asc" } });
  let queued = 0;
  for (const h of hooks) {
    const dedupeKey = `${key}:${h.id}`;
    if (await db.job.findFirst({ where: { dedupeKey }, select: { id: true } })) continue;
    await enqueue(db, { kind: "webhook_send", lane: "maintenance", payload: { webhookId: h.id, message } as unknown as Prisma.InputJsonValue, dedupeKey, maxAttempts: 6 });
    queued += 1;
  }
  return queued;
}

const EVENTS = {
  backupFailed: { kind: "backupFailed", webhook: "backup.failed", severity: "critical" },
  tlsExpiring: { kind: "tlsExpiring", webhook: "tls.expiring", severity: "warning" },
  jobFailed: { kind: "jobFailed", webhook: "job.failed", severity: "warning" },
} as const satisfies Record<string, { kind: AlertKind; webhook: string; severity: Severity }>;

export interface EventNotice {
  event: keyof typeof EVENTS;
  /** Names this occurrence: one backup, one certificate. Letters, digits and hyphens. */
  id: string;
  title: string;
  /** One line, already redacted. */
  detail: string;
  where: string;
  /** The dashboard path that shows it. */
  href: string;
  at: string;
}

const noticeKey = (n: Pick<EventNotice, "event" | "id">) => `event:${n.event}:${n.id}`;

/** Queues one notice, once ever: a job row of any age counts, so a sweep can ask again on every pass. */
export async function queueEventNotice(db: Db, n: EventNotice): Promise<boolean> {
  const dedupeKey = noticeKey(n);
  if (await db.job.findFirst({ where: { dedupeKey }, select: { id: true } })) return false;
  await enqueue(db, { kind: "event_notify", lane: "maintenance", payload: { ...n }, dedupeKey, maxAttempts: 5 });
  return true;
}

export function parseEventNotice(raw: unknown): EventNotice {
  const p = raw as Partial<Record<keyof EventNotice, unknown>> | null;
  const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
  if (
    !p || typeof p.event !== "string" || !(p.event in EVENTS) || !text(p.id, 64) || !/^[\w-]+$/.test(p.id) || !text(p.title, 120) || !text(p.detail, 2000) ||
    !text(p.where, 300) || !text(p.href, 500) || !p.href.startsWith("/") || !text(p.at, 40) || Number.isNaN(Date.parse(p.at))
  ) {
    throw new PermanentJobError("event_notify payload is malformed");
  }
  return { event: p.event as EventNotice["event"], id: p.id, title: p.title, detail: p.detail, where: p.where, href: p.href, at: p.at };
}

export interface EventNotifyDeps extends EmailDeps {
  publicUrl: string | null;
}

/** The event_notify job: every enabled webhook, then every admin by email. Throws to retry, PermanentJobError to stop. */
export async function deliverEventNotice(deps: EventNotifyDeps, raw: unknown): Promise<"sent" | "skipped"> {
  const n = parseEventNotice(raw);
  if (!(await eventOn(deps.db, n.event))) return "skipped";
  const meta = EVENTS[n.event];
  const inst = await deps.db.instance.findUnique({ where: { id: 1 }, select: { name: true } });
  const name = inst?.name ?? "Dockify";
  const url = deps.publicUrl ? new URL(n.href, deps.publicUrl).toString() : null;
  const origin = deps.publicUrl ? new URL(deps.publicUrl).origin : null;
  const hooks = await webhooksOnce(deps.db, noticeKey(n), {
    id: `${n.event}-${n.id}`.slice(0, 64),
    event: meta.webhook,
    severity: meta.severity,
    title: n.title,
    text: n.detail,
    url,
    fields: [{ name: "Where", value: n.where }],
    at: n.at,
    instance: { name, url: origin },
    data: { event: { kind: n.event, id: n.id, detail: n.detail, where: n.where } },
  });
  const sender = url ? await loadSender(deps.db, deps.vault) : null;
  if (!sender || !url) return hooks ? "sent" : "skipped";
  const admins = await deps.db.member.findMany({ where: { role: "admin", user: { disabledAt: null } }, select: { user: { select: { id: true, email: true } } } });
  const message = alert({ instanceName: name, origin: origin ?? undefined, kind: meta.kind, source: "event", state: "firing", title: n.title, detail: n.detail, where: n.where, at: new Date(n.at), url });
  const mailed = await mailEach(deps, sender, admins.map((a) => a.user), message, (id) => `${noticeKey(n)}:${id}`);
  return hooks || mailed ? "sent" : "skipped";
}

/** How far back a failed backup is still news. Far shorter than a job row lives, so nothing is told twice. */
const BACKUP_NEWS_MS = 6 * 3_600_000;

interface BackupSnapshot {
  name?: unknown;
  projectSlug?: unknown;
  environment?: unknown;
}

/**
 * Every failed scheduled backup becomes one notice. A backup can fail along several paths (its job,
 * the sweep for a dead job, the next request finding it stale), so this reads the rows they all
 * write rather than adding a call to each. A backup someone started by hand reports on its own page.
 */
export async function announceFailedBackups(db: Db, now = new Date()): Promise<number> {
  const rows = await db.backup.findMany({
    where: { status: "failed", trigger: "schedule", finishedAt: { gt: new Date(now.getTime() - BACKUP_NEWS_MS) } },
    select: { id: true, appSnapshot: true, error: true, finishedAt: true },
    orderBy: { finishedAt: "asc" },
    take: 50,
  });
  let n = 0;
  for (const b of rows) {
    const s = (b.appSnapshot ?? {}) as BackupSnapshot;
    const name = typeof s.name === "string" ? s.name : "a database";
    const where = [s.projectSlug, s.environment, s.name].filter((x): x is string => typeof x === "string").join(" / ") || name;
    const queued = await queueEventNotice(db, {
      event: "backupFailed",
      id: b.id,
      title: `Backup failed: ${name}`.slice(0, 120),
      detail: (b.error ?? "The backup did not finish").replace(/\s+/g, " ").slice(0, 2000),
      where,
      href: "/backups",
      at: (b.finishedAt ?? now).toISOString(),
    });
    if (queued) n += 1;
  }
  return n;
}

/** Let's Encrypt renews with 30 days left, so under this renewal has been failing for two weeks. */
const TLS_WARN_MS = 14 * 86_400_000;

/** Each certificate with under 14 days left warns once. A renewed one has a new date, so it could warn anew. */
export async function announceExpiringCertificates(db: Db, now = new Date()): Promise<number> {
  const rows = await db.domain.findMany({
    where: { tlsStatus: "active", tlsExpiresAt: { not: null, lt: new Date(now.getTime() + TLS_WARN_MS) } },
    select: { id: true, hostname: true, tlsExpiresAt: true, tlsWarnedFor: true },
    take: 100,
  });
  let n = 0;
  for (const d of rows) {
    const expires = d.tlsExpiresAt!;
    if (d.tlsWarnedFor?.getTime() === expires.getTime()) continue;
    const days = Math.max(0, Math.ceil((expires.getTime() - now.getTime()) / 86_400_000));
    await queueEventNotice(db, {
      event: "tlsExpiring",
      id: `${d.id}-${expires.getTime()}`,
      title: `Certificate expiring: ${d.hostname}`.slice(0, 120),
      detail: `The certificate for ${d.hostname} expires in ${days} ${days === 1 ? "day" : "days"}, on ${expires.toISOString().slice(0, 10)}. Check that the domain still points at this server.`,
      where: d.hostname,
      href: "/domains",
      at: now.toISOString(),
    });
    await db.domain.update({ where: { id: d.id }, data: { tlsWarnedFor: expires } });
    n += 1;
  }
  return n;
}
