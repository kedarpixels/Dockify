/** Shared with the alerts module. Only hints of the stored secrets ever leave: never a URL, a token or a signing secret. */
import type { integrations } from "@dockify/contracts";
import { ICON_IMAGE, iconVersion, LIVE_ALERT_METRIC, shownWebhookIcon, type IconImageRow, type Prisma } from "@dockify/db";

type Webhook = integrations.Webhook;
type WebhookIcon = integrations.WebhookIcon;
type WebhookRef = integrations.WebhookRef;

export const WEBHOOK_REF_SELECT = {
  id: true, name: true, provider: true, enabled: true, iconChoice: true, logoUrl: true, faviconCheckedAt: true, faviconError: true,
  icons: { select: ICON_IMAGE },
} as const satisfies Prisma.NotificationWebhookSelect;

export const WEBHOOK_SELECT = {
  ...WEBHOOK_REF_SELECT,
  updates: true, host: true, chatId: true, error: true, lastSentAt: true, lastFailedAt: true, createdAt: true,
  secret: { select: { hint: true } },
  secondSecret: { select: { hint: true } },
  _count: { select: { rules: { where: { rule: { metric: LIVE_ALERT_METRIC } } } } },
} as const satisfies Prisma.NotificationWebhookSelect;

export type WebhookRefRow = Prisma.NotificationWebhookGetPayload<{ select: typeof WEBHOOK_REF_SELECT }>;
export type WebhookRow = Prisma.NotificationWebhookGetPayload<{ select: typeof WEBHOOK_SELECT }>;

const refOf = (i: IconImageRow | null) => (i ? { version: iconVersion(i.sha256), source: i.source, width: i.width, height: i.height } : null);

export function webhookIcon(w: WebhookRefRow): WebhookIcon {
  const generic = w.provider === "generic";
  const fav = w.icons.find((i) => i.source === "favicon") ?? null;
  return {
    choice: generic ? w.iconChoice : "auto",
    image: refOf(shownWebhookIcon(w)),
    logoUrl: generic && w.iconChoice === "upload" ? w.logoUrl : null,
    favicon: generic && w.iconChoice === "auto"
      ? { origin: fav?.origin ?? null, fetchedAt: fav?.updatedAt.toISOString() ?? null, checkedAt: w.faviconCheckedAt?.toISOString() ?? null, error: w.faviconError }
      : null,
  };
}

export const webhookRef = (w: WebhookRefRow): WebhookRef => ({ id: w.id, name: w.name, provider: w.provider, enabled: w.enabled, icon: webhookIcon(w) });

export function webhookView(w: WebhookRow): Webhook {
  return {
    id: w.id,
    name: w.name,
    provider: w.provider,
    enabled: w.enabled,
    updates: w.updates,
    host: w.host,
    hint: w.secret?.hint ?? "",
    chatId: w.provider === "telegram" ? w.chatId : null,
    signingSecretHint: w.provider === "generic" ? (w.secondSecret?.hint ?? null) : null,
    accessTokenHint: w.provider === "ntfy" ? (w.secondSecret?.hint ?? null) : null,
    status: w.error ? "failing" : w.lastSentAt ? "ok" : "never",
    error: w.error,
    lastSentAt: w.lastSentAt?.toISOString() ?? null,
    lastFailedAt: w.lastFailedAt?.toISOString() ?? null,
    rules: w._count.rules,
    icon: webhookIcon(w),
    createdAt: w.createdAt.toISOString(),
  };
}
