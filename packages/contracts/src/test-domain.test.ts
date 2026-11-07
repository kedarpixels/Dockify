import { describe, expect, it } from "vitest";
import { foreignSpelledAddress, isPublicIpv4, spelledAddresses, testDomainLabel, testDomainName, testDomainOffer, testDomainSuffix } from "./test-domain.ts";

const IP = "203.0.113.10";

describe("names that spell an address", () => {
  it("finds them dashed or dotted, anywhere in the name, on the services that read them", () => {
    expect(spelledAddresses("x.1-2-3-4.sslip.io")).toEqual(["1.2.3.4"]);
    expect(spelledAddresses("1.2.3.4.nip.io")).toEqual(["1.2.3.4"]);
    expect(spelledAddresses("www-1-2-3-4.sslip.io")).toEqual(["1.2.3.4"]);
    expect(spelledAddresses("a.1-2-3-4.XIP.io.")).toEqual(["1.2.3.4"]);
    expect(spelledAddresses("1-2-3-4.example.com")).toEqual([]);
    expect(spelledAddresses("plain.sslip.io")).toEqual([]);
  });
  it("does not read an address across a generated id", () => {
    expect(spelledAddresses("web-a1b2c3.203-0-113-10.sslip.io")).toEqual(["203.0.113.10"]);
    expect(spelledAddresses("web-1-2-3-200abc.203-0-113-10.sslip.io")).toEqual(["203.0.113.10"]);
  });
  it("calls out any address but this server's", () => {
    expect(foreignSpelledAddress(`x.${testDomainSuffix(IP)}`, IP)).toBeNull();
    expect(foreignSpelledAddress("x.1-2-3-4.sslip.io", IP)).toBe("1.2.3.4");
    expect(foreignSpelledAddress(`1-2-3-4.${testDomainSuffix(IP)}`, IP)).toBe("1.2.3.4");
    expect(foreignSpelledAddress("x.1-2-3-4.sslip.io", null)).toBe("1.2.3.4");
    expect(foreignSpelledAddress("app.example.com", IP)).toBeNull();
  });
});

describe("generated names", () => {
  it("is <app>-<id>.<ip-with-dashes>.sslip.io, and spells only this server", () => {
    const n = testDomainName("api", "a1b2c3", IP);
    expect(n).toBe("api-a1b2c3.203-0-113-10.sslip.io");
    expect(foreignSpelledAddress(n, IP)).toBeNull();
  });
  it("an app name can never smuggle an address into the name", () => {
    for (const name of ["1-2-3-4", "x-10-0-0-1-y", "9.9.9.9"]) {
      const n = testDomainName(name, "000111", IP);
      expect(spelledAddresses(n), name).toEqual(["203.0.113.10"]);
    }
  });
  it("stays a valid label for any name, with room for the id", () => {
    expect(testDomainLabel("---", "abc123")).toBe("app-abc123");
    expect(testDomainLabel("My_App!", "abc123")).toBe("my-app-abc123");
    const long = testDomainLabel("a".repeat(100), "abc123");
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  });
});

describe("when it is offered", () => {
  it("in direct mode on a public address", () => {
    expect(testDomainOffer({ ingress: "direct_tls", serverIpv4: IP })).toEqual({ available: true, reason: null, suffix: "203-0-113-10.sslip.io" });
  });
  it("never in a tunnel, which has no public port for the name to reach", () => {
    expect(testDomainOffer({ ingress: "cloudflare_tunnel", serverIpv4: IP }).available).toBe(false);
  });
  it("never without a public address", () => {
    for (const ip of [null, "", "10.0.0.5", "192.168.1.2", "172.16.0.1", "127.0.0.1", "100.64.0.1", "169.254.1.1", "224.0.0.1", "300.1.1.1", "not-an-ip"]) {
      expect(isPublicIpv4(ip), String(ip)).toBe(false);
      expect(testDomainOffer({ ingress: "direct_tls", serverIpv4: ip }).available, String(ip)).toBe(false);
    }
    expect(isPublicIpv4("8.8.8.8")).toBe(true);
  });
});
