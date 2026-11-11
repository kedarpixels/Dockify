/**
 * No imports on purpose: the web keeps a byte-identical copy for the add form, which a test keeps equal.
 * Detection is advice, never authority: every URL still goes through net-guard before anything is sent.
 */

export const WEBHOOK_PROVIDERS = ["discord", "slack", "teams", "google_chat", "telegram", "mattermost", "rocket_chat", "ntfy", "generic"] as const;
export type WebhookProviderId = (typeof WEBHOOK_PROVIDERS)[number];

export const isWebhookProvider = (v: unknown): v is WebhookProviderId => typeof v === "string" && (WEBHOOK_PROVIDERS as readonly string[]).includes(v);

export interface WebhookProviderInfo {
  label: string;
  paste: string;
  /**
   * The provider only lives on its own hosts, so its URL is recognised for sure and no other provider's URL
   * can take its type. False for self-hosted products and the generic one.
   */
  fixedHost: boolean;
}

export const WEBHOOK_PROVIDER_INFO: Readonly<Record<WebhookProviderId, WebhookProviderInfo>> = {
  discord: { label: "Discord", paste: "A channel webhook URL, from the channel's Integrations settings", fixedHost: true },
  slack: { label: "Slack", paste: "An incoming webhook URL from your Slack app", fixedHost: true },
  teams: { label: "Microsoft Teams", paste: "A Workflows webhook URL, or an Incoming Webhook connector URL", fixedHost: false },
  google_chat: { label: "Google Chat", paste: "A space's webhook URL, from Apps and integrations", fixedHost: true },
  telegram: { label: "Telegram", paste: "A bot token from BotFather and the chat the bot posts to", fixedHost: true },
  mattermost: { label: "Mattermost", paste: "An incoming webhook URL from Integrations", fixedHost: false },
  rocket_chat: { label: "Rocket.Chat", paste: "An incoming webhook URL from Administration, Integrations", fixedHost: false },
  ntfy: { label: "ntfy", paste: "A topic URL on ntfy.sh or on your own ntfy server", fixedHost: false },
  generic: { label: "Webhook", paste: "Any https endpoint that takes a signed JSON POST", fixedHost: false },
};

export const WEBHOOK_URL_MAX = 2048;

const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".localdomain", ".intranet", ".corp", ".private"];
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A hostname as the URL parser leaves it (lowercase, punycode): two labels or more, not internal, not an address. */
function isPlainHostname(host: string): boolean {
  if (!host || host.length > 253 || host.startsWith("[") || host === "localhost") return false;
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return false;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  // The parser turns every IPv4 spelling (2130706433, 0x7f.1, 127.1) into four decimal labels.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  return !/^\d+$/.test(labels[labels.length - 1]!);
}

export type WebhookUrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * https, a public-looking hostname (never an IP), no userinfo, fragment, spaces or backslashes.
 * The parsed URL is what Dockify stores and posts to, so what the owner sees is what is called.
 */
