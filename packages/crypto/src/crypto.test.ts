import { describe, it, expect } from "vitest";
import {
  loadKeyring, seal, open, rewrap, keyFingerprint, activeFingerprint,
  hashToken, verifyToken, newToken, internalChannelToken, CryptoError, type Keyring,
} from "./index.ts";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
// A real 32-byte key with actual entropy, for tests that must pass the entropy guard.
const good = (seed: number) => Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + seed * 31 + 3) % 251 + 1)).toString("base64");

const ring = (env: Record<string, string>): Keyring => loadKeyring(env as NodeJS.ProcessEnv);
const CTX = { id: "row-1", kind: "provider_token", scope: "cloudflare" };

describe("key loading", () => {
  it("rejects a missing key with an actionable message", () => {
    expect(() => ring({})).toThrow(/openssl rand -base64 32/);
  });

  it("rejects published placeholder values", () => {
    // The CVE-2023-27524 class: the operator copied a working .env from a blog post. `${VAR:?}` in
    // compose cannot catch this because the variable IS set.
    for (const bad of ["changeme", "replace-me-with-a-random-string", "dockify"]) {
      expect(() => ring({ DOCKIFY_MASTER_KEY: bad })).toThrow(CryptoError);
    }
  });

  it("rejects a key of the wrong length", () => {
    expect(() => ring({ DOCKIFY_MASTER_KEY: Buffer.alloc(16, 9).toString("base64") })).toThrow(/32/);
  });

  it("rejects a key with no entropy", () => {
    expect(() => ring({ DOCKIFY_MASTER_KEY: KEY_A })).toThrow(/entropy/);
  });

  it("prefers _FILE over the inline variable", () => {
    // Not asserting file reading here (no fixture); asserting that an unreadable _FILE is fatal
    // rather than silently falling back to the inline value, which would defeat the point.
    expect(() => ring({ DOCKIFY_MASTER_KEY: good(1), DOCKIFY_MASTER_KEY_FILE: "/nonexistent/key" }))
      .toThrow(/could not be read/);
  });
});

describe("seal and open", () => {
  it("round-trips a value", () => {
    const r = ring({ DOCKIFY_MASTER_KEY: good(1) });
    const sealed = seal(r, CTX, "cf_live_abc123");
    expect(open(r, CTX, sealed)).toBe("cf_live_abc123");
  });

  it("produces different ciphertext for the same plaintext", () => {
    // Each seal mints a fresh DEK and nonce, so equal plaintexts must not be linkable.
    const r = ring({ DOCKIFY_MASTER_KEY: good(1) });
    const a = seal(r, CTX, "same");
    const b = seal(r, CTX, "same");
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });

  it("fails with the wrong master key, and says how to fix it", () => {
    // Because keys are addressed by fingerprint, "wrong key" is detected as "the key that sealed
    // this is not loaded" rather than as a generic decrypt failure. That distinction is the whole
    // point: the operator is told exactly what to do instead of being told the data is corrupt.
    const a = ring({ DOCKIFY_MASTER_KEY: good(1) });
    const b = ring({ DOCKIFY_MASTER_KEY: good(2) });
    const sealed = seal(a, CTX, "secret");
    expect(() => open(b, CTX, sealed)).toThrow(/DOCKIFY_MASTER_KEY_PREVIOUS/);
  });

  it("fails to unwrap when the key id matches but the key does not", () => {
    // Distinct from the case above: here the ring HAS a key under that fingerprint, so we get to the
    // actual unwrap and it must fail closed.
    const a = ring({ DOCKIFY_MASTER_KEY: good(1) });
    const b = ring({ DOCKIFY_MASTER_KEY: good(2) });
    const sealed = seal(a, CTX, "secret");
    const forged = { ...sealed, kekId: b.active };
    expect(() => open(b, CTX, forged)).toThrow(/unwrap/i);
  });

  it("detects tampering with the ciphertext", () => {
    const r = ring({ DOCKIFY_MASTER_KEY: good(1) });
    const sealed = seal(r, CTX, "secret");
    sealed.ciphertext[0] = (sealed.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => open(r, CTX, sealed)).toThrow(CryptoError);
  });

  it("REFUSES a value moved to a different row", () => {
    // The attack AAD exists to stop: an attacker with Postgres write access but no key copies the
    // ciphertext of a low-value secret into the row holding the god-mode token. Without AAD this
    // decrypts cleanly and the app uses it in the wrong context.
    const r = ring({ DOCKIFY_MASTER_KEY: good(1) });
    const lowValue = seal(r, { id: "row-1", kind: "env_var", scope: "proj-a" }, "harmless");
    expect(() => open(r, { id: "row-2", kind: "provider_token", scope: "coolify" }, lowValue))
      .toThrow(/unwrap/i);
  });

  it("refuses a value sealed under a key version that is not loaded", () => {
    const a = ring({ DOCKIFY_MASTER_KEY: good(1) });
    const sealed = seal(a, CTX, "secret");
    sealed.kekId = "deadbeefdeadbeef";
    expect(() => open(a, CTX, sealed)).toThrow(/DOCKIFY_MASTER_KEY_PREVIOUS/);
  });
});

