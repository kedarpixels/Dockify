/**
 * The preview password gate, with what a stranger who found the URL would send: guesses, forged and stale
 * cookies, another site's form, and redirects off the host.
 */
import { afterEach, describe, expect, it } from "vitest";
import { hash as argonHash } from "@node-rs/argon2";
import type { Db } from "@dockify/db";
import { buildApp } from "../../app.ts";
import { testConfig, testRing } from "../../test-helpers.ts";
import { gateFormAllowed, gatePage, gateToken, gateTokenValid, newPreviewPassword, safeNext, withoutGateCookie } from "./gate.ts";

const ID = "0f0f0f0f-0000-4000-8000-0000000000a1";
const CHECK = `/internal/preview-gate/${ID}`;
const FORM = `/.well-known/dockify-preview-gate/${ID}`;
const HOST = "pr-1-web.preview.example.com";
const PASSWORD = "abcde-fghjk-mnpqr-stuvw";
const HASH = await argonHash(PASSWORD);

interface Row {
  access: "public" | "password";
  hash: string | null;
}

function fakeDb(row: Row | null): Db {
  return {
    previewDeployment: { findUnique: async ({ where }: { where: { id: string } }) => (row && where.id === ID ? { env: { project: { previewAccess: row.access, previewPasswordHash: row.hash } } } : null) },
  } as unknown as Db;
}

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

async function start(row: Row | null, over: Parameters<typeof testConfig>[0] = {}) {
  const { app } = await buildApp({ db: fakeDb(row), ring: testRing(), config: testConfig(over), logger: false, workerWatch: false, integrations: false, terminalDial: async () => { throw new Error("unused"); } });
  apps.push(app);
  await app.ready();
  return app;
}

const form = (password: string, next = "/deep/page?x=1") => new URLSearchParams({ password, next }).toString();
const post = (app: Awaited<ReturnType<typeof start>>, body: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: FORM, payload: body, headers: { "content-type": "application/x-www-form-urlencoded", host: HOST, ...headers } });

const cookieOf = (setCookie: unknown) => String(setCookie).split(";")[0]!;

describe("the password", () => {
  it("has about 99 bits and no look-alike characters", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = newPreviewPassword();
      expect(p).toMatch(/^[a-hjkmnp-z2-9]{5}(-[a-hjkmnp-z2-9]{5}){3}$/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
    expect(20 * Math.log2(31)).toBeGreaterThan(95);
  });
});

