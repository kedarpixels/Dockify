import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, totpAt, totpMatchedCounter, verifyTotp } from "./totp.ts";

// The RFC 4226 shared secret, "12345678901234567890" as ASCII bytes.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 128, 64, 32, 16, 8]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it("decodes tolerantly of lowercase, spaces and padding", () => {
    const secret = generateTotpSecret();
    const messy = secret.toLowerCase().replace(/(.{4})/g, "$1 ") + "==";
    expect(base32Decode(messy)).toEqual(base32Decode(secret));
  });

  it("throws on a character outside the alphabet rather than decoding garbage", () => {
    expect(() => base32Decode("ABC!")).toThrow();
  });
});

describe("TOTP against the RFC 4226 test vectors", () => {
  // counter N maps to time [N*30s, (N+1)*30s); using N*30000ms lands squarely in step N.
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];

  it("computes the published 6-digit codes for counters 0..9", () => {
    expected.forEach((code, counter) => {
      expect(totpAt(RFC_SECRET, counter * 30_000)).toBe(code);
    });
  });
});

describe("verifyTotp", () => {
  it("accepts the code for the current step", () => {
    const t = 60_000; // step 2
    expect(verifyTotp(RFC_SECRET, "359152", t)).toBe(true);
  });

  it("accepts a code one step early or late (clock skew tolerance)", () => {
    const t = 60_000; // step 2; step 1 = 287082, step 3 = 969429
    expect(verifyTotp(RFC_SECRET, "287082", t)).toBe(true);
    expect(verifyTotp(RFC_SECRET, "969429", t)).toBe(true);
  });

  it("rejects a code two steps away", () => {
    const t = 60_000; // step 2; step 0 = 755224
    expect(verifyTotp(RFC_SECRET, "755224", t)).toBe(false);
  });

  it("rejects anything that is not six digits", () => {
    expect(verifyTotp(RFC_SECRET, "35915", 60_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "3591520", 60_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "abcdef", 60_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, "", 60_000)).toBe(false);
  });
});

describe("otpauthUri", () => {
  it("encodes the label and states the parameters explicitly", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "owner@example.com", "Dockify");
    expect(uri.startsWith("otpauth://totp/Dockify%3Aowner%40example.com?")).toBe(true);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Dockify");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});

describe("totpMatchedCounter (single-use support)", () => {
  const RFC = base32Encode(Buffer.from("12345678901234567890", "ascii"));
  it("returns the matched time-step counter, not just a boolean", () => {
    // step 2 (t=60_000): the code is 359152; the matched counter must be exactly 2.
    expect(totpMatchedCounter(RFC, "359152", 60_000)).toBe(2);
    // a one-step-early code (287082 = step 1) matches, and reports counter 1 - so a caller can reject
    // any counter <= the last accepted, closing the replay window.
    expect(totpMatchedCounter(RFC, "287082", 60_000)).toBe(1);
  });
  it("returns null for a code outside the window or malformed", () => {
    expect(totpMatchedCounter(RFC, "755224", 60_000)).toBeNull(); // step 0, two away
    expect(totpMatchedCounter(RFC, "abc", 60_000)).toBeNull();
  });
});
