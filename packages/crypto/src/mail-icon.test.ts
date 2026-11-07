import { describe, expect, it } from "vitest";
import { mailIconKey, signMailIcon, verifyMailIcon, CryptoError } from "./index.ts";

const ID = "0f0e0d0c-0000-4000-8000-0000000000aa";
const V = "4f2a9c1e8b7d";
const key = mailIconKey("internal-token-of-this-instance");

describe("mail icon links", () => {
  it("signs a reference into an opaque token that only names the owner and the icon version", () => {
    const token = signMailIcon(key, { target: "project", id: ID, version: V });
    expect(token).toMatch(/^p[0-9a-f]{44}[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain("-");
    expect(verifyMailIcon(key, token)).toEqual({ target: "project", id: ID, version: V });
    expect(verifyMailIcon(key, signMailIcon(key, { target: "app", id: ID.toUpperCase(), version: V }))).toEqual({ target: "app", id: ID, version: V });
    // The same reference always signs the same way, so a resend carries the same link.
    expect(signMailIcon(key, { target: "project", id: ID, version: V })).toBe(token);
  });

  it("refuses a tampered token, a token under another key, and anything that is not a token", () => {
    const token = signMailIcon(key, { target: "app", id: ID, version: V });
    const flip = (s: string, at: number) => `${s.slice(0, at)}${s[at] === "a" ? "b" : "a"}${s.slice(at + 1)}`;
    // The MAC, the version, the id and the target each break the signature.
    expect(verifyMailIcon(key, flip(token, token.length - 1))).toBeNull();
    expect(verifyMailIcon(key, flip(token, 40))).toBeNull();
    expect(verifyMailIcon(key, flip(token, 5))).toBeNull();
    expect(verifyMailIcon(key, `p${token.slice(1)}`)).toBeNull();
    expect(verifyMailIcon(mailIconKey("another instance"), token)).toBeNull();
    for (const junk of ["", "x", token.slice(0, 45), `${token}=`, `${token}\n`, "../../etc/passwd", "a".repeat(88)]) expect(verifyMailIcon(key, junk), junk).toBeNull();
  });

  it("derives different keys from different secrets, and needs a secret", () => {
    expect(mailIconKey("a").equals(mailIconKey("b"))).toBe(false);
    expect(mailIconKey("a")).toHaveLength(32);
    expect(() => mailIconKey("")).toThrow(CryptoError);
    expect(() => signMailIcon(key, { target: "app", id: "not-a-uuid", version: V })).toThrow(CryptoError);
    expect(() => signMailIcon(key, { target: "app", id: ID, version: "short" })).toThrow(CryptoError);
  });
});
