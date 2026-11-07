import { describe, expect, it } from "vitest";
import { DOMAIN_CHECK_PREFIX, domainCheckAnswer, domainCheckToken, sameCheckValue } from "@dockify/crypto";
import { nodeProbeFetch, probeDomain, type ProbeAnswer, type ProbeFetch } from "./probe.ts";

const SECRET = "internal-channel-secret-for-tests-0123456789";
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const HOST = "shop.example.com";

/**
 * This server as the api answers (modules/domains/check-route.ts): the answer for a host's own
 * token, an empty 404 for anything else. `domains` maps a hostname to its domain id.
 */
function server(domains: Record<string, string>, secret = SECRET) {
  return (url: URL): ProbeAnswer => {
    const token = url.pathname.startsWith(DOMAIN_CHECK_PREFIX) ? url.pathname.slice(DOMAIN_CHECK_PREFIX.length) : "";
    const id = domains[url.hostname];
    if (!id || !sameCheckValue(token, domainCheckToken(secret, id, url.hostname))) return { status: 404, location: null, body: "" };
    return { status: 200, location: null, body: domainCheckAnswer(secret, url.hostname, token) };
  };
}

/** A fetch that records each URL asked, answering from `answer`. */
function recorder(answer: (url: URL, n: number) => ProbeAnswer | Promise<ProbeAnswer>) {
  const asked: string[] = [];
  const fetch: ProbeFetch = async (url) => {
    asked.push(url.href);
    return answer(url, asked.length);
  };
  return { fetch, asked };
}

const toHttps = (url: URL): ProbeAnswer => ({ status: 308, location: `https://${url.host}${url.pathname}`, body: "" });

