/**
 * Client-side backup encryption: a dump is encrypted before it reaches any destination, with a key that is
 * not the storage credential. The data key's wrap is bound to the backup id, and each chunk's AAD carries its
 * counter and a final flag, so a reordered, dropped, appended or cut stream never decrypts as a valid dump.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

export const CHUNK_BYTES = 64 * 1024;
const MAGIC = Buffer.from("DKBK\u0001", "latin1");
const KEY_BYTES = 32;
const NONCE = 12;
const TAG = 16;
/** Ciphertext chunks larger than this are refused before allocating, so a bad length cannot OOM us. */
const MAX_FRAME = CHUNK_BYTES + 1024;

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export const ALGORITHM = "AES-256-GCM, 64 KiB chunks";

import { backupKeyFingerprint, parseBackupKey } from "@dockify/crypto";

export { backupKeyFingerprint, parseBackupKey };

export function newBackupKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

function chunkNonce(base: Buffer, counter: number): Buffer {
  const n = Buffer.from(base);
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(counter));
  for (let i = 0; i < 8; i++) n[NONCE - 8 + i] = n[NONCE - 8 + i]! ^ c[i]!;
  return n;
}

function chunkAad(counter: number, final: boolean): Buffer {
  const a = Buffer.alloc(9);
  a.writeBigUInt64BE(BigInt(counter));
  a[8] = final ? 1 : 0;
  return a;
}

function wrapAad(fingerprint: string, backupId: string): Buffer {
  return Buffer.from(`dockify-backup:${fingerprint}:${backupId}`, "utf8");
}

export class EncryptStream extends Transform {
  #dek = randomBytes(KEY_BYTES);
  #base = randomBytes(NONCE);
  #pending: Buffer[] = [];
  #pendingLen = 0;
  #counter = 0;

