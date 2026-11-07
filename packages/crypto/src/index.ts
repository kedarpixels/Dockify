/**
 * Envelope encryption. A Postgres dump on its own must yield zero usable credentials, so the KEK
 * never lives in the database. Each value gets its own 32-byte DEK, used exactly once, wrapped by the
 * active KEK. AES-256-GCM with 96-bit random nonces; one DEK sees one nonce, so the birthday bound
 * never applies to value encryption.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, createSign, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const ALG = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class CryptoError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "CryptoError";
    this.code = code;
  }
}

/** Every key we can decrypt with, by fingerprint. New writes use only `active`. */
export interface Keyring {
  active: string;
  keys: Map<string, Buffer>;
}

/** Placeholders ever shipped in docs. Lowercase, because the lookup lowercases. */
const KNOWN_BAD = new Set([
  "changeme", "change-me", "replace-me", "replace-me-with-a-random-string",
  "insecure", "secret", "supersecret", "dockify", "dockify-dev-key",
  "0000000000000000000000000000000000000000000=",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
]);

/** Node's base64 decoder silently drops bad characters, so the alphabet check is load-bearing. */
const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;

const KEY_HINT = "Generate one with: openssl rand -base64 32";

function assertUsableKey(raw: string, label: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) throw new CryptoError(`${label} is empty. ${KEY_HINT}`, "KEY_MISSING");
  if (KNOWN_BAD.has(trimmed.toLowerCase())) {
    throw new CryptoError(`${label} is a published placeholder value and is not secret. ${KEY_HINT}`, "KEY_PLACEHOLDER");
  }
  if (!BASE64_ONLY.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new CryptoError(`${label} is not valid base64. ${KEY_HINT}`, "KEY_MALFORMED");
  }
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES) {
    throw new CryptoError(`${label} decoded to ${key.length} bytes, expected ${KEY_BYTES}. ${KEY_HINT}`, "KEY_LENGTH");
  }
  if (key.every((b) => b === key[0])) {
    throw new CryptoError(`${label} has no entropy (every byte identical).`, "KEY_ENTROPY");
  }
  return key;
}

/**
 * Reads a config value with the `<NAME>_FILE` convention, which wins over the inline variable.
 * Blank counts as absent, because compose writes `${VAR:-}` as an empty string.
 */
export function readSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env[`${name}_FILE`]?.trim();
  if (file) {
    try {
      return readFileSync(file, "utf8").trim() || undefined;
    } catch (e) {
      throw new CryptoError(`${name}_FILE is set to ${file} but could not be read: ${(e as Error).message}`, "SECRET_FILE_UNREADABLE");
    }
  }
  return env[name]?.trim() || undefined;
}

export function loadKeyring(env: NodeJS.ProcessEnv = process.env): Keyring {
  const current = readSecret("DOCKIFY_MASTER_KEY", env);
  if (current === undefined) {
    throw new CryptoError(`DOCKIFY_MASTER_KEY is not set. ${KEY_HINT}`, "KEY_MISSING");
  }
  // Addressed by fingerprint, so adding or removing keys never renumbers anything.
  const keys = new Map<string, Buffer>();
  const activeKey = assertUsableKey(current, "DOCKIFY_MASTER_KEY");
  const active = keyFingerprint(activeKey);
  keys.set(active, activeKey);

  const previous = readSecret("DOCKIFY_MASTER_KEY_PREVIOUS", env);
  if (previous) {
    previous.split(",").map((x) => x.trim()).filter(Boolean).forEach((raw, i) => {
      const k = assertUsableKey(raw, `DOCKIFY_MASTER_KEY_PREVIOUS[${i}]`);
      keys.set(keyFingerprint(k), k);
    });
  }
  return { active, keys };
}

/** Stored at first boot and compared on every boot, so a wrong key fails once, loudly. */
export function keyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function activeFingerprint(ring: Keyring): string {
  return ring.active;
}

export interface Sealed {
  kekId: string;
  wrappedDek: Buffer;
  dekNonce: Buffer;
  ciphertext: Buffer;
  ctNonce: Buffer;
}

export interface SealContext {
  /** Secret row id. */
  id: string;
  /** What the value is, for example `env_var` or `totp`. */
  kind: string;
  /** The owner, for example `app:<uuid>`. */
  scope: string;
}

/** AAD binds a ciphertext to its row. Length-prefixed so no two tuples can collide. */
function aad(id: string, kind: string, scope: string, kekId: string): Buffer {
  return Buffer.concat([id, kind, scope, kekId].map((field) => {
    const bytes = Buffer.from(field, "utf8");
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(bytes.length);
    return Buffer.concat([len, bytes]);
  }));
}

