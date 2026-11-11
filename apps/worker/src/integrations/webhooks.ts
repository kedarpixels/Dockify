/**
 * Notification webhook delivery. Targets are opened through the vault (each open audited; the worker
 * holds no key), and nothing here logs or returns a URL, a token or a secret. For an api outage the
 * last opened target is kept in memory only, and used only while the row still names that same value.
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

/** Null when it is gone, switched off or has no URL. A Send test opens a switched off webhook too. */
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

/** Opens the webhooks that would announce an api outage, so a copy is in memory when it comes. */
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

export async function recordDelivery(db: Db, id: string, out: DeliveryOutcome): Promise<void> {
  const data = out.ok ? { error: null, lastSentAt: new Date() } : { error: out.reason.slice(0, 300), lastFailedAt: new Date() };
  await db.notificationWebhook.update({ where: { id }, data }).catch(() => undefined);
}

export async function sendToWebhook(deps: WebhookDeps, id: string, message: NotifyMessage): Promise<DeliveryOutcome | "skipped"> {
  const target = await openWebhook(deps.db, deps.vault, id, { targets: deps.targets });
  if (!target) return "skipped";
  const out = await deliver(deps.http, target, message);
  await recordDelivery(deps.db, id, out);
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An unsaved webhook's Send test: the api seals its URL under this owner type, deleted once opened. */
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

/** Throws to retry, PermanentJobError to stop. A test leaves its result on its own row for the api to read. */
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