  constructor(key: Buffer, backupId: string) {
    super();
    if (key.length !== KEY_BYTES) throw new EnvelopeError("backup key must be 32 bytes");
    const fp = Buffer.from(backupKeyFingerprint(key), "latin1");
    const wrapNonce = randomBytes(NONCE);
    const c = createCipheriv("aes-256-gcm", key, wrapNonce);
    c.setAAD(wrapAad(fp.toString("latin1"), backupId));
    const wrapped = Buffer.concat([c.update(this.#dek), c.final()]);
    this.push(Buffer.concat([MAGIC, Buffer.from([fp.length]), fp, wrapNonce, wrapped, c.getAuthTag(), this.#base]));
  }

  #emit(plain: Buffer, final: boolean): void {
    const c = createCipheriv("aes-256-gcm", this.#dek, chunkNonce(this.#base, this.#counter));
    c.setAAD(chunkAad(this.#counter, final));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(ct.length);
    this.push(Buffer.concat([len, ct, c.getAuthTag()]));
    this.#counter++;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.#pending.push(chunk);
    this.#pendingLen += chunk.length;
    // Strictly more than one chunk buffered: the last full chunk may turn out to be the final one.
    while (this.#pendingLen > CHUNK_BYTES) {
      const all = Buffer.concat(this.#pending);
      this.#emit(all.subarray(0, CHUNK_BYTES), false);
      const rest = all.subarray(CHUNK_BYTES);
      this.#pending = [rest];
      this.#pendingLen = rest.length;
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    this.#emit(Buffer.concat(this.#pending), true);
    this.#dek.fill(0);
    cb();
  }
}

export function peekFingerprint(head: Buffer): string | null {
  if (head.length < MAGIC.length + 1 || !head.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const n = head[MAGIC.length]!;
  if (head.length < MAGIC.length + 1 + n) return null;
  return head.subarray(MAGIC.length + 1, MAGIC.length + 1 + n).toString("latin1");
}

export class DecryptStream extends Transform {
  #keys: Map<string, Buffer>;
  #backupId: string;
  #buf: Buffer = Buffer.alloc(0);
  #dek: Buffer | null = null;
  #base: Buffer | null = null;
  #counter = 0;
  #done = false;
  fingerprint: string | null = null;

  /** `keys` maps fingerprint to key, so a rotated-out key still opens old backups. */
  constructor(keys: Map<string, Buffer> | Buffer, backupId: string) {
    super();
    this.#keys = Buffer.isBuffer(keys) ? new Map([[backupKeyFingerprint(keys), keys]]) : keys;
    this.#backupId = backupId;
  }

  #header(): boolean {
    const b = this.#buf;
    if (b.length < MAGIC.length + 1) return false;
    if (!b.subarray(0, MAGIC.length).equals(MAGIC)) throw new EnvelopeError("not a Dockify encrypted backup");
    const n = b[MAGIC.length]!;
    const need = MAGIC.length + 1 + n + NONCE + KEY_BYTES + TAG + NONCE;
    if (b.length < need) return false;
    let o = MAGIC.length + 1;
    const fp = b.subarray(o, o + n).toString("latin1");
    o += n;
    const key = this.#keys.get(fp);
    if (!key) throw new EnvelopeError(`this backup was encrypted with key ${fp}, which is not loaded`);
    const wrapNonce = b.subarray(o, o + NONCE);
    o += NONCE;
    const wrapped = b.subarray(o, o + KEY_BYTES);
    o += KEY_BYTES;
    const tag = b.subarray(o, o + TAG);
    o += TAG;
    const d = createDecipheriv("aes-256-gcm", key, wrapNonce);
    d.setAAD(wrapAad(fp, this.#backupId));
    d.setAuthTag(tag);
    try {
      this.#dek = Buffer.concat([d.update(wrapped), d.final()]);
    } catch {
      throw new EnvelopeError("the backup key does not open this backup, or it belongs to another backup");
    }
    this.#base = Buffer.from(b.subarray(o, o + NONCE));
    this.fingerprint = fp;
    this.#buf = b.subarray(need);
    return true;
  }

  #frames(): void {
    for (;;) {
      if (this.#buf.length < 4) return;
      const len = this.#buf.readUInt32BE(0);
      if (len > MAX_FRAME) throw new EnvelopeError("corrupt backup: chunk length out of range");
      if (this.#buf.length < 4 + len + TAG) return;
      if (this.#done) throw new EnvelopeError("corrupt backup: data after the final chunk");
      const ct = this.#buf.subarray(4, 4 + len);
      const tag = this.#buf.subarray(4 + len, 4 + len + TAG);
      this.#buf = this.#buf.subarray(4 + len + TAG);
      // The final flag is not stored: try "not final" first, then "final". Only the real one verifies.
      const plain = this.#open(ct, tag, false) ?? this.#open(ct, tag, true);
      if (!plain) throw new EnvelopeError("corrupt or tampered backup chunk");
      this.#counter++;
      if (plain.final) this.#done = true;
      if (plain.data.length) this.push(plain.data);
    }
  }

  #open(ct: Buffer, tag: Buffer, final: boolean): { data: Buffer; final: boolean } | null {
    const d = createDecipheriv("aes-256-gcm", this.#dek!, chunkNonce(this.#base!, this.#counter));
    d.setAAD(chunkAad(this.#counter, final));
    d.setAuthTag(tag);
    try {
      return { data: Buffer.concat([d.update(ct), d.final()]), final };
    } catch {
      return null;
    }
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
      if (!this.#dek && !this.#header()) return cb();
      this.#frames();
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }

  override _flush(cb: TransformCallback): void {
    if (!this.#dek) return cb(new EnvelopeError("truncated backup: header incomplete"));
    if (this.#buf.length) return cb(new EnvelopeError("truncated backup: partial chunk at the end"));
    if (!this.#done) return cb(new EnvelopeError("truncated backup: the final chunk is missing"));
    this.#dek.fill(0);
    cb();
  }
}
