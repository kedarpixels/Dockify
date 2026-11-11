import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "@dockify/crypto";

/**
 * TOTP (RFC 6238) on node:crypto. SHA-1, 6 digits, a 30-second step: the parameters every
 * authenticator app assumes, so a bare otpauth:// URI just works.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;
const SECRET_BYTES = 20; // 160 bits, the RFC 6238 SHA-1 recommendation

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Tolerates lowercase, spaces and padding (what a human retypes). Throws on a character outside the alphabet. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${JSON.stringify(ch)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** HOTP (RFC 4226). */
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // A 64-bit big-endian counter. Bit operators are 32-bit, so the high word comes from a division.
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const mac = createHmac("sha1", secret).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/** `atMs` is unix milliseconds. */
export function totpAt(secretBase32: string, atMs: number): string {
  return hotp(base32Decode(secretBase32), Math.floor(atMs / 1000 / PERIOD_SECONDS));
}

/**
 * The time step `code` matches, or null; `window` steps either side cover a skewed clock.
 * Never short-circuits on a match, so timing cannot reveal which step hit. The counter is returned
 * so a caller can enforce single use, which RFC 6238 requires.
 */
export function totpMatchedCounter(secretBase32: string, code: string, atMs: number, window = 1): number | null {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) return null;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  let matched: number | null = null;
  for (let w = -window; w <= window; w++) {
    if (safeEqual(hotp(secret, counter + w), trimmed)) matched = counter + w;
  }
  return matched;
}

export function verifyTotp(secretBase32: string, code: string, atMs: number, window = 1): boolean {
  return totpMatchedCounter(secretBase32, code, atMs, window) !== null;
}

/** algorithm, digits and period are stated explicitly, so an app with other defaults still lands on these parameters. */
export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
