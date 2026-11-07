import { describe, expect, it } from "vitest";
import { createClientIp } from "./client-ip.ts";
import { checkCsrf } from "./csrf.ts";
import { SubjectGuard } from "./ratelimit.ts";

const ORIGIN = "https://dockify.example.com";

describe("csrf", () => {
  it("lets safe methods through", () => {
    expect(checkCsrf("GET", { origin: "https://evil.example" }, ORIGIN).ok).toBe(true);
  });
  it("accepts the exact origin and same-origin fetches", () => {
    expect(checkCsrf("POST", { origin: ORIGIN }, ORIGIN).ok).toBe(true);
    expect(checkCsrf("POST", { "sec-fetch-site": "same-origin" }, ORIGIN).ok).toBe(true);
  });
  it("refuses prefix tricks, same-site and cross-site", () => {
    expect(checkCsrf("POST", { origin: `${ORIGIN}.evil.tld` }, ORIGIN).ok).toBe(false);
    expect(checkCsrf("POST", { "sec-fetch-site": "same-site" }, ORIGIN).ok).toBe(false);
    expect(checkCsrf("DELETE", { "sec-fetch-site": "cross-site", origin: ORIGIN }, ORIGIN).ok).toBe(false);
    expect(checkCsrf("POST", { origin: "null" }, ORIGIN).ok).toBe(false);
  });
  it("allows a non-browser caller with neither header", () => {
    expect(checkCsrf("POST", {}, ORIGIN).ok).toBe(true);
  });
});

describe("client ip", () => {
  const tunnel = createClientIp(["172.18.0.0/16"], "cloudflare_tunnel");
  const direct = createClientIp(["172.18.0.5", "172.18.0.6"], "direct_tls");

  it("ignores every header from an untrusted peer", () => {
    expect(tunnel("203.0.113.9", { "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "1.1.1.1" })).toBe("203.0.113.9");
    expect(direct("::ffff:203.0.113.9", { "x-forwarded-for": "1.1.1.1" })).toBe("203.0.113.9");
  });

  it("reads CF-Connecting-IP from the trusted web container in tunnel mode", () => {
    expect(tunnel("172.18.0.3", { "cf-connecting-ip": "198.51.100.7" })).toBe("198.51.100.7");
  });

  it("never reads CF-Connecting-IP in direct mode, where a client could set it", () => {
    expect(direct("172.18.0.5", { "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "198.51.100.7" })).toBe("198.51.100.7");
  });

  it("walks X-Forwarded-For right to left, so a prepended fake never wins", () => {
    // client sent "1.1.1.1", Traefik appended the real address, web appended Traefik.
    expect(direct("172.18.0.6", { "x-forwarded-for": "1.1.1.1, 198.51.100.7, 172.18.0.5" })).toBe("198.51.100.7");
  });

  it("falls back to the peer on garbage", () => {
    expect(direct("172.18.0.5", { "x-forwarded-for": "not-an-ip" })).toBe("172.18.0.5");
    expect(tunnel("172.18.0.3", { "cf-connecting-ip": "1.1.1.1, 2.2.2.2" })).toBe("172.18.0.3");
  });

  it("rejects a malformed trusted proxy entry at boot", () => {
    expect(() => createClientIp(["10.0.0.0/99"], "direct_tls")).toThrow();
    expect(() => createClientIp(["web"], "direct_tls")).toThrow();
  });
});

describe("subject guard", () => {
  it("locks a subject out after ten failures, but rate() ignores the lock", () => {
    const g = new SubjectGuard({ perMinute: 1000, burst: 1000 });
    for (let i = 0; i < 10; i++) g.failed("s", 0);
    expect(g.check("s", 1)).toBeGreaterThan(0);
    expect(g.rate("s", 1)).toBeNull();
    g.succeeded("s");
    expect(g.check("s", 2)).toBeNull();
  });
});
