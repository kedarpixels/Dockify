import { describe, expect, it } from "vitest";
import { DOMAIN_CHECK_PREFIX, domainCheckAnswer, domainCheckToken, sameCheckValue } from "./domain-check.ts";

const SECRET = "internal-channel-secret-for-tests-0123456789";
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("the domain ownership probe's values", () => {
  it("gives one token per domain row and secret, whatever the host's spelling", () => {
    const t = domainCheckToken(SECRET, ID, "shop.example.com");
    expect(t).toMatch(/^[a-f0-9]{64}$/);
    expect(domainCheckToken(SECRET, ID, "Shop.Example.com.")).toBe(t);
    // Another row for the same name (deleted and added again), another name or another server: another token.
    expect(domainCheckToken(SECRET, OTHER, "shop.example.com")).not.toBe(t);
    expect(domainCheckToken(SECRET, ID, "www.example.com")).not.toBe(t);
    expect(domainCheckToken("another-servers-secret-0123456789abcdef", ID, "shop.example.com")).not.toBe(t);
  });

  it("answers with a value that is never the token itself, so echoing the path proves nothing", () => {
    const t = domainCheckToken(SECRET, ID, "shop.example.com");
    const a = domainCheckAnswer(SECRET, "shop.example.com", t);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(t);
    expect(domainCheckAnswer(SECRET, "SHOP.example.com.", t)).toBe(a);
    // Bound to the host: the answer for this token on another name is another value.
    expect(domainCheckAnswer(SECRET, "www.example.com", t)).not.toBe(a);
    expect(SECRET.length).toBeGreaterThan(0);
    expect(a).not.toContain(SECRET);
  });

  it("compares only two well-formed values", () => {
    const t = domainCheckToken(SECRET, ID, "shop.example.com");
    expect(sameCheckValue(t, t)).toBe(true);
    expect(sameCheckValue(t, domainCheckToken(SECRET, OTHER, "shop.example.com"))).toBe(false);
    for (const bad of ["", t.slice(1), `${t}0`, t.toUpperCase(), `${t.slice(0, 63)}g`]) expect(sameCheckValue(bad, t), bad).toBe(false);
  });

  it("lives under one well-known prefix", () => {
    expect(DOMAIN_CHECK_PREFIX).toBe("/.well-known/dockify-check/");
  });
});
