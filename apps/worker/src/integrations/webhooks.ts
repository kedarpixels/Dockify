/**
 * The worker's side of notification webhooks. It opens one webhook's endpoint and secrets through
 * the vault (the api's internal routes, each open audited; the worker holds no key), sends one
 * message through the net-guard client with @dockify/notify, and records how it went on the
 * webhook's row for the dashboard. Nothing here logs or returns a URL, a token or a secret.
 *
 * Two jobs send this way: alert_notify (observe/channels.ts) for alerts, and webhook_send for
 * messages built ahead of time (update notices), one job per webhook so each retries on its own. The
 * dashboard's Send test is a webhook_send job too, so a green test proves the path alerts take.
 *
 * While the api is down nothing can be opened, and an alert about that outage is the one that matters
 * most. So the worker remembers what it last opened, in this process's memory only and never
 * on disk, and falls back to it only when the api does not answer, and only while the webhook's row
 * still names that same value. Without such a copy the job waits for the api (wiring.ts).
 */
import { readSecretValues, type Db, type Prisma, type SecretVault } from "@dockify/db";
import type { HttpClient } from "@dockify/net-guard";
import { deliver, parseNotifyMessage, type DeliveryOutcome, type NotifyMessage, type WebhookTarget } from "@dockify/notify";
import { PermanentJobError } from "../errors.ts";
import { isVaultDown } from "../vault.ts";

export interface WebhookDeps {
  db: Db;
  vault: SecretVault;
  http: HttpClient;
  /** What this process last opened, for an api outage. Without it, an outage just waits. */
  targets?: WebhookTargets;
}

/** Each webhook's last opened target, under what its row named when it was opened. Memory only. */
export class WebhookTargets {
  private readonly byId = new Map<string, { stamp: string; target: WebhookTarget }>();
  remember(id: string, stamp: string, target: WebhookTarget): void {
    this.byId.set(id, { stamp, target });
  }
  recall(id: string, stamp: string): WebhookTarget | null {
    const hit = this.byId.get(id);
    return hit && hit.stamp === stamp ? hit.target : null;
  }
}

const OPEN_SELECT = {
  provider: true, enabled: true, chatId: true, secretId: true, secondSecretId: true,
  secret: { select: { updatedAt: true } }, secondSecret: { select: { updatedAt: true } },
} as const;

/**
 * One webhook's target, opened for one send; null when it is gone, switched off or has no URL. A
 * test opens a switched off webhook too, as the dashboard's Send test always has.
 */
export async function openWebhook(db: Db, vault: SecretVault, id: string, opts: { targets?: WebhookTargets | undefined; includeDisabled?: boolean } = {}): Promise<WebhookTarget | null> {
  const row = await db.notificationWebhook.findUnique({ where: { id }, select: OPEN_SELECT });
  if (!row || (!row.enabled && !opts.includeDisabled) || !row.secretId) return null;
  // Changes with the provider, the chat, and either sealed value, so an edited webhook never gets the old URL.
  const stamp = [row.provider, row.chatId, row.secretId, row.secret?.updatedAt.getTime(), row.secondSecretId, row.secondSecret?.updatedAt.getTime()].join("|");
  const ids = row.secondSecretId ? [row.secretId, row.secondSecretId] : [row.secretId];
  let values: Map<string, string | null>;
  try {
    values = await readSecretValues(db, vault, ids);
  } catch (e) {
    const known = isVaultDown(e) ? opts.targets?.recall(id, stamp) : null;
    if (known) return known;
    throw e;
  }
  const url = values.get(row.secretId);
  if (!url) return null;
  const target: WebhookTarget = { provider: row.provider, url, chatId: row.chatId, secret: row.secondSecretId ? (values.get(row.secondSecretId) ?? null) : null };
  opts.targets?.remember(id, stamp, target);
  return target;
}

/**
 * Opens the webhooks that would announce an api outage (those of a service rule that covers the api),
 * so a copy is in memory when that outage comes. Each open is audited as usual; a timer runs this.
 */
export async function primeWebhookTargets(deps: Pick<WebhookDeps, "db" | "vault"> & { targets: WebhookTargets }): Promise<number> {
  const links = await deps.db.alertRuleWebhook.findMany({
    where: { webhook: { enabled: true }, rule: { enabled: true, metric: "service", OR: [{ service: "api" }, { service: "any" }, { service: null }] } },
    select: { webhookId: true },
    distinct: ["webhookId"],
  });
  let opened = 0;
  for (const l of links) if (await openWebhook(deps.db, deps.vault, l.webhookId, { targets: deps.targets })) opened++;
  return opened;
}

