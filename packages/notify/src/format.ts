/**
 * One message, shaped for each provider in its own native format. Every piece of text is escaped
 * for the markup the provider renders, so nothing in a message can format, link or mention by
 * accident: Discord markdown and mentions, Slack's <...> controls, Teams and Google Chat markup,
 * Telegram HTML, and Markdown links and @mentions in Mattermost and Rocket.Chat.
 *
 * The generic webhook's JSON (genericBody) is the documented one:
 *
 *   {
 *     "version": 1,
 *     "id": "<delivery id, the same across retries>",
 *     "event": "alert.firing" | "alert.resolved" | "update.available" | "update.updated" |
 *              "update.failed" | "update.rolled_back" | "test",
 *     "occurredAt": "<ISO time>",
 *     "severity": "critical" | "warning" | "info" | "success",
 *     "title": "...", "text": "...", "url": "<dashboard link>" | null,
 *     "fields": [{ "name": "...", "value": "..." }],
 *     "instance": { "name": "...", "url": "<dashboard origin>" | null },
 *     // alerts also carry the shape earlier versions sent:
 *     "alert": { "id", "metric", "detail", "startedAt", "resolvedAt", "url" }, "app": {...} | null, "service": "..." | null,
 *     // update notices carry:
 *     "update": { "event", "version", "from", "error" }
 *   }
 *
 * deliver.ts signs it (X-Dockify-Signature) and sends it.
 */
import { WEBHOOK_PROVIDER_INFO, type WebhookProviderId } from "@dockify/contracts";
import type { NotifyMessage, Severity } from "./message.ts";

export const HEX: Readonly<Record<Severity, string>> = { critical: "#D9534F", warning: "#D29922", info: "#2396ED", success: "#3FB950" };
const ACTION = "Open in Dockify";

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, Math.max(0, n - 3))}...` : s);
/** Control characters never belong in a message; newlines and tabs stay. */
const plain = (s: string): string => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
const fieldsOf = (m: NotifyMessage) => m.fields.filter((f) => f.name.trim() && f.value.trim());

// ------------------------------------------------------------------ Discord

/** Discord markdown and mentions, escaped: no ping, no masked link, no formatting from outside text. */
export const discordSafe = (s: string): string => plain(s).replace(/[@`*_~|>\\[\]]/g, (c) => `\\${c}`);

export function discordBody(m: NotifyMessage): object {
  const fields = fieldsOf(m).slice(0, 25);
  return {
    username: "Dockify",
    // Never resolve @everyone, roles or users, whatever the text holds.
    allowed_mentions: { parse: [] },
    embeds: [{
      title: clip(plain(m.title), 256),
      description: clip(discordSafe(m.text), 4000),
      ...(m.url ? { url: m.url } : {}),
      color: parseInt(HEX[m.severity].slice(1), 16),
      ...(fields.length ? { fields: fields.map((f) => ({ name: clip(plain(f.name), 256), value: clip(discordSafe(f.value), 1024), inline: true })) } : {}),
      footer: { text: clip(plain(m.instance.name), 2048) },
      timestamp: m.at,
    }],
  };
}

// ------------------------------------------------------------------ Slack

/** Slack's three control characters; with < escaped, no <!channel> or <@user> can form. */
export const slackSafe = (s: string): string => plain(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function slackBody(m: NotifyMessage): object {
  const fields = fieldsOf(m).slice(0, 10);
  const blocks: object[] = [
    { type: "header", text: { type: "plain_text", text: clip(plain(m.title), 150), emoji: false } },
    { type: "section", text: { type: "mrkdwn", text: clip(slackSafe(m.text), 3000) || " " } },
  ];
  if (fields.length) blocks.push({ type: "section", fields: fields.map((f) => ({ type: "mrkdwn", text: clip(`*${slackSafe(f.name)}*\n${slackSafe(f.value)}`, 2000) })) });
  if (m.url) blocks.push({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: ACTION }, url: m.url }] });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: clip(slackSafe(m.instance.name), 300) }] });
  // text is the notification's fallback: Slack shows the blocks.
  return { text: clip(slackSafe(`${m.title}: ${m.text}`), 300), blocks };
}