export function checkWebhookUrl(raw: string): WebhookUrlCheck {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "Paste the webhook URL" };
  if (text.length > WEBHOOK_URL_MAX) return { ok: false, reason: "The URL is too long" };
  if (/[\s\\\u0000-\u001f\u007f]/.test(text)) return { ok: false, reason: "The URL has spaces or characters a URL cannot have" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "Use an https URL" };
  if (url.username || url.password) return { ok: false, reason: "Leave the user name and password out of the URL" };
  if (url.hash) return { ok: false, reason: "Leave out the part after #" };
  const host = url.hostname;
  if (host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return { ok: false, reason: "Use the webhook's hostname, not an IP address" };
  if (!isPlainHostname(host)) return { ok: false, reason: "The URL needs a public hostname" };
  return { ok: true, url };
}

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com", "ptb.discordapp.com", "canary.discordapp.com"]);
const DISCORD_PATH = /^\/api(?:\/v\d{1,2})?\/webhooks\/\d{5,30}\/[\w-]{20,200}$/;
const SLACK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);
const SLACK_PATH = /^\/services\/[A-Z0-9]{6,20}\/[A-Z0-9]{6,20}\/[A-Za-z0-9]{16,64}$/;
const GCHAT_PATH = /^\/v1\/spaces\/[\w-]{5,64}\/messages$/;
/** Microsoft 365 Incoming Webhook connector: https://<tenant>.webhook.office.com/webhookb2/... */
const TEAMS_CONNECTOR_HOST = /^[a-z0-9][a-z0-9-]{0,62}\.webhook\.office\.com$/;
const TEAMS_CONNECTOR_PATH = /^\/webhookb2\/[\w@.-]{10,200}\/IncomingWebhook\/[\w-]{10,100}\/[\w-]{10,100}(?:\/[\w-]{1,100})?$/;
/** Teams Workflows (Power Automate): a Logic Apps trigger, or the Power Platform address that replaced it. */
const LOGIC_APPS_HOST = /^prod-\d{1,3}\.[a-z0-9]{2,40}\.logic\.azure\.com$/;
const LOGIC_APPS_PATH = /^\/workflows\/[0-9a-f]{32}\/triggers\/manual\/paths\/invoke$/;
const POWER_PLATFORM_HOST = /^[0-9a-z]{8,64}\.[0-9a-z]{1,8}\.environment\.api\.powerplatform\.com$/;
const POWER_PLATFORM_PATH = /^\/powerautomate\/automations\/direct\/workflows\/[0-9a-f]{32}\/triggers\/manual\/paths\/invoke$/;
const TELEGRAM_PATH = /^\/bot(\d{3,15}:[\w-]{20,64})(?:\/(?:sendMessage)?)?$/;
/** Mattermost's incoming webhook id is 26 lowercase letters and digits, possibly under a subpath. */
const MATTERMOST_PATH = /^(?:\/[\w.-]{1,64}){0,3}\/hooks\/[a-z0-9]{26}$/;
/** Rocket.Chat's is an integration id and a token, possibly under a subpath. */
const ROCKET_CHAT_PATH = /^(?:\/[\w.-]{1,64}){0,3}\/hooks\/[A-Za-z0-9]{17}\/[A-Za-z0-9]{20,64}$/;
const NTFY_TOPIC_PATH = /^\/[\w-]{1,64}$/;

export const TELEGRAM_TOKEN = /^\d{3,15}:[\w-]{20,64}$/;
/** A numeric chat id (negative for groups and channels) or a public @channel name (5 to 32 characters). */
export const TELEGRAM_CHAT = /^(?:-?\d{1,20}|@[A-Za-z]\w{4,31})$/;

const onlyQuery = (u: URL, allowed: readonly string[]) => [...u.searchParams.keys()].every((k) => allowed.includes(k));

/**
 * How sure a recognition is. exact: the URL can only be that provider's. likely: the shape of a
 * self-hosted product, which the owner can change. fallback: no shape matched; a generic webhook.
 */
export type WebhookConfidence = "exact" | "likely" | "fallback";
export interface WebhookDetection {
  provider: WebhookProviderId;
  confidence: WebhookConfidence;
}

