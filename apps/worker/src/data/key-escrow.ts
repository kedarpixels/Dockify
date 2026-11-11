/**
 * The backup key lives sealed in the control-plane database, so losing that database would leave every offsite
 * backup unreadable. Each run therefore writes the key next to the dumps, sealed under the master key by the api.
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
