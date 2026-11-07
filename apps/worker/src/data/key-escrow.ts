/**
 * Backup key escrow. The backup key lives sealed in the control-plane database, so a lost disk or
 * a dropped dockify-db volume would leave every offsite DKBK blob unreadable even to the owner who
 * kept the master key. Every backup run therefore also writes the backup key, sealed under the
 * master key, next to the dumps at the destination.
 *
 * The worker holds no master key: it asks the api for the escrow text
 * of the backup key row (the api seals it with the format in @dockify/crypto escrow.ts, audited)
 * and uploads what comes back after checking it names the key in use. A fresh install with the
 * same master key opens it with openBackupKeyEscrow from @dockify/crypto.
 */
import { Readable } from "node:stream";
import { escrowFingerprint } from "@dockify/crypto";
import type { Db, SecretVault } from "@dockify/db";
import { assertKey, type ObjectStore } from "./store.ts";

/** `<prefix>keys/backup-key-<fingerprint>.json`, beside the apps/ tree the dumps use. */
export function escrowObjectKey(prefix: string, fingerprint: string): string {
  const p = prefix.replace(/^\/+/, "");
  const key = `${p}${p && !p.endsWith("/") ? "/" : ""}keys/backup-key-${fingerprint}.json`;
  assertKey(key);
  return key;
}

/** Writes (or rewrites, idempotently) the escrow object for the active backup key. */
export async function writeBackupKeyEscrow(
  store: ObjectStore, prefix: string, db: Db, vault: SecretVault, keys: { secretId: string; fingerprint: string },
): Promise<string> {
  const text = await vault.escrow(db, keys.secretId);
  if (escrowFingerprint(text) !== keys.fingerprint) throw new Error("the escrow the api returned does not name the backup key in use");
  const key = escrowObjectKey(prefix, keys.fingerprint);
  const body = Buffer.from(text, "utf8");
  await store.put(key, Readable.from([body]), body.length);
  return key;
}