// ------------------------------------------------------------------ Microsoft Teams

/** Adaptive Card text renders a subset of Markdown: escape what could link or format. */
export const teamsSafe = (s: string): string => plain(s).replace(/[\\`*_[\]()<>#~|]/g, (c) => `\\${c}`);
const TEAMS_COLOR: Readonly<Record<Severity, string>> = { critical: "Attention", warning: "Warning", info: "Accent", success: "Good" };

/** An Adaptive Card in a message envelope: what Teams Workflows and Incoming Webhook connectors both take. */
export function teamsBody(m: NotifyMessage): object {
  const fields = fieldsOf(m).slice(0, 20);
  const body: object[] = [
    { type: "TextBlock", text: teamsSafe(clip(m.title, 300)), weight: "Bolder", size: "Medium", wrap: true, color: TEAMS_COLOR[m.severity] },
    { type: "TextBlock", text: teamsSafe(clip(m.text, 3000)), wrap: true },
  ];
  if (fields.length) body.push({ type: "FactSet", facts: fields.map((f) => ({ title: teamsSafe(clip(f.name, 100)), value: teamsSafe(clip(f.value, 500)) })) });
  body.push({ type: "TextBlock", text: teamsSafe(clip(m.instance.name, 200)), isSubtle: true, size: "Small", wrap: true });
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.4",
        msteams: { width: "Full" },
        body,
        ...(m.url ? { actions: [{ type: "Action.OpenUrl", title: ACTION, url: m.url }] } : {}),
      },
    }],
  };
}

// ------------------------------------------------------------------ Google Chat

/** Card text renders a little HTML (<b>, <a>, <font>): escape it all. */
export const htmlSafe = (s: string): string => plain(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function googleChatBody(m: NotifyMessage): object {
  const widgets: object[] = [{ textParagraph: { text: htmlSafe(clip(m.text, 3000)) } }];
  for (const f of fieldsOf(m).slice(0, 20)) widgets.push({ decoratedText: { topLabel: htmlSafe(clip(f.name, 100)), text: htmlSafe(clip(f.value, 500)) } });
  if (m.url) widgets.push({ buttonList: { buttons: [{ text: ACTION, onClick: { openLink: { url: m.url } } }] } });
  return {
    // Shown where the card cannot be (notifications); plain text, no markup.
    fallbackText: clip(plain(m.title), 300),
    cardsV2: [{
      cardId: "dockify",
      card: {
        header: { title: clip(plain(m.title), 200), subtitle: clip(plain(m.instance.name), 200) },
        sections: [{ widgets }],
      },
    }],
  };
}

// ------------------------------------------------------------------ Telegram

export function telegramBody(m: NotifyMessage, chatId: string): object {
  const lines = [`<b>${htmlSafe(clip(m.title, 300))}</b>`, htmlSafe(clip(m.text, 3000))];
  for (const f of fieldsOf(m).slice(0, 20)) lines.push(`<b>${htmlSafe(clip(f.name, 100))}:</b> ${htmlSafe(clip(f.value, 500))}`);
  if (m.url) lines.push(`<a href="${htmlSafe(m.url)}">${ACTION}</a>`);
  lines.push(`<i>${htmlSafe(clip(m.instance.name, 200))}</i>`);
  return {
    chat_id: chatId,
    text: clip(lines.join("\n"), 4096),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };
}

// ------------------------------------------------------------------ Mattermost and Rocket.Chat

/**
 * Both render Markdown and notify on @all, @channel, @here and @name. A zero-width space after
 * each @ keeps the text as it reads while no mention can form. What could make a link, an image,
 * HTML or a code span is escaped; < also gets the space, for a parser that reads <url|text> and
 * knows no backslash.
 */
export const chatSafe = (s: string): string =>
  plain(s).replace(/[\\`[\]()!>]/g, (c) => `\\${c}`).replace(/</g, "\\<​").replace(/@/g, "@​");

