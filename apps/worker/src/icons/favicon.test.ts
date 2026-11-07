import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { createHttpClient, OutboundError, type HttpClient, type HttpRequest } from "@dockify/net-guard";
import { findFavicon, parseIconLinks, rankIconLinks } from "./favicon.ts";
import { runIconFetch } from "./index.ts";

function png(w: number, h: number, pad = 0): Buffer {
  const b = Buffer.alloc(64 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function ico(size: number): Buffer {
  const b = Buffer.alloc(6 + 16 + 8);
  b.writeUInt16LE(1, 2);
  b.writeUInt16LE(1, 4);
  b[6] = size;
  b[7] = size;
  b.writeUInt32LE(8, 6 + 8);
  b.writeUInt32LE(22, 6 + 12);
  return b;
}

type Route = { status: number; body?: Buffer | string; headers?: Record<string, string> };

/** A fake client with the real one's size cap; it records every URL it was asked for. */
function fakeHttp(routes: Record<string, Route>) {
  const asked: string[] = [];
  const http: HttpClient = async (req: HttpRequest) => {
    asked.push(req.url);
    const r = routes[req.url];
    if (!r) return { status: 404, headers: {}, body: Buffer.alloc(0) };
    const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body ?? "");
    if (body.length > (req.maxBytes ?? Infinity)) throw new OutboundError("The response is too large", "TOO_LARGE");
    return { status: r.status, headers: r.headers ?? {}, body };
  };
  return { http, asked };
}

const page = (head: string) => ({ status: 200, body: `<!doctype html><html><head>${head}</head><body></body></html>` });

describe("parseIconLinks and rankIconLinks", () => {
  it("reads rel, sizes and type in any attribute order and quoting, and ranks rasters 64px and up first", () => {
    const links = parseIconLinks(`
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link href='/favicon-32.png' rel='icon' sizes='32x32' type='image/png'>
      <LINK REL="shortcut icon" HREF=/favicon.ico>
      <link rel="apple-touch-icon" href="/apple.png?v=1&amp;x=2">
      <link rel="icon" sizes="96x96 192x192" href="/icon-192.png">
      <link rel="stylesheet" href="/app.css">`);
    expect(links.map((l) => l.href)).toEqual(["/icon.svg", "/favicon-32.png", "/favicon.ico", "/apple.png?v=1&x=2", "/icon-192.png"]);
    expect(rankIconLinks(links).map((l) => l.href)).toEqual(["/apple.png?v=1&x=2", "/icon-192.png", "/favicon-32.png", "/favicon.ico"]);
  });
});

describe("findFavicon", () => {
  it("takes the best link on the primary domain and sniffs it", async () => {
    const icon = png(192, 192);
    const { http, asked } = fakeHttp({
      "https://shop.example.com/": page('<link rel="icon" href="/favicon.ico"><link rel="icon" sizes="192x192" href="/icon-192.png">'),
      "https://shop.example.com/icon-192.png": { status: 200, body: icon },
    });
    const r = await findFavicon(http, ["shop.example.com", "www.shop.example.com"]);
    expect(r).toMatchObject({ ok: true, url: "https://shop.example.com/icon-192.png", image: { mime: "image/png", width: 192 } });
    expect(asked).toEqual(["https://shop.example.com/", "https://shop.example.com/icon-192.png"]);
  });

  it("falls back to /favicon.ico when the page has no usable link or is down", async () => {
    const { http } = fakeHttp({
      "https://shop.example.com/": page('<link rel="icon" href="/icon.svg">'),
      "https://shop.example.com/favicon.ico": { status: 200, body: ico(32) },
    });
    expect(await findFavicon(http, ["shop.example.com"])).toMatchObject({ ok: true, url: "https://shop.example.com/favicon.ico", image: { mime: "image/x-icon" } });

    const down = fakeHttp({ "https://shop.example.com/favicon.ico": { status: 200, body: ico(48) } });
    expect(await findFavicon(down.http, ["shop.example.com"])).toMatchObject({ ok: true, image: { width: 48 } });
  });

  it("never requests a host the app does not own: other-host links and redirects are refused", async () => {
    const { http, asked } = fakeHttp({
      "https://shop.example.com/": page('<link rel="icon" sizes="64x64" href="https://cdn.evil.test/i.png"><link rel="icon" href="//169.254.169.254/latest">'),
      "https://shop.example.com/favicon.ico": { status: 302, headers: { location: "https://evil.test/favicon.ico" } },
    });
    const r = await findFavicon(http, ["shop.example.com"]);
    expect(r).toEqual({ ok: false, reason: "A redirect left the app's domains" });
    expect(asked.every((u) => u.startsWith("https://shop.example.com/"))).toBe(true);
  });

  it("follows a redirect that stays on the app's domains", async () => {
    const { http } = fakeHttp({
      "https://shop.example.com/": { status: 301, headers: { location: "https://www.shop.example.com/" } },
      "https://www.shop.example.com/": page('<link rel="icon" href="/f.png">'),
      "https://www.shop.example.com/f.png": { status: 200, body: png(32, 32) },
    });
    expect(await findFavicon(http, ["shop.example.com", "www.shop.example.com"])).toMatchObject({ ok: true, url: "https://www.shop.example.com/f.png" });
  });

  it("refuses an icon over 64 KB and bytes that are not a raster image, whatever the extension says", async () => {
    const big = fakeHttp({
      "https://shop.example.com/": page('<link rel="icon" href="/big.png">'),
      "https://shop.example.com/big.png": { status: 200, body: png(64, 64, 70 * 1024) },
      "https://shop.example.com/favicon.ico": { status: 200, body: png(64, 64, 64 * 1024) },
    });
    expect(await findFavicon(big.http, ["shop.example.com"])).toEqual({ ok: false, reason: "The favicon is larger than 64 KB" });

    const lying = fakeHttp({
      "https://shop.example.com/": page('<link rel="icon" href="/f.png">'),
      "https://shop.example.com/f.png": { status: 200, body: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>' },
      "https://shop.example.com/favicon.ico": { status: 200, body: "<!doctype html><title>Not found</title>" },
    });
    expect(await findFavicon(lying.http, ["shop.example.com"])).toEqual({ ok: false, reason: "The favicon is not a PNG, ICO, WebP or JPG image" });
  });

  it("refuses at connect time a domain that resolves to a private address (net-guard)", async () => {
    const http = createHttpClient((_host, cb) => cb(null, [{ address: "10.0.0.5", family: 4 }]));
    const r = await findFavicon(http, ["shop.example.com"]);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("non-public address") });
    expect(await findFavicon(createHttpClient(), ["localhost"])).toMatchObject({ ok: false, reason: "The host must be a public address" });
  });

  it("reports no domain when none is attached", async () => {
    expect(await findFavicon(fakeHttp({}).http, [])).toEqual({ ok: false, reason: "No domain is attached" });
  });
});

