/**
 * Backup key escrow format. The backup key lives sealed in the control-plane database, so a lost
 * disk would leave every offsite DKBK blob unreadable even to an owner who kept the master key.
 * Every backup run therefore also writes the backup key, sealed under the master key, next to the
 * dumps. A fresh install with the same master key (or the old one in DOCKIFY_MASTER_KEY_PREVIOUS)
 * opens it with openBackupKeyEscrow and can decrypt.
 *
 * Only the api seals and opens escrow files: the worker asks the api for the text and uploads what it gets. The object carries ciphertext only.
 */
import { keyFingerprint, open, seal, type Keyring, type Sealed } from "./index.ts";

const KIND = "backup_key_escrow";
const FORMAT = "dockify-backup-key";
const KEY_BYTES = 32;

export interface EscrowFile {
  format: typeof FORMAT;
  v: 1;
  /** Fingerprint of the backup key inside. */
  fingerprint: string;
  /** Fingerprint of the master key that sealed it: the one a recovery has to load. */
  masterKey: string;
  sealed: { kekId: string; wrappedDek: string; dekNonce: string; ciphertext: string; ctNonce: string };
}

const ctx = (fingerprint: string) => ({ id: `backup-key-${fingerprint}`, kind: KIND, scope: "instance:1" });

export function parseBackupKey(base64: string): Buffer {
  const key = Buffer.from(base64.trim(), "base64");
  if (key.length !== KEY_BYTES) throw new Error("backup key must decode to 32 bytes");
  return key;
}

export function sealBackupKeyEscrow(ring: Keyring, backupKey: Buffer): string {
  const fingerprint = keyFingerprint(backupKey);
  const s = seal(ring, ctx(fingerprint), backupKey.toString("base64"));
  const file: EscrowFile = {
    format: FORMAT,
    v: 1,
    fingerprint,
    masterKey: s.kekId,
    sealed: {
      kekId: s.kekId,
      wrappedDek: s.wrappedDek.toString("base64"),
      dekNonce: s.dekNonce.toString("base64"),
      ciphertext: s.ciphertext.toString("base64"),
      ctNonce: s.ctNonce.toString("base64"),
    },
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The fingerprint an escrow file claims to hold, without opening it. */
export function escrowFingerprint(text: string): string | null {
  try {
    const f = JSON.parse(text) as Partial<EscrowFile>;
    return f.format === FORMAT && f.v === 1 && typeof f.fingerprint === "string" ? f.fingerprint : null;
  } catch {
    return null;
  }
}

/** Opens an escrow file with the master key ring. Throws when the key is wrong or the file was altered. */
export function openBackupKeyEscrow(ring: Keyring, text: string): { key: Buffer; fingerprint: string } {
  const f = JSON.parse(text) as Partial<EscrowFile>;
  if (f.format !== FORMAT || f.v !== 1 || typeof f.fingerprint !== "string" || !f.sealed) throw new Error("not a Dockify backup key file");
  const b = (v: unknown) => Buffer.from(typeof v === "string" ? v : "", "base64");
  const sealed: Sealed = {
    kekId: String(f.sealed.kekId),
    wrappedDek: b(f.sealed.wrappedDek),
    dekNonce: b(f.sealed.dekNonce),
    ciphertext: b(f.sealed.ciphertext),
    ctNonce: b(f.sealed.ctNonce),
  };
  const key = parseBackupKey(open(ring, ctx(f.fingerprint), sealed));
  const fingerprint = keyFingerprint(key);
  if (fingerprint !== f.fingerprint) throw new Error("the backup key file does not match its fingerprint");
  return { key, fingerprint };
}
