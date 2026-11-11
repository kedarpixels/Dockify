/** The icon_fetch job. A failed fetch keeps whatever was stored before and records why. */
import { createHash } from "node:crypto";
import { enqueue, type Db } from "@dockify/db";
import type { HttpClient } from "@dockify/net-guard";
import { findFavicon, findWebhookFavicon, type FaviconResult } from "./favicon.ts";

export interface IconJobDeps {
  db: Db;
  http: HttpClient;
}

const ID = /^[0-9a-f-]{36}$/i;

export function parseIconFetch(p: unknown): { appId: string } | { webhookId: string } | null {
  const o = p as { appId?: unknown; webhookId?: unknown } | null;
  if (typeof o?.appId === "string" && ID.test(o.appId)) return { appId: o.appId };
  if (typeof o?.webhookId === "string" && ID.test(o.webhookId)) return { webhookId: o.webhookId };
  return null;
}

const imageOf = (found: Extract<FaviconResult, { ok: true }>) => ({
  mime: found.image.mime,
  data: new Uint8Array(found.bytes),
  sha256: createHash("sha256").update(found.bytes).digest("hex"),
  width: found.image.width,
  height: found.image.height,
  origin: found.url.slice(0, 2048),
});

async function webhookFavicon(deps: IconJobDeps, webhookId: string): Promise<void> {
  const { db } = deps;
  const w = await db.notificationWebhook.findUnique({ where: { id: webhookId }, select: { id: true, provider: true, host: true, iconChoice: true } });
  // Only a generic webhook on its automatic icon shows a favicon; the others draw their own mark.
  if (!w || w.provider !== "generic" || w.iconChoice !== "auto") return;
  const found = await findWebhookFavicon(deps.http, w.host);
  const now = new Date();
  if (!found.ok) {
    await db.notificationWebhook.update({ where: { id: w.id }, data: { faviconCheckedAt: now, faviconError: found.reason.slice(0, 200) } });
    return;
  }
  const image = imageOf(found);
  await db.$transaction([
    db.iconImage.upsert({ where: { webhookId_source: { webhookId: w.id, source: "favicon" } }, create: { webhookId: w.id, source: "favicon", ...image }, update: image }),
    db.notificationWebhook.update({ where: { id: w.id }, data: { faviconCheckedAt: now, faviconError: null } }),
  ]);
}

export async function runIconFetch(deps: IconJobDeps, payload: unknown): Promise<void> {
  const job = parseIconFetch(payload);
  if (!job) return;
  if ("webhookId" in job) return webhookFavicon(deps, job.webhookId);
  const { db } = deps;
  const app = await db.app.findUnique({
    where: { id: job.appId },
    select: { id: true, kind: true, primaryDomain: { select: { hostname: true } }, domains: { select: { hostname: true }, orderBy: { createdAt: "asc" } } },
  });
  if (!app || app.kind !== "frontend") return;
  const primary = app.primaryDomain?.hostname;
  const hosts = app.domains.map((d) => d.hostname);
  const ordered = primary ? [primary, ...hosts.filter((h) => h !== primary)] : hosts;

  const found = await findFavicon(deps.http, ordered);
  const now = new Date();
  if (!found.ok) {
    await db.app.update({ where: { id: app.id }, data: { faviconCheckedAt: now, faviconError: found.reason.slice(0, 200) } });
    return;
  }
  const image = imageOf(found);
  await db.$transaction([
    db.iconImage.upsert({ where: { appId_source: { appId: app.id, source: "favicon" } }, create: { appId: app.id, source: "favicon", ...image }, update: image }),
    db.app.update({ where: { id: app.id }, data: { faviconCheckedAt: now, faviconError: null } }),
  ]);
}

/** Queued after a frontend's deploy goes live; a failure here never touches the deploy. */
export async function queueIconFetch(db: Db, appId: string): Promise<void> {
  await enqueue(db, { kind: "icon_fetch", lane: "maintenance", payload: { appId }, dedupeKey: `icon_fetch:${appId}`, maxAttempts: 1, runAfterMs: 5_000 }).catch(() => undefined);
}