describe("rotation", () => {
  it("rewraps under the new key and still decrypts", () => {
    const oldRing = ring({ DOCKIFY_MASTER_KEY: good(1) });
    const sealed = seal(oldRing, CTX, "rotate-me");

    // New active key, old key retained so existing rows stay readable.
    const rotating = ring({ DOCKIFY_MASTER_KEY: good(2), DOCKIFY_MASTER_KEY_PREVIOUS: good(1) });
    // The row records WHICH key sealed it, by fingerprint, so it stays readable as long as that key
    // is loaded - regardless of which key is currently active.
    expect(sealed.kekId).toBe(oldRing.active);
    expect(open(rotating, CTX, sealed)).toBe("rotate-me");

    const migrated = rewrap(rotating, CTX, sealed);
    expect(migrated.kekId).toBe(rotating.active);
    expect(open(rotating, CTX, migrated)).toBe("rotate-me");
  });

  it("is a no-op when already on the active version", () => {
    const r = ring({ DOCKIFY_MASTER_KEY: good(1) });
    const sealed = seal(r, CTX, "x");
    expect(rewrap(r, CTX, sealed)).toBe(sealed);
  });
});

describe("fingerprint", () => {
  it("is stable and does not reveal the key", () => {
    const r = ring({ DOCKIFY_MASTER_KEY: good(1) });
    const fp = activeFingerprint(r);
    expect(fp).toHaveLength(16);
    expect(activeFingerprint(ring({ DOCKIFY_MASTER_KEY: good(1) }))).toBe(fp);
    expect(activeFingerprint(ring({ DOCKIFY_MASTER_KEY: good(2) }))).not.toBe(fp);
  });

  it("differs per key", () => {
    expect(keyFingerprint(Buffer.from(KEY_A, "base64")))
      .not.toBe(keyFingerprint(Buffer.from(KEY_B, "base64")));
  });
});

describe("tokens", () => {
  it("verifies a correct token and rejects a wrong one", () => {
    const t = newToken();
    const h = hashToken(t);
    expect(verifyToken(t, h)).toBe(true);
    expect(verifyToken(newToken(), h)).toBe(false);
  });

  it("does not throw on a malformed stored hash", () => {
    // timingSafeEqual throws on length mismatch; verifyToken must guard that itself.
    expect(verifyToken(newToken(), "short")).toBe(false);
  });

  it("mints unpredictable tokens", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newToken()));
    expect(seen.size).toBe(200);
  });
});

describe("rotation actually re-keys", () => {
  it("gives every row a FRESH dek, so a leaked old key cannot read it afterwards", () => {
    // The scenario rotation exists for: the master key leaked, and the attacker took a pg_dump.
    // They unwrap every DEK offline. The operator then rotates.
    const oldRing = ring({ DOCKIFY_MASTER_KEY: good(1) });
    const sealed = seal(oldRing, CTX, "cf_live_TOKEN");

    // Attacker's captured DEK, recovered with the leaked key.
    const stolenPlaintext = open(oldRing, CTX, sealed);
    expect(stolenPlaintext).toBe("cf_live_TOKEN");

    const rotating = ring({ DOCKIFY_MASTER_KEY: good(2), DOCKIFY_MASTER_KEY_PREVIOUS: good(1) });
    const rotated = rewrap(rotating, CTX, sealed);

    // The ciphertext must CHANGE. Re-wrapping the same DEK left the row decryptable by the DEK the
    // attacker already held, so rotation looked successful while changing nothing for them.
    expect(Buffer.compare(rotated.ciphertext, sealed.ciphertext)).not.toBe(0);
    expect(Buffer.compare(rotated.wrappedDek, sealed.wrappedDek)).not.toBe(0);
    expect(rotated.kekId).toBe(activeFingerprint(rotating));

    // The old key alone can no longer open the rotated row.
    expect(() => open(oldRing, CTX, rotated)).toThrow(CryptoError);
    // And the value survived.
    expect(open(rotating, CTX, rotated)).toBe("cf_live_TOKEN");
  });

  it("upgrades a row onto the current aad encoding while preserving the value", () => {
    const oldRing = ring({ DOCKIFY_MASTER_KEY: good(3) });
    const sealed = seal(oldRing, CTX, "value-to-preserve");
    const rotating = ring({ DOCKIFY_MASTER_KEY: good(4), DOCKIFY_MASTER_KEY_PREVIOUS: good(3) });
    expect(open(rotating, CTX, rewrap(rotating, CTX, sealed))).toBe("value-to-preserve");
  });
});

