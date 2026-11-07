/**
 * Integration rows and their sealed credentials. A credential goes in through storeSecret and only
 * its hint ever comes back out of this module's responses; the plain value is opened only inside
 * the call that sends it to its own service.
 */
import type { Keyring } from "@dockify/crypto";
import { hintOf, readSecretValue, storeSecret, type Integration, type IntegrationKind, type Prisma, type SecretKind, type Tx } from "@dockify/db";
import { HttpError } from "../../errors.ts";

export type Json = Record<string, unknown>;

export const configOf = <T extends Json = Json>(row: { config: unknown }): T =>
  (row.config && typeof row.config === "object" && !Array.isArray(row.config) ? row.config : {}) as T;

export const notConnected = (what: string) => new HttpError(409, `${what} is not connected`, "NOT_CONNECTED");

export async function findIntegration(db: Tx, kind: IntegrationKind, name = "default"): Promise<Integration | null> {
  return db.integration.findUnique({ where: { kind_name: { kind, name } } });
}

/** Whether the owner finished setup; the installer's environment seeds integrations only before. */
export async function setupDone(db: Tx): Promise<boolean> {
  const inst = await db.instance.findUnique({ where: { id: 1 }, select: { setupCompletedAt: true } });
  return !!inst?.setupCompletedAt;
}

export async function requireIntegration(db: Tx, kind: IntegrationKind, name = "default", label: string = kind): Promise<Integration> {
  const row = await findIntegration(db, kind, name);
  if (!row || row.status === "disconnected") throw notConnected(label);
  return row;
}

/** Opens the primary (or second) credential of a row. Null when the row has none. */
export async function openSecret(db: Tx, ring: Keyring, row: Integration, which: "primary" | "second" = "primary"): Promise<string | null> {
  const id = which === "primary" ? row.secretId : row.secondSecretId;
  return id ? readSecretValue(db, ring, id) : null;
}

export async function hintOfSecret(db: Tx, id: string | null): Promise<string> {
  if (!id) return "";
  const s = await db.secret.findUnique({ where: { id }, select: { hint: true } });
  return s?.hint ?? "****";
}

/**
 * Seals a new value for one slot of a row and drops the value it replaces. Runs inside the caller's
 * transaction, so a failed write never leaves a row pointing at a deleted secret.
 */
export async function replaceSecret(
  tx: Tx,
  ring: Keyring,
  row: Pick<Integration, "id" | "secretId" | "secondSecretId">,
  slot: "primary" | "second",
  kind: SecretKind,
  value: string,
  hint?: string,
): Promise<string> {
  const id = await storeSecret(tx, ring, { kind, ownerType: "integration", ownerId: row.id }, value, hint ?? hintOf(value));
  const old = slot === "primary" ? row.secretId : row.secondSecretId;
  await tx.integration.update({ where: { id: row.id }, data: slot === "primary" ? { secretId: id } : { secondSecretId: id } });
  if (old) await tx.secret.delete({ where: { id: old } }).catch(() => undefined);
  return id;
}

/** Deletes a row together with its sealed credentials. */
export async function dropIntegration(tx: Tx, row: Pick<Integration, "id" | "secretId" | "secondSecretId">): Promise<void> {
  await tx.integration.delete({ where: { id: row.id } });
  const ids = [row.secretId, row.secondSecretId].filter((x): x is string => !!x);
  if (ids.length) await tx.secret.deleteMany({ where: { id: { in: ids } } });
}

export const asJson = (v: Json): Prisma.InputJsonValue => v as Prisma.InputJsonValue;
