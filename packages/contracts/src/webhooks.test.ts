import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WebhookCreateBody, WebhookPatchBody, WebhookTestBody } from "./integrations.ts";
import {
  checkWebhookUrl, detectWebhook, isWebhookProvider, telegramEndpoint, telegramFromUrl, WEBHOOK_PROVIDER_INFO, WEBHOOK_PROVIDERS,
  webhookSecretHint, webhookUrlProblem,
} from "./webhooks.ts";

const DISCORD = `https://discord.com/api/webhooks/123456789012345678/${"a1B2-c3_D4".repeat(7)}`;
const SLACK = ["https://hooks.slack.com/services", "T0ABCDEF12", "B0ABCDEF34", "abcdEFGHijklMNOPqrstUVWX"].join("/");
const TEAMS_CONNECTOR =
  "https://contoso.webhook.office.com/webhookb2/7ab7f2c6-5c5c-4b5b-9c7f-0f0f0f0f0f0f@72f988bf-86f1-41af-91ab-2d7cd011db47/IncomingWebhook/0123456789abcdef0123456789abcdef/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const TEAMS_WORKFLOW =
  "https://prod-12.westus.logic.azure.com:443/workflows/0123456789abcdef0123456789abcdef/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=AbCdEf0123456789wxyz";
const TEAMS_POWER_PLATFORM =
  "https://default0123456789abcdef0123456789ab.cd.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/0123456789abcdef0123456789abcdef/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=QrStUv0123456789";
const GCHAT = "https://chat.googleapis.com/v1/spaces/AAAAbcdEfGh/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=abcdEFGHijklMNOPqrstUVWXyz0123456789abcd%3D";
const TELEGRAM = "https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage?chat_id=-1001234567890";
const MATTERMOST = "https://chat.example.com/hooks/xr8xdc4uw7rh7mumgnuz5ub1ee";
const ROCKET = "https://rocket.example.com/hooks/aBcDeFgHiJkLmNoPq/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKl";
const NTFY = "https://ntfy.sh/dockify-alerts-x7";

describe("provider list", () => {
  it("names every provider once, with a label and a hint", () => {
    expect(WEBHOOK_PROVIDERS).toEqual(["discord", "slack", "teams", "google_chat", "telegram", "mattermost", "rocket_chat", "ntfy", "generic"]);
    for (const p of WEBHOOK_PROVIDERS) {
      expect(WEBHOOK_PROVIDER_INFO[p].label.length, p).toBeGreaterThan(1);
      expect(WEBHOOK_PROVIDER_INFO[p].paste, p).not.toMatch(/[\u2013\u2014]/);
    }
    expect(isWebhookProvider("slack")).toBe(true);
    expect(isWebhookProvider("pagerduty")).toBe(false);
  });
});