describe("probeDomain", () => {
  it("passes when the domain answers with this server's value over http", async () => {
    const { fetch, asked } = recorder(server({ [HOST]: ID }));
    expect(await probeDomain({ host: HOST, domainId: ID, secret: SECRET, fetch })).toEqual({ status: "passed", detail: `Asking ${HOST} reached this server.` });
    expect(asked).toEqual([`http://${HOST}${DOMAIN_CHECK_PREFIX}${domainCheckToken(SECRET, ID, HOST)}`]);
  });

  it("follows one redirect to https on the same name and path, as a proxy's always-https or Traefik's own does", async () => {
    const here = server({ [HOST]: ID });
    const { fetch, asked } = recorder((url) => (url.protocol === "http:" ? toHttps(url) : here(url)));
    expect(await probeDomain({ host: HOST, domainId: ID, secret: SECRET, fetch })).toEqual({ status: "passed", detail: `Asking ${HOST} reached this server over https.` });
    expect(asked.map((u) => new URL(u).protocol)).toEqual(["http:", "https:"]);
  });

  it("never follows a redirect to another name, another path or another port", async () => {
    const token = domainCheckToken(SECRET, ID, HOST);
    for (const location of [
      `https://evil.example.net${DOMAIN_CHECK_PREFIX}${token}`,
      `https://${HOST}/somewhere-else`,
      `https://${HOST}:8443${DOMAIN_CHECK_PREFIX}${token}`,
      `http://${HOST}${DOMAIN_CHECK_PREFIX}${token}`,
    ]) {
      const { fetch, asked } = recorder(() => ({ status: 302, location, body: "" }));
      const r = await probeDomain({ host: HOST, domainId: ID, secret: SECRET, fetch });
      expect(r.status, location).toBe("failed");
      expect(r.detail, location).toMatch(/redirected to/);
      expect(asked, location).toHaveLength(1);
    }
  });

  it("fails a domain that echoes the token back, or answers for another domain's token", async () => {
    // An echo: whatever answers repeats the last path segment. The answer is never the token.
    const echo = recorder((url) => ({ status: 200, location: null, body: url.pathname.slice(DOMAIN_CHECK_PREFIX.length) }));
    expect(await probeDomain({ host: HOST, domainId: ID, secret: SECRET, fetch: echo.fetch })).toEqual({ status: "failed", detail: `Asking ${HOST} did not reach this server: the answer was not this server's.` });
    // This server holds the name for another domain row: the token for this row is not its token.
    const taken = recorder(server({ [HOST]: OTHER }));
    expect((await probeDomain({ host: HOST, domainId: ID, secret: SECRET, fetch: taken.fetch })).detail).toMatch(/it answered 404\.$/);
  });

  it("fails a domain served by another Dockify, whose secret differs", async () => {
    const elsewhere = recorder(server({ [HOST]: ID }, "another-servers-secret-0123456789abcdef"));
    expect((await probeDomain({ host: HOST, domainId: ID, secret: SECRET, fetch: elsewhere.fetch })).status).toBe("failed");
  });

  it("says why, for the proxy settings that cannot work", async () => {
    // Cloudflare's Flexible mode: plain http to this server, which redirects to https, forever.
    const loop = recorder((url) => toHttps(url));
    expect((await probeDomain({ host: HOST, domainId: ID, secret: SECRET, fetch: loop.fetch })).detail).toMatch(/redirects in a loop\. Behind Cloudflare, set SSL\/TLS to Full\.$/);
    // Full (strict) before this server holds a certificate for the name.
    const strict = recorder((url) => (url.protocol === "http:" ? toHttps(url) : { status: 526, location: null, body: "" }));
    expect((await probeDomain({ host: HOST, domainId: ID, secret: SECRET, fetch: strict.fetch })).detail).toMatch(/\(526\)\. Set SSL\/TLS to Full until the certificate is active\.$/);
  });

  it("turns a failed connection into one line, and marks the ones that say nothing about the name", async () => {
    const err = (code: string, message = "x") => recorder(() => Promise.reject(Object.assign(new Error(message), { code })));
    const run = (r: ReturnType<typeof err>) => probeDomain({ host: HOST, domainId: ID, secret: SECRET, fetch: r.fetch });
    const blocked = await run(err("EBLOCKED", "Refused to connect: shop.example.com resolves to a non-public address"));
    expect(blocked.detail).toMatch(/it resolves to an address that is not public\.$/);
    expect(blocked.transient).toBeUndefined();
    expect((await run(err("EBLOCKED", "shop.example.com did not resolve"))).detail).toMatch(/it does not resolve\.$/);
    expect((await run(err("ENOTFOUND"))).detail).toMatch(/it does not resolve\.$/);
    expect((await run(err("ENOTFOUND"))).transient).toBeUndefined();
    const refused = await run(err("ECONNREFUSED"));
    expect(refused.detail).toMatch(/the connection was refused\.$/);
    expect(refused.transient).toBe(true);
    expect((await run(err("ETIMEDOUT", "no answer within 8 s"))).transient).toBe(true);
  });

  it("marks a proxy's 5xx as no answer, and a wrong answer or a 404 as an answer", async () => {
    const status = (n: number) => recorder(() => ({ status: n, location: null, body: "" }));
    const run = async (n: number) => (await probeDomain({ host: HOST, domainId: ID, secret: SECRET, fetch: status(n).fetch })).transient;
    expect(await run(522)).toBe(true);
    expect(await run(502)).toBe(true);
    expect(await run(526)).toBe(true);
    expect(await run(404)).toBeUndefined();
    expect(await run(200)).toBeUndefined();
  });

  it("asks only names: never an address, and never anything a name could smuggle in", async () => {
    for (const host of ["203.0.113.7", "[2001:db8::1]", "2001:db8::1", "shop.example.com:8080", "shop.example.com/x", "user@shop.example.com"]) {
      const { fetch, asked } = recorder(server({}));
      expect((await probeDomain({ host, domainId: ID, secret: SECRET, fetch })).status, host).toBe("failed");
      expect(asked, host).toEqual([]);
    }
  });

  it("connects through the guarded lookup, so a name that leads inside is never asked", async () => {
    const r = await probeDomain({ host: "localhost", domainId: ID, secret: SECRET, fetch: nodeProbeFetch, timeoutMs: 2_000 });
    expect(r).toEqual({ status: "failed", detail: "Asking localhost did not reach this server: it resolves to an address that is not public." });
  });
});