describe("aad is injective", () => {
  it("does not let a delimiter in one field impersonate another", () => {
    // `${id}|${kind}|${scope}` collides: ("a|b","env_var") and ("a","b|env_var") produce identical
    // aad bytes, so a ciphertext could be swapped between those two rows undetected. `scope` is
    // documented as accepting a provider ACCOUNT name, which is free-form operator input.
    const r = ring({ DOCKIFY_MASTER_KEY: good(5) });
    const a = { id: "acct|x", kind: "env_var", scope: "p1" };
    const b = { id: "acct", kind: "x|env_var", scope: "p1" };

    const sealedA = seal(r, a, "secret-for-a");
    // Moving A's sealed bytes into row B must fail to authenticate.
    expect(() => open(r, b, sealedA)).toThrow(CryptoError);
    expect(open(r, a, sealedA)).toBe("secret-for-a");
  });

  it("still binds the row id, so ciphertext cannot be moved between rows", () => {
    const r = ring({ DOCKIFY_MASTER_KEY: good(6) });
    const sealed = seal(r, { id: "low-value", kind: "env_var", scope: "p1" }, "harmless");
    expect(() => open(r, { id: "god-mode-token", kind: "env_var", scope: "p1" }, sealed))
      .toThrow(CryptoError);
  });
});

describe("internal channel token", () => {
  it("is deterministic for one key: api and worker derive the same token independently", () => {
    const a = internalChannelToken(ring({ DOCKIFY_MASTER_KEY: good(8) }), {});
    const b = internalChannelToken(ring({ DOCKIFY_MASTER_KEY: good(8) }), {});
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs per master key, so two installs can never accept each other's calls", () => {
    const a = internalChannelToken(ring({ DOCKIFY_MASTER_KEY: good(8) }), {});
    const b = internalChannelToken(ring({ DOCKIFY_MASTER_KEY: good(9) }), {});
    expect(a).not.toBe(b);
  });

  it("is not the key and does not reveal it", () => {
    const key = good(8);
    const token = internalChannelToken(ring({ DOCKIFY_MASTER_KEY: key }), {});
    expect(token).not.toBe(key);
    expect(token).not.toContain(key.slice(0, 8));
  });

  it("lets a dedicated DOCKIFY_INTERNAL_TOKEN override the derivation", () => {
    const r = ring({ DOCKIFY_MASTER_KEY: good(8) });
    expect(internalChannelToken(r, { DOCKIFY_INTERNAL_TOKEN: "operator-chosen" })).toBe("operator-chosen");
    // Compose writes `${VAR:-}` for optional variables; blank must mean absent, not present-and-empty.
    expect(internalChannelToken(r, { DOCKIFY_INTERNAL_TOKEN: "" })).toBe(internalChannelToken(r, {}));
  });
});

describe("key entropy validation", () => {
  it("REJECTS a human passphrase that happens to decode to 32 bytes", () => {
    // Node's base64 decoder silently drops characters outside the alphabet rather than throwing, so
    // prose decodes without error. A 43-char passphrase lands on exactly 32 bytes and used to pass
    // every check with ~40 bits of entropy instead of 256 - grindable offline against the key
    // fingerprint that /readyz published.
    const passphrase = "dockify production master key please keep it safer";
    // The premise, asserted rather than claimed: this decodes to exactly 32 bytes of varied values,
    // so it passed the length check AND the all-identical-bytes check and was accepted outright.
    expect(Buffer.from(passphrase, "base64").length).toBe(32);
    expect(() => ring({ DOCKIFY_MASTER_KEY: passphrase })).toThrow(/not valid base64/);
  });

  it("rejects base64 of the wrong padded length", () => {
    expect(() => ring({ DOCKIFY_MASTER_KEY: "YWJj" })).toThrow(CryptoError);
  });

  it("accepts real generated keys", () => {
    expect(() => ring({ DOCKIFY_MASTER_KEY: good(7) })).not.toThrow();
  });
});

describe("legacy aad is gone", () => {
  it("refuses a value sealed under the old delimiter-joined aad", async () => {
    const { createCipheriv, randomBytes } = await import("node:crypto");
    const r = ring({ DOCKIFY_MASTER_KEY: good(10) });
    const kek = r.keys.get(r.active)!;
    const legacy = Buffer.from(`${CTX.id}|${CTX.kind}|${CTX.scope}|${r.active}`, "utf8");
    const enc = (key: Buffer, data: Buffer) => {
      const nonce = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      c.setAAD(legacy);
      return { nonce, out: Buffer.concat([c.update(data), c.final(), c.getAuthTag()]) };
    };
    const dek = randomBytes(32);
    const ct = enc(dek, Buffer.from("old-value"));
    const wrapped = enc(kek, dek);
    const sealed = { kekId: r.active, wrappedDek: wrapped.out, dekNonce: wrapped.nonce, ciphertext: ct.out, ctNonce: ct.nonce };
    expect(() => open(r, CTX, sealed)).toThrow(/unwrap/i);
  });
});

describe("readSecret", () => {
  it("reads the _FILE variant and trims it", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { readSecret } = await import("./index.ts");
    const dir = mkdtempSync(join(tmpdir(), "dockify-crypto-"));
    const file = join(dir, "key");
    writeFileSync(file, `${good(11)}\n`);
    expect(readSecret("DOCKIFY_MASTER_KEY", { DOCKIFY_MASTER_KEY_FILE: file, DOCKIFY_MASTER_KEY: "ignored" })).toBe(good(11));
    expect(readSecret("X", { X: "   " })).toBeUndefined();
  });
});