function encrypt(key: Buffer, plaintext: Buffer, ad: Buffer): { nonce: Buffer; out: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALG, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(ad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, out: Buffer.concat([body, cipher.getAuthTag()]) };
}

function decrypt(key: Buffer, nonce: Buffer, payload: Buffer, ad: Buffer): Buffer {
  if (payload.length < TAG_BYTES) throw new CryptoError("Ciphertext is too short to contain an auth tag.", "CT_TRUNCATED");
  const decipher = createDecipheriv(ALG, key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(ad);
  decipher.setAuthTag(payload.subarray(payload.length - TAG_BYTES));
  return Buffer.concat([decipher.update(payload.subarray(0, payload.length - TAG_BYTES)), decipher.final()]);
}

function activeKek(ring: Keyring): Buffer {
  const kek = ring.keys.get(ring.active);
  if (!kek) throw new CryptoError(`No key for active fingerprint ${ring.active}.`, "KEY_VERSION_MISSING");
  return kek;
}

export function seal(ring: Keyring, ctx: SealContext, plaintext: string): Sealed {
  const kek = activeKek(ring);
  const ad = aad(ctx.id, ctx.kind, ctx.scope, ring.active);
  const dek = randomBytes(KEY_BYTES);
  try {
    const { nonce: ctNonce, out: ciphertext } = encrypt(dek, Buffer.from(plaintext, "utf8"), ad);
    const { nonce: dekNonce, out: wrappedDek } = encrypt(kek, dek, ad);
    return { kekId: ring.active, wrappedDek, dekNonce, ciphertext, ctNonce };
  } finally {
    dek.fill(0);
  }
}

function unwrap(ring: Keyring, ctx: SealContext, sealed: Sealed): { dek: Buffer; ad: Buffer } {
  const kek = ring.keys.get(sealed.kekId);
  if (!kek) {
    throw new CryptoError(
      `This value was sealed with key ${sealed.kekId}, which is not loaded. ` +
        "If you are restoring a backup, set DOCKIFY_MASTER_KEY_PREVIOUS to the original key.",
      "KEY_VERSION_MISSING",
    );
  }
  const ad = aad(ctx.id, ctx.kind, ctx.scope, sealed.kekId);
  try {
    return { dek: decrypt(kek, sealed.dekNonce, sealed.wrappedDek, ad), ad };
  } catch {
    throw new CryptoError("Could not unwrap the data key. Wrong master key, or the row was tampered with.", "UNWRAP_FAILED");
  }
}

export function open(ring: Keyring, ctx: SealContext, sealed: Sealed): string {
  const { dek, ad } = unwrap(ring, ctx, sealed);
  try {
    return decrypt(dek, sealed.ctNonce, sealed.ciphertext, ad).toString("utf8");
  } catch {
    throw new CryptoError("Could not decrypt the value. The ciphertext was tampered with.", "DECRYPT_FAILED");
  } finally {
    dek.fill(0);
  }
}

/**
 * Re-key under the active KEK with a FRESH DEK. Re-wrapping the old DEK would leave a leaked key plus
 * an old dump able to read every row. This does not rotate the secrets themselves.
 */
export function rewrap(ring: Keyring, ctx: SealContext, sealed: Sealed): Sealed {
  if (sealed.kekId === ring.active) return sealed;
  const newKek = activeKek(ring);
  const { dek, ad } = unwrap(ring, ctx, sealed);
  let plaintext: Buffer;
  try {
    plaintext = decrypt(dek, sealed.ctNonce, sealed.ciphertext, ad);
  } catch {
    throw new CryptoError("Could not decrypt the value; cannot rewrap.", "DECRYPT_FAILED");
  } finally {
    dek.fill(0);
  }
  const fresh = randomBytes(KEY_BYTES);
  try {
    const newAd = aad(ctx.id, ctx.kind, ctx.scope, ring.active);
    const { nonce: ctNonce, out: ciphertext } = encrypt(fresh, plaintext, newAd);
    const { nonce: dekNonce, out: wrappedDek } = encrypt(newKek, fresh, newAd);
    return { kekId: ring.active, wrappedDek, dekNonce, ciphertext, ctNonce };
  } finally {
    plaintext.fill(0);
    fresh.fill(0);
  }
}

const INTERNAL_CHANNEL_LABEL = "dockify-internal-channel-v1";

/** Bearer for the api to worker channel: DOCKIFY_INTERNAL_TOKEN, else an HMAC of the active key. */
export function internalChannelToken(ring: Keyring, env: NodeJS.ProcessEnv = process.env): string {
  const dedicated = readSecret("DOCKIFY_INTERNAL_TOKEN", env);
  if (dedicated) return dedicated;
  return createHmac("sha256", activeKek(ring)).update(INTERNAL_CHANNEL_LABEL).digest("hex");
}

/**
 * A keyed hash for short secrets (6-digit email codes). A plain SHA-256 of a million possible codes
 * is reversed in a blink from a database dump; keyed by a subkey of the master key, a dump alone
 * says nothing. The label separates uses, and a key rotation simply voids codes in flight.
 */
export function keyedHash(ring: Keyring, label: string, value: string): string {
  const sub = createHmac("sha256", activeKek(ring)).update(`dockify-keyed-hash-v1:${label}`).digest();
  return createHmac("sha256", sub).update(value, "utf8").digest("hex");
}

/** Session, API and invite tokens are 256-bit random values: SHA-256 is enough, no KDF needed. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifyToken(token: string, expectedHash: string): boolean {
  return safeEqual(hashToken(token), expectedHash);
}

/** 32 random bytes, base64url. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Mail icon links. An email shows a project's or an app's own icon, but the icon routes are
 * session gated and a mail client has no session, so the email carries a signed link instead
 * (/api/icons/mail/<token>). The token names the owner and the icon's version, under an HMAC keyed
 * by a subkey both sides derive from one existing secret: the internal channel token, which the
 * api (serving the link) and the worker (minting it) already share. It carries nothing else,
 * cannot be guessed, and stops working the moment the icon changes, since its version no longer
 * matches the one shown; a key rotation voids every link at once.
 */
const MAIL_ICON_LABEL = "dockify.mail-icon.v1";

export type MailIconTarget = "app" | "project";

export interface MailIconRef {
  target: MailIconTarget;
  /** The app or project id (a uuid). */
  id: string;
  /** The icon's version: the first 12 hex characters of its sha256. */
  version: string;
}

/** The signing key, derived once from the shared secret. */
export function mailIconKey(secret: string): Buffer {
  if (!secret) throw new CryptoError("The mail icon key needs a secret to derive from", "KEY_MISSING");
  return createHmac("sha256", secret).update(MAIL_ICON_LABEL).digest();
}

const MAIL_ICON_BODY = /^[ap][0-9a-f]{44}$/;
const MAIL_ICON_TOKEN = /^([ap])([0-9a-f]{32})([0-9a-f]{12})([A-Za-z0-9_-]{43})$/;

/** The token for one icon: "a" or "p", the id without dashes, the version, then the MAC (base64url). */
export function signMailIcon(key: Buffer, ref: MailIconRef): string {
  const body = `${ref.target === "app" ? "a" : "p"}${ref.id.replace(/-/g, "").toLowerCase()}${ref.version}`;
  if (!MAIL_ICON_BODY.test(body)) throw new CryptoError("A mail icon reference needs a uuid and a 12 hex character version", "MAIL_ICON_REF");
  return `${body}${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** The reference a token names, or null for anything that is not a token this key signed. */
export function verifyMailIcon(key: Buffer, token: string): MailIconRef | null {
  const m = MAIL_ICON_TOKEN.exec(token);
  if (!m) return null;
  const body = token.slice(0, 45);
  const expected = Buffer.from(createHmac("sha256", key).update(body).digest("base64url"), "utf8");
  const given = Buffer.from(m[4] ?? "", "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const h = m[2] ?? "";
  return {
    target: m[1] === "a" ? "app" : "project",
    id: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
    version: m[3] ?? "",
  };
}

/** A GitHub App's RS256 JWT: iat backdated a minute for skew, exp under GitHub's ten minute cap. */
export function githubAppJwt(privateKeyPem: string, appId: number | string, nowSec = Math.floor(Date.now() / 1000)): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: nowSec - 60, exp: nowSec + 540, iss: appId })}`;
  return `${input}.${createSign("RSA-SHA256").update(input).sign(privateKeyPem, "base64url")}`;
}

/** Constant-time string compare that tolerates different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** The backup key reads in the same form as the master key in the UI. */
export { keyFingerprint as backupKeyFingerprint };
export { escrowFingerprint, openBackupKeyEscrow, parseBackupKey, sealBackupKeyEscrow, type EscrowFile } from "./escrow.ts";
export { DOMAIN_CHECK_PREFIX, domainCheckAnswer, domainCheckToken, sameCheckValue } from "./domain-check.ts";
