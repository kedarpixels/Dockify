import { describe, expect, it } from "vitest";
import { LOGIN_PER_ACCOUNT, LOGIN_PER_NETWORK, LoginGuard, networkKey, rateKey, SubjectGuard } from "./ratelimit.ts";

describe("rateKey: IPv6 collapses to /64, IPv4 is untouched", () => {
  it("keeps IPv4 and IPv4-mapped addresses whole", () => {
    expect(rateKey("203.0.113.9")).toBe("203.0.113.9");
    expect(rateKey("::ffff:203.0.113.9")).toBe("::ffff:203.0.113.9");
    expect(rateKey("")).toBe("");
  });

  it("maps every address in one /64 to the same key", () => {
    const a = rateKey("2001:db8:abcd:1234:0:0:0:1");
    const b = rateKey("2001:db8:abcd:1234:ffff:ffff:ffff:ffff");
    expect(a).toBe(b);
    expect(a).toBe("2001:db8:abcd:1234::/64");
  });

  it("separates different /64 networks, and handles :: compression", () => {
    expect(rateKey("2001:db8:abcd:1234::1")).not.toBe(rateKey("2001:db8:abcd:9999::1"));
    expect(rateKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });
});

describe("SubjectGuard: an elapsed lockout cannot relock forever", () => {
  it("resets the fail count once the lockout window has passed", () => {
    const g = new SubjectGuard({ perMinute: 1000, burst: 1000 });
    let t = 0;
    for (let i = 0; i < 10; i++) g.failed("u1", t);
    expect(g.locked("u1", t)).toBe(true);
    // 15 minutes later the lockout has elapsed.
    t += 15 * 60_000 + 1;
    expect(g.locked("u1", t)).toBe(false);
    // One further failure must NOT immediately relock: the count started fresh.
    g.failed("u1", t);
    expect(g.locked("u1", t)).toBe(false);
  });

  it("still locks after the threshold within a window", () => {
    const g = new SubjectGuard({ perMinute: 1000, burst: 1000 });
    for (let i = 0; i < 10; i++) g.failed("u2", 0);
    expect(g.locked("u2", 0)).toBe(true);
  });
});

describe("networkKey: the client network an account limit is keyed on", () => {
  it("collapses IPv4 to its /24 (mapped addresses too) and IPv6 to its /64", () => {
    expect(networkKey("203.0.113.9")).toBe("203.0.113.0/24");
    expect(networkKey("203.0.113.250")).toBe("203.0.113.0/24");
    expect(networkKey("::ffff:203.0.113.9")).toBe("203.0.113.0/24");
    expect(networkKey("198.51.100.7")).not.toBe(networkKey("203.0.113.7"));
    expect(networkKey("2001:db8:abcd:1234::1")).toBe("2001:db8:abcd:1234::/64");
  });
});

describe("LoginGuard: one address cannot lock a user out, brute force stays bounded", () => {
  const victim = "owner@example.com";

  it("lets the owner in from another network while a sprayer is refused (the sprayer case)", () => {
    const g = new LoginGuard();
    const t = 0;
    let refused = 0;
    for (let i = 0; i < 100; i++) if (g.attempt(victim, `198.51.100.${i % 250}`, t) !== null) refused++;
    // Ten failures from the sprayer's /24, however many addresses it rotates through in it.
    expect(refused).toBe(90);
    expect(g.attempt(victim, "203.0.113.9", t)).toBeNull();
  });

  it("bounds one network to 10 failed guesses, then one every 90 seconds (the brute force case)", () => {
    const g = new LoginGuard();
    let t = 0;
    for (let i = 0; i < LOGIN_PER_NETWORK.burst; i++) expect(g.attempt(victim, "198.51.100.1", t)).toBeNull();
    const wait = g.attempt(victim, "198.51.100.1", t);
    expect(wait).not.toBeNull();
    expect(wait!).toBeGreaterThanOrEqual(80);
    t += 91_000;
    expect(g.attempt(victim, "198.51.100.1", t)).toBeNull();
    expect(g.attempt(victim, "198.51.100.1", t)).not.toBeNull();
  });

  it("caps a guesser spread over many networks with the per-account ceiling", () => {
    const g = new LoginGuard();
    let allowed = 0;
    for (let n = 0; n < 40; n++) for (let i = 0; i < 10; i++) if (g.attempt(victim, `10.${n}.0.${i}`, 0) === null) allowed++;
    expect(allowed).toBe(LOGIN_PER_ACCOUNT.burst);
    // Another account is not touched.
    expect(g.attempt("someone@example.com", "10.0.0.1", 0)).toBeNull();
  });

  it("counts only failures: a right password hands its attempt back, also under parallel tries", () => {
    const g = new LoginGuard();
    for (let i = 0; i < 100; i++) {
      expect(g.attempt(victim, "203.0.113.9", 0)).toBeNull();
      g.succeeded(victim, "203.0.113.9");
    }
    // Ten parallel guesses each take their token before any is judged: the eleventh is refused.
    for (let i = 0; i < LOGIN_PER_NETWORK.burst; i++) expect(g.attempt(victim, "198.51.100.1", 0)).toBeNull();
    expect(g.attempt(victim, "198.51.100.1", 0)).not.toBeNull();
  });
});
