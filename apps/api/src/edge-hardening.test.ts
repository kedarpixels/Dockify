/**
 * Extra edge-primitive cases beyond edge.test.ts. For CSRF: the Sec-Fetch-Site "none" allowance,
 * duplicate (array) headers a request smuggler could inject, method-case folding, and the rule that
 * Origin and Sec-Fetch-Site are each checked independently. For the client resolver: the IPv6 and
 * IPv4-mapped sides of the trusted-proxy list, which edge.test.ts only exercises over IPv4.
 */
import { describe, expect, it } from "vitest";
import { createClientResolver } from "./client-ip.ts";
import { checkCsrf } from "./csrf.ts";

const ORIGIN = "https://dockify.example.com";

describe("csrf hardening", () => {
  it("allows Sec-Fetch-Site: none (a user-typed URL or bookmark), like same-origin", () => {
    expect(checkCsrf("POST", { "sec-fetch-site": "none" }, ORIGIN).ok).toBe(true);
    expect(checkCsrf("PUT", { "sec-fetch-site": "none" }, ORIGIN).ok).toBe(true);
  });

  it("refuses a duplicated (array) Sec-Fetch-Site or Origin header outright", () => {
    expect(checkCsrf("POST", { "sec-fetch-site": ["same-origin", "cross-site"] }, ORIGIN).ok).toBe(false);
    expect(checkCsrf("POST", { origin: [ORIGIN, "https://evil.example"] }, ORIGIN).ok).toBe(false);
    // Even an array of the exact allowed value is refused: a browser never sends two of these.
    expect(checkCsrf("POST", { "sec-fetch-site": ["same-origin", "same-origin"] }, ORIGIN).ok).toBe(false);
  });

  it("folds the method so a lowercase verb is classified the same", () => {
    expect(checkCsrf("get", { origin: "https://evil.example" }, ORIGIN).ok).toBe(true);
    expect(checkCsrf("options", { origin: "https://evil.example" }, ORIGIN).ok).toBe(true);
    expect(checkCsrf("post", { "sec-fetch-site": "same-site" }, ORIGIN).ok).toBe(false);
    expect(checkCsrf("delete", { origin: "https://evil.example" }, ORIGIN).ok).toBe(false);
  });

  it("treats HEAD and OPTIONS as safe", () => {
    expect(checkCsrf("HEAD", { "sec-fetch-site": "cross-site" }, ORIGIN).ok).toBe(true);
    expect(checkCsrf("OPTIONS", { origin: "https://evil.example" }, ORIGIN).ok).toBe(true);
  });

  it("checks Origin and Sec-Fetch-Site independently: a good site header does not excuse a foreign Origin", () => {
    expect(checkCsrf("POST", { "sec-fetch-site": "same-origin", origin: "https://evil.example" }, ORIGIN).ok).toBe(false);
    // ...and a matching Origin does not excuse a cross-site fetch marker.
    expect(checkCsrf("POST", { "sec-fetch-site": "cross-site", origin: ORIGIN }, ORIGIN).ok).toBe(false);
    // Both present and both consistent is accepted.
    expect(checkCsrf("POST", { "sec-fetch-site": "same-origin", origin: ORIGIN }, ORIGIN).ok).toBe(true);
  });
});

describe("client resolver: IPv6 and mapped trusted proxies", () => {
  it("trusts an IPv6 proxy subnet and reads the forwarded client", () => {
    const r = createClientResolver(["2001:db8::/32"], "direct_tls");
    expect(r("2001:db8::1", { "x-forwarded-for": "203.0.113.4" })).toEqual({ ip: "203.0.113.4", known: true });
    // A peer outside the subnet is itself the client; its headers are ignored.
    expect(r("2001:dead::1", { "x-forwarded-for": "203.0.113.4" })).toEqual({ ip: "2001:dead::1", known: true });
  });

  it("trusts a single IPv6 proxy address", () => {
    const r = createClientResolver(["2001:db8::5"], "direct_tls");
    expect(r("2001:db8::5", { "x-forwarded-for": "198.51.100.7" })).toEqual({ ip: "198.51.100.7", known: true });
    expect(r("2001:db8::6", {})).toEqual({ ip: "2001:db8::6", known: true });
  });

  it("matches an IPv4-mapped peer against an IPv4 trust entry (normalised before the check)", () => {
    const r = createClientResolver(["172.18.0.5"], "direct_tls");
    expect(r("::ffff:172.18.0.5", { "x-forwarded-for": "203.0.113.4" })).toEqual({ ip: "203.0.113.4", known: true });
  });

  it("returns an IPv6 client forwarded by a trusted proxy", () => {
    const r = createClientResolver(["172.18.0.5"], "direct_tls");
    expect(r("172.18.0.5", { "x-forwarded-for": "2606:4700::1111" })).toEqual({ ip: "2606:4700::1111", known: true });
  });

  it("rejects an out-of-range IPv6 prefix in the trusted-proxy list at construction", () => {
    expect(() => createClientResolver(["2001:db8::/129"], "direct_tls")).toThrow();
    expect(() => createClientResolver(["2001:db8::/-1"], "direct_tls")).toThrow();
  });

  it("falls through to X-Forwarded-For when CF-Connecting-IP is not a usable address", () => {
    const tunnel = createClientResolver(["172.18.0.0/16"], "cloudflare_tunnel");
    expect(tunnel("172.18.0.3", { "cf-connecting-ip": "not-an-ip", "x-forwarded-for": "203.0.113.4" })).toEqual({ ip: "203.0.113.4", known: true });
  });
});