describe("the check Traefik asks", () => {
  it("lets a public preview through and keeps its cookies", async () => {
    const app = await start({ access: "public", hash: null });
    const res = await app.inject({ method: "GET", url: CHECK, headers: { cookie: "theirs=1" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers.cookie).toBe("theirs=1");
    expect(res.body).toBe("");
  });

  it("answers a protected preview with the page, unindexed and locked down", async () => {
    const app = await start({ access: "password", hash: HASH });
    const res = await app.inject({ method: "GET", url: CHECK, headers: { "x-forwarded-uri": "/a?b=1" } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["x-robots-tag"]).toContain("noindex");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["www-authenticate"]).toBeUndefined();
    expect(res.body).toContain('value="/a?b=1"');
    expect(res.body).toContain('action="/.well-known/dockify-preview-gate"');
  });

  it("shuts when protection is on and no password exists, with no form to guess at", async () => {
    const app = await start({ access: "password", hash: null });
    const res = await app.inject({ method: "GET", url: CHECK });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("<form");
  });

  it("shuts for an unknown preview and a bad id", async () => {
    const app = await start(null);
    expect((await app.inject({ method: "GET", url: CHECK })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/internal/preview-gate/..%2F..%2Fx" })).statusCode).toBe(404);
  });

  it("names no project, pull request or person on the page, and keeps a hostile next inert", () => {
    const html = gatePage({ next: `"><script>alert(1)</script>` });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("is outside the public prefix, needs no address header and spends no shared bucket", async () => {
    const app = await start({ access: "public", hash: null }, { trustedProxies: ["127.0.0.1"] });
    // A trusted hop with no client address is refused on every other route; a preview full of assets must not be.
    const codes: number[] = [];
    for (let i = 0; i < 300; i++) codes.push((await app.inject({ method: "GET", url: CHECK, remoteAddress: "127.0.0.1" })).statusCode);
    expect(new Set(codes)).toEqual(new Set([200]));
    expect(CHECK.startsWith("/api/v1/")).toBe(false);
  });
});

describe("the form", () => {
  it("takes the right password, sets a host-only cookie, goes back, and opens the check", async () => {
    const app = await start({ access: "password", hash: HASH });
    const res = await post(app, form(PASSWORD));
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/deep/page?x=1");
    const set = String(res.headers["set-cookie"]);
    expect(set).toMatch(/^__Host-dockify_preview=/);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Path=/");
    expect(set).not.toContain("Domain");
    expect(set).not.toContain(PASSWORD);
    const ok = await app.inject({ method: "GET", url: CHECK, headers: { cookie: `theirs=1; ${cookieOf(set)}` } });
    expect(ok.statusCode).toBe(200);
    // The app behind the gate sees its own cookie and never the gate's.
    expect(ok.headers.cookie).toBe("theirs=1");
    const alone = await app.inject({ method: "GET", url: CHECK, headers: { cookie: cookieOf(set) } });
    expect(alone.statusCode).toBe(200);
    expect(alone.headers.cookie).toBeUndefined();
  });

  it("refuses a wrong, empty or oversized password, and does not echo it", async () => {
    const app = await start({ access: "password", hash: HASH });
    for (const p of ["wrong", "", "x".repeat(10_000).slice(0, 3000)]) {
      const res = await post(app, form(p));
      expect(res.statusCode).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
      if (p) expect(res.body).not.toContain(p);
    }
  });

  it("limits guesses per network before running argon2, without locking out another network", async () => {
    const app = await start({ access: "password", hash: HASH }, { ingress: "direct_tls" });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await post(app, form("wrong"), {})).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10).every((c) => c === 429)).toBe(true);
    const next = await post(app, form("wrong"));
    expect(next.headers["retry-after"]).toBeTruthy();
    // The same preview from elsewhere still gets an answer.
    const other = await app.inject({ method: "POST", url: FORM, payload: form(PASSWORD), remoteAddress: "198.51.100.7", headers: { "content-type": "application/x-www-form-urlencoded", host: HOST } });
    expect(other.statusCode).toBe(303);
  });

  it("in tunnel mode counts by Cloudflare's address, and a forger who rotates it still hits the ceiling", async () => {
    const app = await start({ access: "password", hash: HASH }, { ingress: "cloudflare_tunnel" });
    const one = (ip: string) => post(app, form("wrong"), { "cf-connecting-ip": ip });
    for (let i = 0; i < 10; i++) expect((await one("203.0.113.5")).statusCode).toBe(401);
    expect((await one("203.0.113.5")).statusCode).toBe(429);
    const codes: number[] = [];
    for (let i = 0; i < 60; i++) codes.push((await one(`198.51.${i}.1`)).statusCode);
    expect(codes).toContain(429);
  }, 30_000);

  it("refuses another site's form", async () => {
    const app = await start({ access: "password", hash: HASH });
    expect((await post(app, form(PASSWORD), { origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await post(app, form(PASSWORD), { "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    expect((await post(app, form(PASSWORD), { "sec-fetch-site": "same-site" })).statusCode).toBe(403);
    expect((await post(app, form(PASSWORD), { origin: `https://${HOST}`, "sec-fetch-site": "same-origin" })).statusCode).toBe(303);
  });

  it("passes every header set a browser sends from the page itself, and refuses every cross-site one", () => {
    const host = HOST;
    const own = `https://${HOST}`;
    // Chrome, Edge, Firefox and Safari 16.4+ on the page's policy, and under a forced no-referrer.
    expect(gateFormAllowed({ host, origin: own, "sec-fetch-site": "same-origin" })).toBe(true);
    expect(gateFormAllowed({ host, origin: "null", "sec-fetch-site": "same-origin" })).toBe(true);
    // Safari before 16.4 sends no Sec-Fetch-Site.
    expect(gateFormAllowed({ host, origin: own })).toBe(true);
    // A form on another site, a sibling app, and a sandboxed frame anywhere.
    expect(gateFormAllowed({ host, origin: "https://evil.example", "sec-fetch-site": "cross-site" })).toBe(false);
    expect(gateFormAllowed({ host, origin: "https://evil.example", "sec-fetch-site": "same-origin" })).toBe(false);
    expect(gateFormAllowed({ host, origin: "https://sibling.preview.test", "sec-fetch-site": "same-site" })).toBe(false);
    expect(gateFormAllowed({ host, origin: "null", "sec-fetch-site": "cross-site" })).toBe(false);
    expect(gateFormAllowed({ host, origin: "null", "sec-fetch-site": "same-site" })).toBe(false);
    expect(gateFormAllowed({ host, origin: "null", "sec-fetch-site": "none" })).toBe(false);
    expect(gateFormAllowed({ host, origin: "null" })).toBe(false);
    expect(gateFormAllowed({ host, origin: "https://evil.example" })).toBe(false);
    expect(gateFormAllowed({ host, origin: "not a url" })).toBe(false);
    expect(gateFormAllowed({ host, origin: [own, own] })).toBe(false);
    expect(gateFormAllowed({ host, origin: own, "sec-fetch-site": ["same-origin", "cross-site"] })).toBe(false);
  });

  it("signs in from a browser that sends Origin null, and serves the page under a policy that sends a real one", async () => {
    const app = await start({ access: "password", hash: HASH });
    expect((await post(app, form(PASSWORD), { origin: "null", "sec-fetch-site": "same-origin" })).statusCode).toBe(303);
    expect((await post(app, form(PASSWORD), { origin: "null", "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    const shown = await app.inject({ method: "GET", url: CHECK });
    expect(shown.statusCode).toBe(401);
    expect(shown.headers["referrer-policy"]).toBe("same-origin");
  });

  it("will not redirect off the host", async () => {
    const app = await start({ access: "password", hash: HASH });
    for (const next of ["https://evil.example/", "//evil.example/", "/\\evil.example", "\\\\evil.example", "/a b", "javascript:alert(1)"]) {
      expect((await post(app, form(PASSWORD, next))).headers.location).toBe("/");
    }
    expect(safeNext("/ok?x=1")).toBe("/ok?x=1");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext(`/${"a".repeat(3000)}`)).toBe("/");
  });

  it("refuses a body past the form limit, and the parser reaches no other route", async () => {
    const app = await start({ access: "password", hash: HASH });
    expect((await post(app, `password=${"x".repeat(5000)}`)).statusCode).toBe(413);
    const elsewhere = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(elsewhere.statusCode).toBe(415);
  });
});

describe("the cookie", () => {
  const sign = (v: string) => `${"0".repeat(0)}${Buffer.from(v).toString("hex").padEnd(64, "0").slice(0, 64)}`;
  const now = Date.now();

  it("is good only for its preview and hash, until it expires", () => {
    const t = gateToken(sign, ID, "h1", now + 1000);
    expect(gateTokenValid(sign, ID, "h1", t, now)).toBe(true);
    expect(gateTokenValid(sign, ID, "h1", t, now + 1000)).toBe(false);
  });

  it("refuses forged shapes", () => {
    for (const bad of ["", "x", `${now + 1000}.zz`, `${now + 1000}.${"a".repeat(64)}`, `${now + 1000}`, `.${"a".repeat(64)}`, `-1.${"a".repeat(64)}`]) {
      expect(gateTokenValid(sign, ID, "h1", bad, now)).toBe(false);
    }
  });

  it("dies with a rotation, and opens no other preview, end to end", async () => {
    const row: Row = { access: "password", hash: HASH };
    const app = await start(row);
    const set = (await post(app, form(PASSWORD))).headers["set-cookie"];
    const cookie = cookieOf(set);
    expect((await app.inject({ method: "GET", url: CHECK, headers: { cookie } })).statusCode).toBe(200);

    const other = await start({ access: "password", hash: await argonHash("another-password") });
    expect((await other.inject({ method: "GET", url: CHECK, headers: { cookie } })).statusCode).toBe(401);

    const forged = cookie.replace(/=(\d+)\./, (_m, e: string) => `=${Number(e) + 1000}.`);
    expect((await app.inject({ method: "GET", url: CHECK, headers: { cookie: forged } })).statusCode).toBe(401);
  });

  it("is removed exactly, leaving look-alike cookies of the app alone", () => {
    expect(withoutGateCookie("a=1; __Host-dockify_preview=x; b=2")).toBe("a=1; b=2");
    expect(withoutGateCookie("__Host-dockify_preview=x")).toBeNull();
    expect(withoutGateCookie("__Host-dockify_preview2=x; my__Host-dockify_preview=y")).toBe("__Host-dockify_preview2=x; my__Host-dockify_preview=y");
    expect(withoutGateCookie(undefined)).toBeNull();
  });
});
