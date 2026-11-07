import { randomUUID } from "node:crypto";
import { open, parseBackupKey, rewrap, seal, sealBackupKeyEscrow, type Keyring, type Sealed } from "@dockify/crypto";
import { PrismaClient, type Prisma, type SecretKind } from "../generated/client/index.js";

export * from "../generated/client/index.js";
export * from "./icons.ts";
export * from "./wait.ts";

export type Db = PrismaClient;
/** A client or an interactive transaction: everything a query helper needs. */
export type Tx = Prisma.TransactionClient | PrismaClient;

/** One client per process. Callers pass it down; nothing imports a global client. */
export function createDb(url?: string): PrismaClient {
  return new PrismaClient({ log: ["warn", "error"], ...(url ? { datasources: { db: { url } } } : {}) });
}

export interface SecretOwner {
  kind: SecretKind;
  ownerType: string;
  ownerId: string;
}

/** Prisma's Bytes wants a Uint8Array over a plain ArrayBuffer. */
const bytes = (b: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(b);

const scopeOf = (o: SecretOwner) => `${o.ownerType}:${o.ownerId}`;

/**
 * Who can seal and open secret rows. The api holds the master key and uses the keyring directly;
 * the worker holds no key and goes through the api's internal secrets routes,
 * receiving only the plaintext values of the rows it names, each call audited by the api.
 */
export interface SecretVault {
  /** Plaintext by row id. A missing row maps to null; a row that will not open throws. */
  open(tx: Tx, ids: string[]): Promise<Map<string, string | null>>;
  /** Seals a value for a new row. The id is chosen first because it is part of the AAD. */
  seal(owner: SecretOwner & { id: string }, value: string): Promise<Sealed>;
  /** A portable copy of a backup_key row sealed under the master key, for offsite escrow. */
  escrow(tx: Tx, id: string): Promise<string>;
}

export type SecretAccess = Keyring | SecretVault;

const sealedOf = (row: { kekId: string; wrappedDek: Uint8Array; dekNonce: Uint8Array; ciphertext: Uint8Array; ctNonce: Uint8Array }): Sealed => ({
  kekId: row.kekId,
  wrappedDek: Buffer.from(row.wrappedDek),
  dekNonce: Buffer.from(row.dekNonce),
  ciphertext: Buffer.from(row.ciphertext),
  ctNonce: Buffer.from(row.ctNonce),
});

/** The vault of a process that holds the master key (the api). */
export function keyringVault(ring: Keyring): SecretVault {
  return {
    async open(tx, ids) {
      const out = new Map<string, string | null>();
      if (!ids.length) return out;
      // One id is the common api path; a single findUnique keeps it one indexed read.
      const rows = ids.length === 1
        ? [await tx.secret.findUnique({ where: { id: ids[0] as string } })].filter((r) => r !== null)
        : await tx.secret.findMany({ where: { id: { in: ids } } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of ids) {
        const row = byId.get(id);
        out.set(id, row ? open(ring, { id: row.id, kind: row.kind, scope: `${row.ownerType}:${row.ownerId}` }, sealedOf(row)) : null);
      }
      return out;
    },
    async seal(owner, value) {
      return seal(ring, { id: owner.id, kind: owner.kind, scope: scopeOf(owner) }, value);
    },
    async escrow(tx, id) {
      const row = await tx.secret.findUnique({ where: { id } });
      if (!row || row.kind !== "backup_key") throw new Error("not a backup key row");
      const raw = open(ring, { id: row.id, kind: row.kind, scope: `${row.ownerType}:${row.ownerId}` }, sealedOf(row));
      return sealBackupKeyEscrow(ring, parseBackupKey(raw));
    },
  };
}

/** What a master key rotation could not re-seal; the transaction holding the rows rolls back. */
export class RewrapError extends Error {}

/**
 * Re-seals every row an earlier master key sealed under the active key, with a fresh data key each,
 * and returns how many. Call it in a transaction: every row is re-sealed and read back before the
 * first write, so a row that will not open stops the run with nothing written. Writers to the table
 * wait for the commit; readers keep reading the old rows until then. updatedAt stays, since no value
 * changed.
 */
export async function rewrapSecretRows(tx: Prisma.TransactionClient, ring: Keyring): Promise<number> {
  await tx.$executeRaw`LOCK TABLE secrets IN SHARE ROW EXCLUSIVE MODE`;
  const rows = await tx.secret.findMany({ where: { kekId: { not: ring.active } } });
  const refused: string[] = [];
  const sealed = rows.map((row) => {
    const ctx = { id: row.id, kind: row.kind, scope: `${row.ownerType}:${row.ownerId}` };
    try {
      const next = rewrap(ring, ctx, sealedOf(row));
      if (open(ring, ctx, next) !== open(ring, ctx, sealedOf(row))) throw new Error("It read back differently.");
      return next;
    } catch (e) {
      refused.push(`${row.id} (${row.kind}): ${(e as Error).message}`);
      return null;
    }
  });
  if (refused.length) {
    throw new RewrapError(`${refused.length} of ${rows.length} secrets could not be re-sealed:\n  ${refused.slice(0, 10).join("\n  ")}`);
  }
  for (const [i, row] of rows.entries()) {
    const s = sealed[i] as Sealed;
    await tx.secret.update({
      where: { id: row.id },
      data: { kekId: s.kekId, wrappedDek: bytes(s.wrappedDek), dekNonce: bytes(s.dekNonce), ciphertext: bytes(s.ciphertext), ctNonce: bytes(s.ctNonce), updatedAt: row.updatedAt },
    });
  }
  return rows.length;
}

export const vaultOf = (access: SecretAccess): SecretVault => ("keys" in access ? keyringVault(access) : access);

/**
 * The alert rules that exist. The database enum still holds http_5xx, a rule nothing could ever feed,
 * so a row an earlier version stored stays where it is: never listed, never judged, never changed.
 */
export const LIVE_ALERT_METRIC = { not: "http_5xx" } as const;

/** Last four characters, the only part of a credential ever shown back. */
export function hintOf(value: string): string {
  return value.length <= 8 ? "****" : value.slice(-4);
}

/**
 * Seals and stores a value. The row id is chosen before sealing because it is part of the AAD.
 * The hint is opt-in: it defaults to null so no plaintext fragment of a tenant secret (env vars,
 * generated passwords, snapshots, TOTP seeds) ever lands in the database. Only credentials that
 * are shown back in the UI (integration tokens) pass hintOf(value) explicitly.
 * Returns the new secret id.
 */
export async function storeSecret(tx: Tx, access: SecretAccess, owner: SecretOwner, value: string, hint?: string | null): Promise<string> {
  const id = randomUUID();
  const s = await vaultOf(access).seal({ ...owner, id }, value);
  await tx.secret.create({
    data: {
      id,
      kind: owner.kind,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      kekId: s.kekId,
      wrappedDek: bytes(s.wrappedDek),
      dekNonce: bytes(s.dekNonce),
      ciphertext: bytes(s.ciphertext),
      ctNonce: bytes(s.ctNonce),
      hint: hint ?? null,
    },
  });
  return id;
}

/** Opens a stored secret. Throws CryptoError on a wrong key or a moved or tampered row. */
export async function readSecretValue(tx: Tx, access: SecretAccess, id: string): Promise<string | null> {
  return (await vaultOf(access).open(tx, [id])).get(id) ?? null;
}

/** Opens several at once: one audited call for the worker instead of one per value. */
export async function readSecretValues(tx: Tx, access: SecretAccess, ids: string[]): Promise<Map<string, string | null>> {
  return vaultOf(access).open(tx, [...new Set(ids)]);
}

export { defaultServerId, enqueue, enqueuePreviewTx, enqueueTx } from "./queue.ts";
export * from "./service-credentials.ts";
export * from "./service-links.ts";