export function mattermostBody(m: NotifyMessage): object {
  return {
    username: "Dockify",
    attachments: [{
      fallback: clip(chatSafe(`${m.title}: ${m.text}`), 300),
      color: HEX[m.severity],
      title: clip(chatSafe(m.title), 250),
      ...(m.url ? { title_link: m.url } : {}),
      text: clip(chatSafe(m.text), 4000),
      fields: fieldsOf(m).slice(0, 20).map((f) => ({ short: true, title: clip(chatSafe(f.name), 100), value: clip(chatSafe(f.value), 500) })),
      footer: clip(chatSafe(m.instance.name), 200),
    }],
  };
}

export function rocketChatBody(m: NotifyMessage): object {
  return {
    alias: "Dockify",
    // The message line notifications show; the attachment holds the rest.
    text: `*${clip(chatSafe(m.title).replace(/\*/g, ""), 250)}*`,
    attachments: [{
      color: HEX[m.severity],
      text: clip(chatSafe(m.text), 4000),
      ...(m.url ? { title: ACTION, title_link: m.url } : {}),
      fields: fieldsOf(m).slice(0, 20).map((f) => ({ short: true, title: clip(chatSafe(f.name), 100), value: clip(chatSafe(f.value), 500) })),
    }],
  };
}

// ------------------------------------------------------------------ ntfy

const NTFY_PRIORITY: Readonly<Record<Severity, string>> = { critical: "5", warning: "4", info: "3", success: "3" };
const NTFY_TAGS: Readonly<Record<Severity, string>> = { critical: "rotating_light", warning: "warning", info: "information_source", success: "white_check_mark" };

/** A header value: one line, and RFC 2047 encoded when it is not plain ASCII (ntfy decodes it). */
export function headerValue(s: string): string {
  const line = plain(s).replace(/[\r\n\t]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(line) ? line : `=?UTF-8?B?${Buffer.from(line, "utf8").toString("base64")}?=`;
}

/** ntfy: the message as plain text, the title, priority, tags and link as headers. */
export function ntfyRequest(m: NotifyMessage): { headers: Record<string, string>; body: string } {
  const lines = [plain(m.text), ...fieldsOf(m).map((f) => `${plain(f.name)}: ${plain(f.value)}`)];
  return {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Title: headerValue(clip(m.title, 250)),
      Priority: NTFY_PRIORITY[m.severity],
      Tags: NTFY_TAGS[m.severity],
      ...(m.url ? { Click: headerValue(m.url) } : {}),
    },
    body: clip(lines.join("\n"), 3500),
  };
}

// ------------------------------------------------------------------ generic

export function genericBody(m: NotifyMessage): object {
  return {
    ...m.data,
    version: 1,
    id: m.id,
    event: m.event,
    occurredAt: m.at,
    severity: m.severity,
    title: m.title,
    text: m.text,
    url: m.url,
    fields: m.fields,
    instance: m.instance,
  };
}

/** The JSON body for the providers that take one (all but ntfy, which deliver.ts sends as text). */
export function jsonBodyFor(provider: Exclude<WebhookProviderId, "ntfy">, m: NotifyMessage, chatId?: string | null): object {
  switch (provider) {
    case "discord":
      return discordBody(m);
    case "slack":
      return slackBody(m);
    case "teams":
      return teamsBody(m);
    case "google_chat":
      return googleChatBody(m);
    case "telegram":
      return telegramBody(m, chatId ?? "");
    case "mattermost":
      return mattermostBody(m);
    case "rocket_chat":
      return rocketChatBody(m);
    case "generic":
      return genericBody(m);
  }
}

