/**
 * The webhook module's checks, without a database: how an endpoint is resolved and refused, what
 * happens to the second secret, and how a logo link or upload is fetched and checked. The full
 * flows through the routes run against Postgres in webhooks.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import { OutboundError, type HttpClient, type HttpRequest, type HttpResponse } from "@dockify/net-guard";
import { HttpError } from "../../errors.ts";
import { resolveEndpoint, resolveLogo, secondFor } from "./webhooks.ts";

const SLACK = ["https://hooks.slack.com/services", "T0ABCDEF12", "B0ABCDEF34", "abcdEFGHijklMNOPqrstUVWX"].join("/");
const DISCORD = `https://discord.com/api/webhooks/123456789012345678/${"a1B2-c3_D4".repeat(7)}`;
const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

function refusal(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}
async function refusalOf(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("resolving an endpoint", () => {
  it("recognises the provider from the URL and normalises what is stored", () => {
    expect(resolveEndpoint({ url: `  ${SLACK}  ` })).toEqual({ provider: "slack", url: SLACK, host: "hooks.slack.com", chatId: null });
    expect(resolveEndpoint({ url: "https://HOOKS.example.com/x" })).toEqual({ provider: "generic", url: "https://hooks.example.com/x", host: "hooks.example.com", chatId: null });
  });

  it("keeps a chosen provider and checks the URL against it", () => {
    expect(resolveEndpoint({ provider: "mattermost", url: "https://chat.example.com/hooks/abc" }).provider).toBe("mattermost");
    expect(refusal(() => resolveEndpoint({ provider: "slack", url: "https://hooks.example.com/x" }))).toMatchObject({ status: 400, extra: { field: "url" } });
    expect(refusal(() => resolveEndpoint({ provider: "generic", url: DISCORD })).message).toMatch(/This is a Discord webhook URL/);
  });

  it("refuses what net-guard refuses: no IP address, no internal name, no http, no credentials", () => {
    for (const url of ["https://10.0.0.5/hook", "https://169.254.169.254/latest", "https://router.lan/x", "http://hooks.example.com/x", "https://u:p@hooks.example.com/x"]) {
      expect(refusal(() => resolveEndpoint({ url })), url).toMatchObject({ status: 400, extra: { field: "url" } });
    }
  });

  it("builds Telegram's endpoint from the token and chat fields, or a pasted bot URL", () => {
    expect(resolveEndpoint({ provider: "telegram", botToken: TOKEN, chatId: "-100123" })).toEqual({
      provider: "telegram", url: `https://api.telegram.org/bot${TOKEN}/sendMessage`, host: "api.telegram.org", chatId: "-100123",
    });
    expect(resolveEndpoint({ url: `https://api.telegram.org/bot${TOKEN}/sendMessage?chat_id=@dockify_ops` }).chatId).toBe("@dockify_ops");
    expect(refusal(() => resolveEndpoint({ provider: "telegram", botToken: TOKEN }))).toMatchObject({ extra: { field: "chatId" } });
    expect(refusal(() => resolveEndpoint({ provider: "telegram", chatId: "1" }))).toMatchObject({ extra: { field: "botToken" } });
  });

  it("keeps the stored Telegram token when only the chat changes", () => {
    const current = { provider: "telegram" as const, url: `https://api.telegram.org/bot${TOKEN}/sendMessage`, host: "api.telegram.org", chatId: "1" };
    expect(resolveEndpoint({ provider: "telegram", chatId: "2" }, current)).toMatchObject({ url: current.url, chatId: "2" });
  });

  it("gives a bot token and a chat to Telegram only", () => {
    expect(refusal(() => resolveEndpoint({ url: SLACK, chatId: "1" })).message).toMatch(/Only a Telegram webhook/);
  });

  it("asks for a URL when there is nothing to go on", () => {
    expect(refusal(() => resolveEndpoint({})).message).toBe("Paste the webhook URL");
  });
});

describe("the second secret", () => {
  it("makes a signing secret for a new generic webhook, keeps it, rotates it on request", () => {
    const made = secondFor("generic", {});
    expect(made).toMatchObject({ action: "set", generated: expect.stringMatching(/^dkwh_/) });
    expect(secondFor("generic", {}, { provider: "generic", hasSecret: true })).toEqual({ action: "keep" });
    const rotated = secondFor("generic", { signingSecret: "rotate" }, { provider: "generic", hasSecret: true });
    expect(rotated).toMatchObject({ action: "set", generated: expect.stringMatching(/^dkwh_/) });
    expect(secondFor("generic", { signingSecret: "x".repeat(20) })).toEqual({ action: "set", value: "x".repeat(20), generated: null });
  });

  it("keeps, sets and drops an ntfy access token", () => {
    expect(secondFor("ntfy", {})).toEqual({ action: "keep" });
    expect(secondFor("ntfy", { accessToken: "tk_abcdefgh" })).toEqual({ action: "set", value: "tk_abcdefgh", generated: null });
    expect(secondFor("ntfy", { accessToken: null }, { provider: "ntfy", hasSecret: true })).toEqual({ action: "drop" });
  });

  it("drops a secret a new provider has no use for, and refuses one given to the wrong provider", () => {
    expect(secondFor("slack", {}, { provider: "generic", hasSecret: true })).toEqual({ action: "drop" });
    expect(refusal(() => secondFor("slack", { signingSecret: "x".repeat(20) })).message).toMatch(/Only a generic webhook/);
    expect(refusal(() => secondFor("generic", { accessToken: "tk_abcdefgh" })).message).toMatch(/Only an ntfy webhook/);
  });
});

describe("logos", () => {
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  const SVG = '<svg viewBox="0 0 24 24" onload="alert(1)"><script>steal()</script><image href="https://evil.example/x"/><path d="M2 2h20v20H2z"/></svg>';
  type Route = { status: number; body?: Buffer | string; location?: string } | Error;
  const fake = (routes: Record<string, Route>) => {
    const asked: HttpRequest[] = [];
    const http: HttpClient = async (req) => {
      asked.push(req);
      const r = routes[req.url];
      if (!r) return { status: 404, headers: {}, body: Buffer.alloc(0) };
      if (r instanceof Error) throw r;
      const res: HttpResponse = { status: r.status, headers: r.location ? { location: r.location } : {}, body: Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body ?? "") };
      return res;
    };
    return { http, asked };
  };
  const never: HttpClient = async () => {
    throw new Error("must not fetch");
  };

  it("takes an upload, and stores an SVG only as its rebuild", async () => {
    const up = await resolveLogo(never, { choice: "upload", image: png(64, 64).toString("base64") });
    expect(up).toMatchObject({ mime: "image/png", width: 64, height: 64, origin: null, link: null });
    const svg = await resolveLogo(never, { choice: "upload", image: Buffer.from(SVG).toString("base64") });
    const text = Buffer.from(svg.data).toString("utf8");
    expect(svg.mime).toBe("image/svg+xml");
    expect(text).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>');
    expect(svg.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("downloads a link once, through redirects that stay https, and keeps where it came from", async () => {
    const { http, asked } = fake({
      "https://acme.example.com/logo": { status: 301, location: "https://cdn.example.com/acme/logo.svg" },
      "https://cdn.example.com/acme/logo.svg": { status: 200, body: SVG },
    });
    const got = await resolveLogo(http, { choice: "url", url: "https://acme.example.com/logo" });
    expect(got).toMatchObject({ mime: "image/svg+xml", link: "https://acme.example.com/logo", origin: "https://cdn.example.com/acme/logo.svg" });
    expect(asked.map((r) => r.url)).toEqual(["https://acme.example.com/logo", "https://cdn.example.com/acme/logo.svg"]);
    expect(asked[0]).toMatchObject({ method: "GET", maxBytes: 128 * 1024, timeoutMs: 8_000 });
  });

  it("refuses a redirect to http, a private link, an error answer, an HTML page and an oversized file", async () => {
    const cases: Array<[Record<string, Route>, string, RegExp]> = [
      [{ "https://a.example.com/l": { status: 302, location: "http://a.example.com/l.png" } }, "https://a.example.com/l", /redirects somewhere/],
      [{}, "https://10.1.2.3/logo.png", /public address/],
      [{}, "https://intranet.corp/logo.png", /public address/],
      [{ "https://a.example.com/l": { status: 404 } }, "https://a.example.com/l", /answered 404/],
      [{ "https://a.example.com/l": { status: 200, body: "<!doctype html><script>x()</script>" } }, "https://a.example.com/l", /PNG, JPEG/],
      [{ "https://a.example.com/l": new OutboundError("The response is too large", "TOO_LARGE") }, "https://a.example.com/l", /128 KB/],
      [{ "https://a.example.com/l": new OutboundError("Refused to connect: a.example.com resolves to a non-public address", "EBLOCKED") }, "https://a.example.com/l", /non-public/],
    ];
    for (const [routes, url, why] of cases) {
      const e = await refusalOf(resolveLogo(fake(routes).http, { choice: "url", url }));
      expect(e, url).toMatchObject({ status: 400, extra: { field: "logo" } });
      expect(e.message, url).toMatch(why);
    }
  });

  it("refuses bytes that are not base64 or not an image", async () => {
    expect((await refusalOf(resolveLogo(never, { choice: "upload", image: "AAAA=" }))).message).toMatch(/base64|PNG/);
    expect((await refusalOf(resolveLogo(never, { choice: "upload", image: Buffer.from("hello").toString("base64") }))).message).toMatch(/PNG, JPEG/);
  });
});
