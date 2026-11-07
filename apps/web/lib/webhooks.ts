import type { IconName } from "@/components/icon";
import { WEBHOOK_PROVIDER_INFO, type WebhookProviderId } from "./webhook-providers";

/*
 * The client-safe half of notification webhooks: the shapes the API answers (packages/contracts,
 * integrations.ts) and what each provider shows. Detection lives in lib/webhook-providers.ts, a
 * byte-identical copy of packages/contracts/src/webhooks.ts that a contracts test keeps equal.
 *
 * Secrets are write-only: a URL, a bot token, a signing secret or an access token goes in through a
 * body and only its host and last four characters come back. A signing secret Dockify makes is
 * answered once, by the save that made it.
 */

export type { WebhookProviderId };

export interface WebhookIconRef {
  /** A sha256 prefix: the image URL is cached for good under it. */
  version: string;
  source: "favicon" | "upload";
  width: number;
  height: number;
}

export interface WebhookIcon {
  /** auto: the provider's mark, or a generic webhook's site icon. upload: a logo the owner gave. */
  choice: "auto" | "upload";
  /** A generic webhook's stored logo or site icon; null draws the provider's mark. */
  image: WebhookIconRef | null;
  /** The link a logo was downloaded from. */
  logoUrl: string | null;
  favicon: { origin: string | null; fetchedAt: string | null; checkedAt: string | null; error: string | null } | null;
}

/** A webhook as alert rules and the integrations row name it. */
export interface WebhookRef {
  id: string;
  name: string;
  provider: WebhookProviderId;
  enabled: boolean;
  icon: WebhookIcon;
}

export const webhookRefOf = (w: Webhook): WebhookRef => ({ id: w.id, name: w.name, provider: w.provider, enabled: w.enabled, icon: w.icon });

export interface Webhook extends WebhookRef {
  /** Also gets Dockify's update notices. */
  updates: boolean;
  host: string;
  /** The last four characters of the URL's secret part; "" when too short to show. */
  hint: string;
  chatId: string | null;
  signingSecretHint: string | null;
  accessTokenHint: string | null;
  status: "ok" | "failing" | "never";
  error: string | null;
  lastSentAt: string | null;
  lastFailedAt: string | null;
  /** How many alert rules send here. */
  rules: number;
  createdAt: string;
}

export interface WebhookSaved {
  webhook: Webhook;
  /** Only when Dockify just made one: shown once. */
  signingSecret: string | null;
}

export type WebhookLogo = { choice: "auto" } | { choice: "url"; url: string } | { choice: "upload"; image: string };

export interface WebhookInput {
  name?: string;
  provider?: WebhookProviderId;
  url?: string;
  botToken?: string;
  chatId?: string;
  signingSecret?: string;
  accessToken?: string | null;
  enabled?: boolean;
  updates?: boolean;
  logo?: WebhookLogo;
}

export interface WebhookTestResult {
  provider: WebhookProviderId;
  status: number;
  latencyMs: number;
}

/** The mark each provider shows; a generic webhook shows its logo, its site's icon, or this glyph. */
export const PROVIDER_ICON: Readonly<Record<WebhookProviderId, IconName>> = {
  discord: "discord",
  slack: "slack",
  teams: "teams",
  google_chat: "googleChat",
  telegram: "telegram",
  mattermost: "mattermost",
  rocket_chat: "rocketChat",
  ntfy: "ntfy",
  generic: "webhook",
};

export const providerLabel = (p: WebhookProviderId) => WEBHOOK_PROVIDER_INFO[p].label;

/** A generic webhook's logo or site icon, same origin and versioned (app/api/icons/webhooks). */
export const webhookIconUrl = (id: string, version: string) => `/api/icons/webhooks/${encodeURIComponent(id)}?v=${encodeURIComponent(version)}`;

/** A logo upload in the browser: the same limit the API checks (128 KB). */
export const LOGO_MAX_BYTES = 128 * 1024;
export const LOGO_TYPES = "image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/vnd.microsoft.icon,image/svg+xml";