describe("detecting the provider from a pasted URL", () => {
  const cases: Array<[string, string, string]> = [
    [DISCORD, "discord", "exact"],
    [DISCORD.replace("discord.com", "discordapp.com"), "discord", "exact"],
    [DISCORD.replace("discord.com/api/", "canary.discord.com/api/v10/"), "discord", "exact"],
    [`${DISCORD}?thread_id=1234567890`, "discord", "exact"],
    [SLACK, "slack", "exact"],
    [SLACK.replace("hooks.slack.com", "hooks.slack-gov.com"), "slack", "exact"],
    [TEAMS_CONNECTOR, "teams", "exact"],
    [`${TEAMS_CONNECTOR}/V2abcdEFGH`, "teams", "exact"],
    [TEAMS_WORKFLOW, "teams", "likely"],
    [TEAMS_POWER_PLATFORM, "teams", "likely"],
    [GCHAT, "google_chat", "exact"],
    [TELEGRAM, "telegram", "exact"],
    ["https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "telegram", "exact"],
    [MATTERMOST, "mattermost", "likely"],
    ["https://example.com/mattermost/hooks/xr8xdc4uw7rh7mumgnuz5ub1ee", "mattermost", "likely"],
    [ROCKET, "rocket_chat", "likely"],
    [NTFY, "ntfy", "exact"],
    ["https://ntfy.example.com/alerts", "ntfy", "likely"],
    ["https://hooks.example.com/dockify", "generic", "fallback"],
    ["https://push.example.com/alerts", "generic", "fallback"],
  ];
  it.each(cases)("%s is %s (%s)", (url, provider, confidence) => {
    expect(detectWebhook(url)).toEqual({ provider, confidence });
  });

  it("trims what was pasted around the URL", () => {
    expect(detectWebhook(`  ${SLACK}\n`)).toEqual({ provider: "slack", confidence: "exact" });
  });
});

describe("hostile URLs", () => {
  it("never takes a lookalike host for the provider", () => {
    for (const url of [
      DISCORD.replace("discord.com", "discord.com.evil.io"),
      DISCORD.replace("discord.com", "evil-discord.com"),
      DISCORD.replace("discord.com", "discordcom.io"),
      SLACK.replace("hooks.slack.com", "hooks.slack.com.evil.io"),
      SLACK.replace("hooks.slack.com", "hooksslack.com"),
      GCHAT.replace("chat.googleapis.com", "chat.googleapis.com.evil.io"),
      TEAMS_CONNECTOR.replace("contoso.webhook.office.com", "contoso.webhook.office.com.evil.io"),
      TEAMS_CONNECTOR.replace("contoso.webhook.office.com", "webhook-office.com"),
      TELEGRAM.replace("api.telegram.org", "api.telegram.org.evil.io"),
    ]) {
      expect(detectWebhook(url)?.provider, url).toBe("generic");
    }
    // A host named ntfy.* is at most a guess at a self-hosted ntfy, never ntfy.sh itself.
    expect(detectWebhook(NTFY.replace("ntfy.sh", "ntfy.sh.evil.io"))).toEqual({ provider: "ntfy", confidence: "likely" });
  });

  it("does not take a homograph host for Discord, and shows its punycode", () => {
    // The second letter is a Cyrillic i.
    const d = checkWebhookUrl("https://dіscord.com/api/webhooks/123456789012345678/aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(d.ok && d.url.hostname).toMatch(/^xn--/);
    expect(detectWebhook("https://dіscord.com/api/webhooks/123456789012345678/aaaaaaaaaaaaaaaaaaaaaaaa")?.provider).toBe("generic");
    // A label that is not valid punycode is not a URL at all.
    expect(detectWebhook("https://xn--dscord-6ve.com/api/webhooks/123456789012345678/aaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
  });

  it("refuses credentials in the URL, whatever host they pretend to be", () => {
    for (const url of [
      DISCORD.replace("https://discord.com", "https://discord.com@evil.io"),
      SLACK.replace("https://", "https://user:pass@"),
      "https://hooks.slack.com:pw@evil.io/services/T0/B0/x",
    ]) {
      expect(detectWebhook(url), url).toBeNull();
      expect(webhookUrlProblem("generic", url), url).toMatch(/user name and password/);
    }
  });

  it("refuses IP addresses in every spelling the URL parser turns into one", () => {
    for (const url of ["https://127.0.0.1/hook", "https://2130706433/hook", "https://0x7f.1/hook", "https://127.1/hook", "https://[::1]/hook", "https://[fd00::1]/x", "https://169.254.169.254/latest/meta-data", "https://8.8.8.8/hook"]) {
      expect(detectWebhook(url), url).toBeNull();
      expect(webhookUrlProblem("generic", url), url).toMatch(/IP address/);
    }
  });

  it("refuses anything but https", () => {
    for (const url of [SLACK.replace("https:", "http:"), "ftp://hooks.example.com/x", "javascript:alert(1)", "data:text/plain,x", "file:///etc/passwd", "wss://hooks.example.com/x"]) {
      expect(detectWebhook(url), url).toBeNull();
    }
    expect(webhookUrlProblem("slack", SLACK.replace("https:", "http:"))).toBe("Use an https URL");
  });

  it("refuses internal names, a trailing dot, fragments, whitespace and backslashes", () => {
    for (const url of [
      "https://localhost/x", "https://metadata.google.internal/computeMetadata/v1", "https://router.lan/x", "https://nas.local/x", "https://intranet/x",
      "https://discord.com./api/webhooks/123456789012345678/aaaaaaaaaaaaaaaaaaaaaaaa", "https://hooks.example.com/x#frag",
      "https://hooks.example.com/a b", "https://hooks.example.com/\tx", "https://discord.com\\@evil.io/", "https://hooks.example.com/x\u0000",
    ]) {
      expect(detectWebhook(url), JSON.stringify(url)).toBeNull();
    }
  });

  it("does not take a provider's host on another port for that provider", () => {
    expect(detectWebhook(DISCORD.replace("discord.com", "discord.com:8443"))?.provider).toBe("generic");
    expect(webhookUrlProblem("discord", DISCORD.replace("discord.com", "discord.com:8443"))).toMatch(/Discord webhook URL/);
  });

  it("refuses an overlong URL", () => {
    expect(detectWebhook(`https://hooks.example.com/${"a".repeat(2100)}`)).toBeNull();
  });
});

describe("what each provider accepts", () => {
  it("takes only its own URL for a provider on fixed hosts", () => {
    expect(webhookUrlProblem("discord", DISCORD)).toBeNull();
    expect(webhookUrlProblem("discord", "https://hooks.example.com/x")).toMatch(/Discord webhook URL/);
    expect(webhookUrlProblem("slack", "https://hooks.example.com/x")).toMatch(/Slack incoming webhook/);
    expect(webhookUrlProblem("google_chat", SLACK)).toMatch(/Google Chat/);
    expect(webhookUrlProblem("telegram", "https://hooks.example.com/x")).toMatch(/Telegram/);
  });

  it("keeps an exact URL of a fixed host provider on that provider", () => {
    expect(webhookUrlProblem("generic", DISCORD)).toMatch(/This is a Discord webhook URL/);
    expect(webhookUrlProblem("mattermost", SLACK)).toMatch(/This is a Slack webhook URL/);
  });

  it("lets the owner pick any type for a self-hosted or unknown URL", () => {
    for (const p of ["teams", "mattermost", "rocket_chat", "ntfy", "generic"] as const) {
      expect(webhookUrlProblem(p, "https://hooks.example.com/x"), p).toBeNull();
    }
    expect(webhookUrlProblem("rocket_chat", MATTERMOST)).toBeNull();
    expect(webhookUrlProblem("generic", NTFY)).toBeNull();
  });
});

describe("Telegram", () => {
  it("reads the bot token and the chat from a pasted URL", () => {
    expect(telegramFromUrl(TELEGRAM)).toEqual({ token: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", chatId: "-1001234567890" });
    expect(telegramFromUrl("https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage?chat_id=@dockify_ops")).toMatchObject({ chatId: "@dockify_ops" });
    expect(telegramFromUrl("https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/")).toMatchObject({ chatId: null });
  });
  it("reads nothing from another host, a bad token or a bad chat", () => {
    expect(telegramFromUrl(TELEGRAM.replace("api.telegram.org", "api.telegram.org.evil.io"))).toBeNull();
    expect(telegramFromUrl("https://api.telegram.org/botnot-a-token/sendMessage")).toBeNull();
    expect(telegramFromUrl(`${TELEGRAM.split("?")[0]}?chat_id=1;drop`)).toMatchObject({ chatId: null });
    expect(telegramFromUrl(`${TELEGRAM}&other=1`)).toBeNull();
  });
  it("builds the endpoint from a token", () => {
    expect(telegramEndpoint("123:abc")).toBe("https://api.telegram.org/bot123:abc/sendMessage");
  });
});

describe("the hint shown back", () => {
  it("shows the last four of the secret part only", () => {
    expect(webhookSecretHint("discord", DISCORD)).toBe(DISCORD.slice(-4));
    expect(webhookSecretHint("slack", SLACK)).toBe("UVWX");
    expect(webhookSecretHint("google_chat", GCHAT)).toBe("bcd=");
    expect(webhookSecretHint("telegram", TELEGRAM)).toBe("Dsaw");
    expect(webhookSecretHint("teams", TEAMS_WORKFLOW)).toBe("wxyz");
    expect(webhookSecretHint("ntfy", NTFY)).toBe("s-x7");
  });
  it("shows nothing of a part too short to hide", () => {
    expect(webhookSecretHint("generic", "https://hooks.example.com/x")).toBe("");
    expect(webhookSecretHint("generic", "not a url")).toBe("");
  });
});

describe("request bodies", () => {
  it("takes a URL with or without a type, and a Telegram token and chat instead of a URL", () => {
    expect(WebhookCreateBody.safeParse({ url: SLACK }).success).toBe(true);
    expect(WebhookCreateBody.safeParse({ name: "Ops", provider: "telegram", botToken: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", chatId: "-100123" }).success).toBe(true);
  });
  it("refuses unknown keys, bad tokens, bad chats and short signing secrets", () => {
    expect(WebhookCreateBody.safeParse({ url: SLACK, secret: "x" }).success).toBe(false);
    expect(WebhookCreateBody.safeParse({ provider: "telegram", botToken: "nope", chatId: "1" }).success).toBe(false);
    expect(WebhookCreateBody.safeParse({ provider: "telegram", botToken: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", chatId: "1; DROP" }).success).toBe(false);
    expect(WebhookCreateBody.safeParse({ url: "https://hooks.example.com/x", signingSecret: "short" }).success).toBe(false);
    expect(WebhookCreateBody.safeParse({ url: "https://hooks.example.com/x", name: "<b>x</b>" }).success).toBe(false);
  });
  it("takes a logo as auto, a link or an upload", () => {
    expect(WebhookCreateBody.safeParse({ url: "https://hooks.example.com/x", logo: { choice: "url", url: "https://cdn.example.com/logo.svg" } }).success).toBe(true);
    expect(WebhookCreateBody.safeParse({ url: "https://hooks.example.com/x", logo: { choice: "url", url: "http://cdn.example.com/logo.png" } }).success).toBe(false);
    expect(WebhookCreateBody.safeParse({ url: "https://hooks.example.com/x", logo: { choice: "upload", image: "not base64!" } }).success).toBe(false);
  });
  it("rotates or replaces a signing secret on a patch", () => {
    expect(WebhookPatchBody.safeParse({ signingSecret: "rotate" }).success).toBe(true);
    expect(WebhookPatchBody.safeParse({ signingSecret: "x".repeat(32) }).success).toBe(true);
    expect(WebhookPatchBody.safeParse({ accessToken: null }).success).toBe(true);
  });
  it("tests a saved webhook by id, or a draft", () => {
    expect(WebhookTestBody.safeParse({ id: "00000000-0000-4000-8000-000000000000" }).success).toBe(true);
    expect(WebhookTestBody.safeParse({ url: SLACK }).success).toBe(true);
    expect(WebhookTestBody.safeParse({ id: "x" }).success).toBe(false);
  });
});

describe("the web's copy", () => {
  // apps/web is not a workspace member, so its add form carries this module as a file of its own.
  // Line endings aside, it must match byte for byte, or the form and the API would disagree on a URL.
  it("apps/web/lib/webhook-providers.ts is the same module", () => {
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(read("../../../apps/web/lib/webhook-providers.ts")).toBe(read("./webhooks.ts"));
  });
});