describe("icon_fetch job", () => {
  const APP = "0f0e0d0c-0000-4000-8000-0000000000aa";
  function fakeDb(kind = "frontend") {
    const writes: Array<{ op: string; data: unknown }> = [];
    const db = {
      app: {
        findUnique: async () => ({ id: APP, kind, primaryDomain: { hostname: "www.shop.example.com" }, domains: [{ hostname: "shop.example.com" }, { hostname: "www.shop.example.com" }] }),
        update: (q: { data: unknown }) => { writes.push({ op: "app", data: q.data }); return Promise.resolve(q); },
      },
      iconImage: { upsert: (q: { create: unknown }) => { writes.push({ op: "icon", data: q.create }); return Promise.resolve(q); } },
      $transaction: async (ops: unknown[]) => Promise.all(ops),
    } as unknown as Db;
    return { db, writes };
  }

  it("stores the favicon from the primary domain first and clears the error", async () => {
    const { db, writes } = fakeDb();
    const { http, asked } = fakeHttp({ "https://www.shop.example.com/favicon.ico": { status: 200, body: ico(32) } });
    await runIconFetch({ db, http }, { appId: APP });
    expect(asked[0]).toBe("https://www.shop.example.com/");
    expect(writes.find((w) => w.op === "icon")?.data).toMatchObject({ appId: APP, source: "favicon", mime: "image/x-icon", width: 32, origin: "https://www.shop.example.com/favicon.ico" });
    expect(writes.find((w) => w.op === "app")?.data).toMatchObject({ faviconError: null });
  });

  it("records why on failure and stores nothing, so the app keeps its tile", async () => {
    const { db, writes } = fakeDb();
    await runIconFetch({ db, http: fakeHttp({}).http }, { appId: APP });
    expect(writes).toEqual([{ op: "app", data: expect.objectContaining({ faviconError: "/favicon.ico answered 404" }) }]);
  });

  it("ignores a bad payload and a non-frontend app", async () => {
    const { db, writes } = fakeDb("backend");
    await runIconFetch({ db, http: fakeHttp({}).http }, { appId: "nope" });
    await runIconFetch({ db, http: fakeHttp({}).http }, { appId: APP });
    expect(writes).toEqual([]);
  });
});
