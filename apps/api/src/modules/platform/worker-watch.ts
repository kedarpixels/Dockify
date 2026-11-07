/**
 * The "worker down" alert, raised from outside the worker. The worker evaluates every other
 * alert rule itself (apps/worker/src/observe/alerts.ts) and so cannot report its own death: it always
 * read itself as up. The api watches the heartbeat instead (Instance.workerSeenAt, stamped every 30
 * seconds). Once the worker has been silent for WORKER_SILENT_MS plus a rule's durationMin, every
 * enabled service rule covering the worker (service worker, any, or none) opens one event, deduped
 * under the same advisory lock and subject the worker uses, and the api sends it at once through its
 * own path: each of the rule's enabled webhooks, opened and delivered here (integrations/webhooks.ts
 * openTarget, @dockify/notify deliver through net-guard), because the worker that would run the
 * alert_notify jobs is the thing that is down. Email only leaves through the worker (an email_send
 * job), so the email notice is queued and goes out when the worker is back. The worker's own alert
 * pass then reads itself as up, resolves the event, and sends the resolution where the firing went.
 */
import type { Keyring } from "@dockify/crypto";
import { enqueue, type Db } from "@dockify/db";
import { createHttpClient, type HttpClient } from "@dockify/net-guard";
import { deliver, type NotifyMessage } from "@dockify/notify";
import { openTarget } from "../integrations/webhooks.ts";
import { WORKER_SILENT_MS } from "./server.ts";

export const WATCH_EVERY_MS = 60_000;
const DETAIL = "The worker service is not responding";

export interface WorkerWatchDeps {
  db: Db;
  ring: Keyring;
  /** The dashboard address, for the alert's link. */
  publicUrl: URL;
  http?: HttpClient;
  /** When this api started: a worker that never reported counts as silent from here. */
  startedAt?: number;
  /** Sends one message to one stored webhook; true when it was delivered. Tests pass a fake. */
  sendWebhook?: (hook: WebhookRow, message: NotifyMessage) => Promise<boolean>;
}

export interface WebhookRow {
  id: string;
  provider: Parameters<typeof openTarget>[2]["provider"];
  chatId: string | null;
  secretId: string | null;
  secondSecretId: string | null;
}

/** The api's own path to a webhook: open its URL (and second secret) and deliver through net-guard. */
function webhookSender(deps: WorkerWatchDeps): (hook: WebhookRow, message: NotifyMessage) => Promise<boolean> {
  const http = deps.http ?? createHttpClient();
  return async (hook, message) => {
    const target = await openTarget(deps.db, deps.ring, hook).catch(() => null);
    if (!target) return false;
    const out = await deliver(http, target, message).catch(() => null);
    return !!out?.ok;
  };
}

/** When the worker counts as down, or null while its heartbeat is fresh. */
export function workerDownSince(seenAt: Date | null, startedAt: number, now: number): number | null {
  const last = seenAt?.getTime() ?? startedAt;
  return now - last > WORKER_SILENT_MS ? last + WORKER_SILENT_MS : null;
}

/** The firing message every webhook gets, the shape the worker's alertMessage sends for a service alert. */
export function workerDownMessage(ev: { id: string; startedAt: Date }, publicUrl: URL, instanceName: string): NotifyMessage {
  const url = new URL("/server", publicUrl).toString();
  return {
    id: `${ev.id}-firing`,
    event: "alert.firing",
    severity: "critical",
    title: "Firing: Control plane service down",
    text: DETAIL,
    url,
    fields: [{ name: "Where", value: "service worker" }],
    at: ev.startedAt.toISOString(),
    instance: { name: instanceName, url: publicUrl.origin },
    data: {
      alert: { id: ev.id, metric: "service", detail: DETAIL, startedAt: ev.startedAt.toISOString(), resolvedAt: null, url },
      app: null,
      service: "worker",
    },
  };
}

/** One check. Returns the ids of the events it opened. */
export async function checkWorker(deps: WorkerWatchDeps, now = Date.now()): Promise<string[]> {
  const { db } = deps;
  const inst = await db.instance.findUnique({ where: { id: 1 }, select: { workerSeenAt: true, name: true } });
  const since = workerDownSince(inst?.workerSeenAt ?? null, deps.startedAt ?? now, now);
  if (since === null) return [];
  const rules = await db.alertRule.findMany({
    where: { enabled: true, metric: "service", OR: [{ service: "worker" }, { service: "any" }, { service: null }] },
    select: { id: true, durationMin: true, channels: true, webhooks: { where: { webhook: { enabled: true } }, select: { webhookId: true } } },
  });
  const opened: string[] = [];
  for (const rule of rules) {
    if (now - since < rule.durationMin * 60_000) continue;
    const ev = await db.$transaction(async (tx) => {
      // The worker's lock key and subject for this rule and service (alert-runner.ts).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`alert:${rule.id}:service:worker`}))`;
      const dup = await tx.alertEvent.findFirst({ where: { ruleId: rule.id, state: "firing", appId: null, service: "worker" }, select: { id: true } });
      if (dup) return null;
      const row = await tx.alertEvent.create({
        data: { ruleId: rule.id, metric: "service", appId: null, service: "worker", detail: DETAIL, href: "/server", muted: false },
        select: { id: true, startedAt: true },
      });
      await tx.alertRule.update({ where: { id: rule.id }, data: { lastFiredAt: new Date(now) } });
      return row;
    });
    if (!ev) continue;
    opened.push(ev.id);
    let sent = false;
    const ids = rule.webhooks.map((w) => w.webhookId);
    if (ids.length) {
      const hooks = await db.notificationWebhook.findMany({ where: { id: { in: ids }, enabled: true }, select: { id: true, provider: true, chatId: true, secretId: true, secondSecretId: true } });
      const message = workerDownMessage(ev, deps.publicUrl, inst?.name ?? "Dockify");
      const send = deps.sendWebhook ?? webhookSender(deps);
      for (const h of hooks) if (await send(h, message).catch(() => false)) sent = true;
    }
    if (sent) await db.alertEvent.update({ where: { id: ev.id }, data: { notifiedAt: new Date() } });
    // Email leaves only through the worker: queued now, sent when it is back.
    if (rule.channels.includes("email")) {
      await enqueue(db, { kind: "alert_notify", lane: "maintenance", payload: { eventId: ev.id, channel: "email", transition: "firing" }, dedupeKey: `alert:${ev.id}:email:firing`, maxAttempts: 6 }).catch(() => undefined);
    }
  }
  return opened;
}

/** Runs checkWorker every WATCH_EVERY_MS, single flight. The first check waits one period. */
export function startWorkerWatch(deps: WorkerWatchDeps, log: (msg: string, err: unknown) => void): () => void {
  const watch = { ...deps, startedAt: deps.startedAt ?? Date.now() };
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void checkWorker(watch)
      .catch((e: unknown) => log("worker watch failed", e))
      .finally(() => {
        running = false;
      });
  }, WATCH_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
