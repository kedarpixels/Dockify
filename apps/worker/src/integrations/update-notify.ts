/**
 * The update_notify job. Email goes first (its idempotency key makes a retry a no-op); each webhook
 * then gets its own webhook_send job, so one dead webhook never holds up the others or repeats the email.
 */
import { enqueue, type Db, type Prisma, type SecretVault } from "@dockify/db";
import { updateNotice, type Mailer } from "@dockify/email";
import type { NotifyMessage, Severity } from "@dockify/notify";
import { PermanentJobError } from "../errors.ts";
import { loadSender, mailEach } from "./email.ts";

export interface UpdateNotify {
  event: "available" | "updated" | "failed" | "rolled_back";
  version: string;
  from: string | null;
  error: string | null;
  updateId: string | null;
}

const VERSION = /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/;

export function parseUpdateNotify(raw: unknown): UpdateNotify {
  const p = raw as Partial<UpdateNotify> | null;
  const events = ["available", "updated", "failed", "rolled_back"];
  if (!p || !events.includes(p.event as string) || typeof p.version !== "string" || !VERSION.test(p.version) || (p.from !== null && (typeof p.from !== "string" || !VERSION.test(p.from)))) {
    throw new PermanentJobError("update_notify payload is malformed");
  }
  return {
    event: p.event as UpdateNotify["event"],
    version: p.version.replace(/^v/, ""),
    from: p.from ? p.from.replace(/^v/, "") : null,
    error: typeof p.error === "string" ? p.error.slice(0, 500) : null,
    updateId: typeof p.updateId === "string" ? p.updateId : null,
  };
}

const TITLE: Record<UpdateNotify["event"], (n: UpdateNotify) => string> = {
  available: (n) => `Update available: Dockify v${n.version}`,
  updated: (n) => `Updated to Dockify v${n.version}`,
  failed: (n) => `Update to Dockify v${n.version} failed`,
  rolled_back: (n) => `Update failed, rolled back to v${n.from ?? "the previous version"}`,
};
const SEVERITY: Record<UpdateNotify["event"], Severity> = { available: "info", updated: "success", failed: "critical", rolled_back: "critical" };

export function updateMessage(n: UpdateNotify, instanceName: string, url: string | null, jobId: string, now = new Date()): NotifyMessage {
  const fields = [{ name: "Version", value: `v${n.version}` }];
  if (n.from) fields.push({ name: "Before", value: `v${n.from}` });
  return {
    id: `update-${jobId}`.slice(0, 64),
    event: `update.${n.event}`,
    severity: SEVERITY[n.event],
    title: TITLE[n.event](n),
    text: n.error ?? (n.event === "available" ? "A new signed release is ready on the Server page." : `On ${instanceName}.`),
    url,
    fields,
    at: now.toISOString(),
    instance: { name: instanceName, url: url ? new URL(url).origin : null },
    data: { update: { event: n.event, version: n.version, from: n.from, error: n.error } },
  };
}

export interface UpdateNotifyDeps {
  db: Db;
  vault: SecretVault;
  mail: Mailer;
  publicUrl: string | null;
}

/** Throws to retry, PermanentJobError to stop. Returns what went out: email, and one entry per webhook queued. */
export async function deliverUpdateNotice(deps: UpdateNotifyDeps, raw: unknown, jobId: string): Promise<string[]> {
  const n = parseUpdateNotify(raw);
  const inst = await deps.db.instance.findUnique({ where: { id: 1 }, select: { name: true } });
  const name = inst?.name ?? "Dockify";
  const url = deps.publicUrl ? new URL("/server#updates", deps.publicUrl).toString() : null;
  const sent: string[] = [];

  const sender = url ? await loadSender(deps.db, deps.vault) : null;
  if (sender && url) {
    const admins = await deps.db.member.findMany({ where: { role: "admin", user: { disabledAt: null } }, select: { user: { select: { id: true, email: true } } } });
    const message = updateNotice({ instanceName: name, origin: (() => { try { return new URL(url).origin; } catch { return undefined; } })(), event: n.event, version: n.version, from: n.from, error: n.error, url });
    await mailEach(deps, sender, admins.map((a) => a.user), message, (id) => `update:${jobId}:${id}`);
    if (admins.length) sent.push("email");
  }

  const hooks = await deps.db.notificationWebhook.findMany({ where: { enabled: true, updates: true }, select: { id: true }, orderBy: { createdAt: "asc" } });
  if (hooks.length) {
    const message = updateMessage(n, name, url, jobId);
    for (const h of hooks) {
      // Keyed per update job and webhook, so a retry of this job never queues a second send.
      await enqueue(deps.db, { kind: "webhook_send", lane: "maintenance", payload: { webhookId: h.id, message } as unknown as Prisma.InputJsonValue, dedupeKey: `update:${jobId}:${h.id}`, maxAttempts: 6 });
      sent.push(`webhook:${h.id}`);
    }
  }
  return sent;
}
