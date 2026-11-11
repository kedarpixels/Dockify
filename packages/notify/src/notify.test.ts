import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHttpClient, type HttpClient, type HttpRequest, type HttpResponse } from "@dockify/net-guard";
import {
  chatSafe, classifyStatus, deliver, discordBody, discordSafe, genericBody, googleChatBody, headerValue, mattermostBody, newSigningSecret, ntfyRequest,
  parseNotifyMessage, prepare, rocketChatBody, sign, slackBody, slackSafe, teamsBody, teamsSafe, telegramBody, testMessage, verifySignature,
  type NotifyMessage,
} from "./index.ts";

const AT = "2026-11-06T10:00:00.000Z";
const HOSTILE = "web <!channel> @everyone [click](https://evil.example) *bold* <b>x</b> & `code`";
const msg = (over: Partial<NotifyMessage> = {}): NotifyMessage => ({
  id: "0f0e0d0c-0000-4000-8000-0000000000aa",
  event: "alert.firing",
  severity: "critical",
  title: "Firing: App down",
  text: "web is not running.",
  url: "https://dash.example.com/apps/a1",
  fields: [{ name: "Where", value: "shop / production / web" }],
  at: AT,
  instance: { name: "Acme", url: "https://dash.example.com" },
  data: { alert: { id: "e1", metric: "down" }, app: { name: "web" }, service: null },
  ...over,
});

const res = (status: number, body: unknown = "", headers: Record<string, string> = {}): HttpResponse => ({
  status, headers, body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
});
function fake(fn: (r: HttpRequest) => HttpResponse | Promise<HttpResponse>) {
  const calls: HttpRequest[] = [];
  const http: HttpClient = async (r) => {
    calls.push(r);
    return fn(r);
  };
  return { http, calls };
}

describe("Discord", () => {
  it("sends an embed in the severity's colour, with fields, a link and no mentions", () => {
    const b = discordBody(msg()) as { username: string; allowed_mentions: unknown; embeds: Array<Record<string, unknown>> };
    expect(b.username).toBe("Dockify");
    expect(b.allowed_mentions).toEqual({ parse: [] });
    expect(b.embeds[0]).toMatchObject({ title: "Firing: App down", url: "https://dash.example.com/apps/a1", color: 0xd9534f, timestamp: AT, footer: { text: "Acme" } });
    expect(b.embeds[0]!.fields).toEqual([{ name: "Where", value: "shop / production / web", inline: true }]);
  });
  it("escapes markdown, masked links and mentions in outside text", () => {
    const d = (discordBody(msg({ text: HOSTILE })) as { embeds: Array<{ description: string }> }).embeds[0]!.description;
    expect(d).toContain("\\@everyone");
    expect(d).toContain("\\[click\\](https://evil.example)");
    expect(d).toContain("\\*bold\\*");
    expect(discordSafe("a|b~c")).toBe("a\\|b\\~c");
  });
});