/** The provider a pasted URL belongs to, or null when the URL is not one any webhook may have. */
export function detectWebhook(raw: string): WebhookDetection | null {
  const checked = checkWebhookUrl(raw);
  if (!checked.ok) return null;
  const u = checked.url;
  const host = u.hostname;
  const path = u.pathname;
  // A provider's own hosts answer on the default port only; another port is someone else's server.
  const own = !u.port;
  const exact = (provider: WebhookProviderId): WebhookDetection => ({ provider, confidence: "exact" });
  const likely = (provider: WebhookProviderId): WebhookDetection => ({ provider, confidence: "likely" });

  if (own && DISCORD_HOSTS.has(host) && DISCORD_PATH.test(path) && onlyQuery(u, ["thread_id", "wait"])) return exact("discord");
  if (own && SLACK_HOSTS.has(host) && SLACK_PATH.test(path) && !u.search) return exact("slack");
  if (own && host === "chat.googleapis.com" && GCHAT_PATH.test(path) && u.searchParams.get("key") && u.searchParams.get("token")) return exact("google_chat");
  if (own && host === "api.telegram.org" && TELEGRAM_PATH.test(path) && onlyQuery(u, ["chat_id"])) return exact("telegram");
  if (own && TEAMS_CONNECTOR_HOST.test(host) && TEAMS_CONNECTOR_PATH.test(path)) return exact("teams");
  if (own && ((LOGIC_APPS_HOST.test(host) && LOGIC_APPS_PATH.test(path)) || (POWER_PLATFORM_HOST.test(host) && POWER_PLATFORM_PATH.test(path))) && u.searchParams.get("sig")) {
    return likely("teams");
  }
  if (own && host === "ntfy.sh" && NTFY_TOPIC_PATH.test(path) && !u.search) return exact("ntfy");
  if (MATTERMOST_PATH.test(path) && !u.search) return likely("mattermost");
  if (ROCKET_CHAT_PATH.test(path) && !u.search) return likely("rocket_chat");
  if (host.startsWith("ntfy.") && NTFY_TOPIC_PATH.test(path) && !u.search) return likely("ntfy");
  return { provider: "generic", confidence: "fallback" };
}

/**
 * Why a URL cannot be stored for this provider, or null. A fixed-host provider takes only its own URL,
 * so a message is never formatted for a service that will refuse it.
 */
export function webhookUrlProblem(provider: WebhookProviderId, raw: string): string | null {
  const checked = checkWebhookUrl(raw);
  if (!checked.ok) return checked.reason;
  const found = detectWebhook(raw)!;
  const info = WEBHOOK_PROVIDER_INFO[provider];
  if (info.fixedHost && found.provider !== provider) {
    switch (provider) {
      case "discord":
        return "Use a Discord webhook URL (https://discord.com/api/webhooks/...)";
      case "slack":
        return "Use a Slack incoming webhook URL (https://hooks.slack.com/services/...)";
      case "google_chat":
        return "Use a Google Chat webhook URL (https://chat.googleapis.com/v1/spaces/...)";
      default:
        return "Use a Telegram bot URL (https://api.telegram.org/bot<token>/sendMessage), or the bot token and chat fields";
    }
  }
  if (found.confidence === "exact" && WEBHOOK_PROVIDER_INFO[found.provider].fixedHost && found.provider !== provider) {
    const label = WEBHOOK_PROVIDER_INFO[found.provider].label;
    return `This is a ${label} webhook URL. Keep ${label} as its type, or paste another URL`;
  }
  return null;
}

export const telegramEndpoint = (token: string): string => `https://api.telegram.org/bot${token}/sendMessage`;

/** The bot token and, when the URL names one, the chat of a pasted Telegram URL; null for anything else. */
export function telegramFromUrl(raw: string): { token: string; chatId: string | null } | null {
  const checked = checkWebhookUrl(raw);
  if (!checked.ok || checked.url.hostname !== "api.telegram.org" || checked.url.port || !onlyQuery(checked.url, ["chat_id"])) return null;
  const m = TELEGRAM_PATH.exec(checked.url.pathname);
  if (!m) return null;
  const chat = checked.url.searchParams.get("chat_id");
  return { token: m[1]!, chatId: chat && TELEGRAM_CHAT.test(chat) ? chat : null };
}

const tail = (s: string): string => (s.length >= 8 ? s.slice(-4) : "");

/**
 * The last four characters of the part of a stored URL that works as its password, or "" when that part
 * is too short to show safely. Nothing else of the URL but the host is ever answered back.
 */
export function webhookSecretHint(provider: WebhookProviderId, raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "";
  }
  const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
  switch (provider) {
    case "google_chat":
      return tail(u.searchParams.get("token") ?? "");
    case "teams":
      return tail(u.searchParams.get("sig") ?? last);
    case "telegram":
      return tail(TELEGRAM_PATH.exec(u.pathname)?.[1] ?? "");
    case "generic":
      return tail(u.search ? u.search.slice(1) : last);
    default:
      return tail(last);
  }
}