/** What the dashboard's list shows: a success clears the error, a failure records why. */
export async function recordDelivery(db: Db, id: string, out: DeliveryOutcome): Promise<void> {
  const data = out.ok ? { error: null, lastSentAt: new Date() } : { error: out.reason.slice(0, 300), lastFailedAt: new Date() };
  await db.notificationWebhook.update({ where: { id }, data }).catch(() => undefined);
}

/** Sends one message to one webhook and records it; "skipped" when there is nothing to send to. */
export async function sendToWebhook(deps: WebhookDeps, id: string, message: NotifyMessage): Promise<DeliveryOutcome | "skipped"> {
  const target = await openWebhook(deps.db, deps.vault, id, { targets: deps.targets });
  if (!target) return "skipped";
  const out = await deliver(deps.http, target, message);
  await recordDelivery(deps.db, id, out);
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A webhook the add form has not saved yet, for one Send test: the api sealed its URL (and second
 * secret) under this owner type for this one job, and those rows go as soon as they are opened.
 */
export const DRAFT_OWNER = "webhook_test";

export type WebhookSend =
  | { webhookId: string; message: NotifyMessage; test: boolean }
  | { draft: { provider: WebhookTarget["provider"]; chatId: string | null; urlSecretId: string; secretSecretId: string | null }; message: NotifyMessage; test: true };

/** A webhook_send payload. Anything else can never succeed, so it is permanent. */
export function parseWebhookSend(raw: unknown): WebhookSend {
  const bad = () => new PermanentJobError("webhook_send payload is malformed");
  const p = raw as { webhookId?: unknown; message?: unknown; test?: unknown; draft?: Record<string, unknown> | null } | null;
  const message = p ? parseNotifyMessage(p.message) : null;
  if (!p || !message) throw bad();
  if (typeof p.webhookId === "string" && UUID.test(p.webhookId)) return { webhookId: p.webhookId, message, test: p.test === true };
  const d = p.draft;
  if (!d || p.test !== true || typeof d.urlSecretId !== "string" || !UUID.test(d.urlSecretId) || typeof d.provider !== "string") throw bad();
  if (d.secretSecretId !== null && (typeof d.secretSecretId !== "string" || !UUID.test(d.secretSecretId))) throw bad();
  return {
    draft: { provider: d.provider as WebhookTarget["provider"], chatId: typeof d.chatId === "string" ? d.chatId : null, urlSecretId: d.urlSecretId, secretSecretId: d.secretSecretId },
    message,
    test: true,
  };
}

async function openDraft(deps: WebhookDeps, d: Extract<WebhookSend, { draft: unknown }>["draft"]): Promise<WebhookTarget | null> {
  const ids = d.secretSecretId ? [d.urlSecretId, d.secretSecretId] : [d.urlSecretId];
  try {
    const values = await readSecretValues(deps.db, deps.vault, ids);
    const url = values.get(d.urlSecretId);
    return url ? { provider: d.provider, url, chatId: d.chatId, secret: d.secretSecretId ? (values.get(d.secretSecretId) ?? null) : null } : null;
  } finally {
    await deps.db.secret.deleteMany({ where: { id: { in: ids }, ownerType: DRAFT_OWNER } }).catch(() => undefined);
  }
}

/**
 * The webhook_send job. Throws to retry, PermanentJobError to stop. A test also leaves what it got on
 * its own row, which the api's Send test is waiting to read.
 */
export async function runWebhookSend(deps: WebhookDeps, raw: unknown, jobId?: string): Promise<"sent" | "skipped"> {
  const send = parseWebhookSend(raw);
  const saved = "webhookId" in send;
  const target = saved ? await openWebhook(deps.db, deps.vault, send.webhookId, { targets: deps.targets, includeDisabled: send.test }) : await openDraft(deps, send.draft);
  if (!target) {
    if (send.test) throw new PermanentJobError("This webhook has no URL stored. Edit it and paste the URL again");
    return "skipped";
  }
  const out = await deliver(deps.http, target, send.message);
  if (saved) await recordDelivery(deps.db, send.webhookId, out);
  if (send.test && jobId) {
    const result = out.ok ? { ok: true, status: out.status, latencyMs: out.latencyMs } : { ok: false, status: out.status ?? null, reason: out.reason };
    await deps.db.job.update({ where: { id: jobId }, data: { payload: { ...(raw as Record<string, unknown>), result } as Prisma.InputJsonValue } });
  }
  if (out.ok) return "sent";
  if (out.retry && !send.test) throw new Error(out.reason);
  throw new PermanentJobError(out.reason);
}