describe("Slack", () => {
  it("sends Block Kit with a header, text, fields, a button and a plain fallback", () => {
    const b = slackBody(msg()) as { text: string; blocks: Array<Record<string, unknown>> };
    expect(b.text).toBe("Firing: App down: web is not running.");
    expect(b.blocks.map((x) => x.type)).toEqual(["header", "section", "section", "actions", "context"]);
    expect(b.blocks[3]).toEqual({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in Dockify" }, url: "https://dash.example.com/apps/a1" }] });
  });
  it("escapes the three control characters, so no <!channel> or <@user> can form", () => {
    const b = JSON.stringify(slackBody(msg({ text: HOSTILE })));
    expect(b).not.toContain("<!channel>");
    expect(b).toContain("&lt;!channel&gt;");
    expect(slackSafe("a & b")).toBe("a &amp; b");
  });
  it("leaves out the button when there is no link", () => {
    const b = slackBody(msg({ url: null, fields: [] })) as { blocks: Array<{ type: string }> };
    expect(b.blocks.map((x) => x.type)).toEqual(["header", "section", "context"]);
  });
});

describe("Microsoft Teams", () => {
  it("sends an Adaptive Card in the message envelope Workflows and connectors take", () => {
    const b = teamsBody(msg()) as { type: string; attachments: Array<{ contentType: string; content: { type: string; version: string; body: Array<Record<string, unknown>>; actions: unknown[] } }> };
    expect(b.type).toBe("message");
    const card = b.attachments[0]!;
    expect(card.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.content).toMatchObject({ type: "AdaptiveCard", version: "1.4" });
    expect(card.content.body[0]).toMatchObject({ type: "TextBlock", weight: "Bolder", color: "Attention" });
    expect(card.content.body[2]).toEqual({ type: "FactSet", facts: [{ title: "Where", value: "shop / production / web" }] });
    expect(card.content.actions).toEqual([{ type: "Action.OpenUrl", title: "Open in Dockify", url: "https://dash.example.com/apps/a1" }]);
  });
  it("escapes the markdown a card would render", () => {
    expect(teamsSafe("[x](https://evil.example)")).toBe("\\[x\\]\\(https://evil.example\\)");
    expect(JSON.stringify(teamsBody(msg({ text: HOSTILE })))).not.toContain("[click](");
  });
});

describe("Google Chat", () => {
  it("sends a card with a header, the text, fields and a button, and a plain fallback", () => {
    const b = googleChatBody(msg()) as { fallbackText: string; cardsV2: Array<{ cardId: string; card: { header: unknown; sections: Array<{ widgets: unknown[] }> } }> };
    expect(b.fallbackText).toBe("Firing: App down");
    expect(b.cardsV2[0]!.card.header).toEqual({ title: "Firing: App down", subtitle: "Acme" });
    expect(b.cardsV2[0]!.card.sections[0]!.widgets).toEqual([
      { textParagraph: { text: "web is not running." } },
      { decoratedText: { topLabel: "Where", text: "shop / production / web" } },
      { buttonList: { buttons: [{ text: "Open in Dockify", onClick: { openLink: { url: "https://dash.example.com/apps/a1" } } }] } },
    ]);
  });
  it("escapes the HTML a card renders", () => {
    expect(JSON.stringify(googleChatBody(msg({ text: HOSTILE })))).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("Telegram", () => {
  it("sends HTML to the chat, with previews off", () => {
    const b = telegramBody(msg(), "-100123") as { chat_id: string; text: string; parse_mode: string; link_preview_options: unknown };
    expect(b).toMatchObject({ chat_id: "-100123", parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    expect(b.text).toBe("<b>Firing: App down</b>\nweb is not running.\n<b>Where:</b> shop / production / web\n<a href=\"https://dash.example.com/apps/a1\">Open in Dockify</a>\n<i>Acme</i>");
  });
  it("escapes HTML in outside text and stays under Telegram's 4096 characters", () => {
    const b = telegramBody(msg({ text: `${HOSTILE}${"x".repeat(5000)}` }), "1") as { text: string };
    expect(b.text).toContain("&lt;b&gt;x&lt;/b&gt; &amp;");
    expect(b.text.length).toBeLessThanOrEqual(4096);
  });
});

describe("Mattermost and Rocket.Chat", () => {
  it("send Slack-compatible attachments in the severity's colour", () => {
    expect(mattermostBody(msg())).toMatchObject({ username: "Dockify", attachments: [{ color: "#D9534F", title: "Firing: App down", title_link: "https://dash.example.com/apps/a1", fields: [{ short: true, title: "Where" }] }] });
    expect(rocketChatBody(msg())).toMatchObject({ alias: "Dockify", text: "*Firing: App down*", attachments: [{ color: "#D9534F", title: "Open in Dockify", title_link: "https://dash.example.com/apps/a1" }] });
  });
  it("break every @mention without changing how the text reads", () => {
    expect(chatSafe("@all @here @channel @sam")).toBe("@​all @​here @​channel @​sam");
    expect(JSON.stringify(mattermostBody(msg({ text: "@all down" })))).not.toMatch(/@all/);
    expect(JSON.stringify(rocketChatBody(msg({ text: "@here down" })))).not.toMatch(/@here/);
  });
  it("leave no masked link, image, HTML or code span in outside text", () => {
    const line = "[Session expired, sign in](https://evil.example) ![x](https://evil.example/p.png) <https://evil.example|here> `x` a\\b";
    expect(chatSafe(line)).toBe("\\[Session expired, sign in\\]\\(https://evil.example\\) \\!\\[x\\]\\(https://evil.example/p.png\\) \\<​https://evil.example|here\\> \\`x\\` a\\\\b");
    const hostile = msg({ title: line, text: line, fields: [{ name: line, value: line }] });
    for (const body of [mattermostBody(hostile), rocketChatBody(hostile)]) {
      // Every string as the provider receives it.
      const seen: string[] = [];
      JSON.stringify(body, (_k, v: unknown) => (typeof v === "string" && seen.push(v), v));
      for (const bad of ["](", "<http", " `x` ", " ![", " [Session"]) expect(seen.join(" | "), bad).not.toContain(bad);
    }
    expect(chatSafe("plain words, 85% full")).toBe("plain words, 85% full");
  });
});

describe("ntfy", () => {
  it("sends plain text with the title, priority, tags and link as headers", () => {
    const r = ntfyRequest(msg());
    expect(r.body).toBe("web is not running.\nWhere: shop / production / web");
    expect(r.headers).toEqual({ "Content-Type": "text/plain; charset=utf-8", Title: "Firing: App down", Priority: "5", Tags: "rotating_light", Click: "https://dash.example.com/apps/a1" });
    expect(ntfyRequest(msg({ severity: "success" })).headers).toMatchObject({ Priority: "3", Tags: "white_check_mark" });
  });
  it("keeps header values on one line and encodes non-ASCII text", () => {
    expect(headerValue("Firing\r\nX-Injected: 1")).toBe("Firing X-Injected: 1");
    expect(headerValue("Bäckerei down")).toBe(`=?UTF-8?B?${Buffer.from("Bäckerei down").toString("base64")}?=`);
  });
  it("sends the access token as a bearer, when the topic needs one", () => {
    const r = prepare({ provider: "ntfy", url: "https://ntfy.sh/topic", secret: "tk_abcdefghijklmnop" }, msg());
    expect(r.headers.Authorization).toBe("Bearer tk_abcdefghijklmnop");
    expect(prepare({ provider: "ntfy", url: "https://ntfy.sh/topic" }, msg()).headers.Authorization).toBeUndefined();
  });
});

describe("the generic webhook", () => {
  it("keeps the alert shape earlier versions sent, and adds the documented fields", () => {
    const b = genericBody(msg()) as Record<string, unknown>;
    expect(b).toMatchObject({
      version: 1, id: "0f0e0d0c-0000-4000-8000-0000000000aa", event: "alert.firing", occurredAt: AT, severity: "critical", title: "Firing: App down",
      alert: { id: "e1", metric: "down" }, app: { name: "web" }, service: null, instance: { name: "Acme", url: "https://dash.example.com" },
    });
  });
  it("signs the timestamp and the exact body, and a receiver can verify it", () => {
    const secret = newSigningSecret();
    expect(secret).toMatch(/^dkwh_[\w-]{43}$/);
    const now = 1_762_423_200_000;
    const r = prepare({ provider: "generic", url: "https://hooks.example.com/x", secret }, msg(), now);
    expect(r.headers).toMatchObject({ "Content-Type": "application/json", "X-Dockify-Event": "alert.firing", "X-Dockify-Delivery": msg().id, "X-Dockify-Timestamp": String(now / 1000) });
    const expected = `sha256=${createHmac("sha256", secret).update(`${now / 1000}.${r.body}`).digest("hex")}`;
    expect(r.headers["X-Dockify-Signature"]).toBe(expected);
    expect(verifySignature(secret, r.body, r.headers["X-Dockify-Timestamp"], r.headers["X-Dockify-Signature"], now + 60_000)).toBe(true);
  });
  it("refuses a changed body, another secret, an old timestamp and junk", () => {
    const secret = "s".repeat(32);
    const ts = 1_762_423_200;
    const body = '{"a":1}';
    const sig = sign(secret, ts, body);
    const now = ts * 1000;
    expect(verifySignature(secret, '{"a":2}', String(ts), sig, now)).toBe(false);
    expect(verifySignature("t".repeat(32), body, String(ts), sig, now)).toBe(false);
    expect(verifySignature(secret, body, String(ts), sig, now + 301_000)).toBe(false);
    expect(verifySignature(secret, body, String(ts), "sha256=zz", now)).toBe(false);
    expect(verifySignature(secret, body, undefined, sig, now)).toBe(false);
  });
});

describe("delivery", () => {
  const SLACK = { provider: "slack" as const, url: ["https://hooks.slack.com/services", "T0ABCDEF12", "B0ABCDEF34", "abcdEFGHijklMNOPqrstUVWX"].join("/") };

  it("posts the prepared request with a timeout and a capped answer", async () => {
    const { http, calls } = fake(() => res(200, "ok"));
    expect(await deliver(http, SLACK, msg())).toMatchObject({ ok: true, status: 200 });
    expect(calls[0]).toMatchObject({ method: "POST", url: SLACK.url, timeoutMs: 10_000, maxBytes: 64 * 1024 });
    expect(JSON.parse(String(calls[0]!.body))).toMatchObject({ blocks: expect.any(Array) });
  });

  it("retries 429 and 5xx, stops on 4xx and on a redirect it will not follow", async () => {
    for (const [status, retry] of [[429, true], [502, true], [408, true], [404, false], [400, false], [301, false]] as const) {
      const out = await deliver(fake(() => res(status)).http, SLACK, msg());
      expect(out, String(status)).toMatchObject({ ok: false, retry, status });
    }
    expect(classifyStatus(204)).toBe("ok");
  });

  it("names the provider's own short reason, never the URL or its token", async () => {
    const out = await deliver(fake(() => res(404, "no_service")).http, SLACK, msg());
    expect(out).toMatchObject({ ok: false, reason: "Slack answered 404 (no_service)" });
    const tg = await deliver(fake(() => res(400, { ok: false, description: "Bad Request: chat not found" })).http, { provider: "telegram", url: "https://api.telegram.org/bot123:SECRETtokenSECRETtoken/sendMessage", chatId: "1" }, msg());
    expect(tg).toMatchObject({ reason: "Telegram answered 400 (Bad Request: chat not found)" });
    expect(JSON.stringify(tg)).not.toContain("SECRET");
  });

  it("never echoes a generic endpoint's answer", async () => {
    const out = await deliver(fake(() => res(400, "your token abc123 is wrong")).http, { provider: "generic", url: "https://hooks.example.com/x?token=abc123" }, msg());
    expect(out).toMatchObject({ ok: false, reason: "Webhook answered 400" });
    expect(JSON.stringify(out)).not.toContain("abc123");
  });

  it("refuses private and metadata addresses through net-guard, for good", async () => {
    const resolver = (ip: string) => (_h: string, cb: (e: NodeJS.ErrnoException | null, a: Array<{ address: string; family: number }>) => void) => cb(null, [{ address: ip, family: 4 }]);
    for (const ip of ["10.0.0.5", "169.254.169.254", "127.0.0.1", "100.100.100.200"]) {
      const out = await deliver(createHttpClient(resolver(ip)), { provider: "generic", url: "https://hooks.example.com/x" }, msg());
      expect(out, ip).toMatchObject({ ok: false, retry: false });
      if (!out.ok) expect(out.reason, ip).toMatch(/non-public address/);
    }
    const http = await deliver(createHttpClient(), { provider: "generic", url: "http://hooks.example.com/x" }, msg());
    expect(http).toMatchObject({ ok: false, retry: false, reason: "Use an https URL" });
  });

  it("retries an endpoint that cannot be reached", async () => {
    const down: HttpClient = async () => {
      throw new Error("socket hang up");
    };
    expect(await deliver(down, SLACK, msg())).toMatchObject({ ok: false, retry: true, reason: "Slack could not be reached" });
  });
});

describe("messages", () => {
  it("round trips through a job payload, and refuses a tampered one", () => {
    const m = msg();
    expect(parseNotifyMessage(JSON.parse(JSON.stringify(m)))).toEqual(m);
    expect(parseNotifyMessage({ ...m, event: "pwn" })).toBeNull();
    expect(parseNotifyMessage({ ...m, url: "javascript:alert(1)" })).toBeNull();
    expect(parseNotifyMessage({ ...m, fields: "x" })).toBeNull();
    expect(parseNotifyMessage(null)).toBeNull();
  });
  it("says what the test is for", () => {
    const t = testMessage("0f0e0d0c-0000-4000-8000-0000000000ab", { name: "Acme", url: "https://dash.example.com" }, new Date(AT));
    expect(t).toMatchObject({ event: "test", severity: "info", title: "Test notification", url: "https://dash.example.com", at: AT });
    expect(t.text).not.toMatch(/[\u2013\u2014]/);
  });
});
