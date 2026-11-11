/**
 * One sealed JSON value { user, password, database? } on App.passwordSecretId; this file is the one place
 * the shape is written and read. Legacy rows hold a bare password: the worker reads either shape, and only
 * the api, which holds the master key, rewrites them as JSON.
 */
import { randomBytes } from "node:crypto";
import type { Keyring } from "@dockify/crypto";
import { readSecretValue, storeSecret, type Db, type SecretAccess, type Tx } from "./index.ts";

export const SERVICE_KIND_NAMES = ["postgres", "redis", "s3"] as const;
export type ServiceKindName = (typeof SERVICE_KIND_NAMES)[number];
export const isServiceKindName = (k: string): k is ServiceKindName => (SERVICE_KIND_NAMES as readonly string[]).includes(k);

export interface ServiceCredentials {
  user: string;
  password: string;
  /** Postgres only. */
  database?: string;
}

/** Permanent: a retry reads the same value. `permanent: true` tells the worker's job loop not to retry. */
export class ServiceCredentialsError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "ServiceCredentialsError";
  }
}

/**
 * Every password Dockify generates (24 random bytes, base64url), and legacy bare values. Safe unquoted in a
 * config file, a URL and a shell word.
 */
export const GENERATED_PASSWORD = /^[A-Za-z0-9_-]{16,128}$/;

const newPassword = () => randomBytes(24).toString("base64url");

/** The Postgres database a service gets: its app name, with dashes made Postgres friendly. */
export const databaseNameFor = (appName: string): string => appName.replace(/-/g, "_");

export function generateServiceCredentials(kind: ServiceKindName, appName: string): ServiceCredentials {
  if (kind === "postgres") return { user: "dockify", password: newPassword(), database: databaseNameFor(appName) };
  if (kind === "redis") return { user: "default", password: newPassword() };
  return { user: `dk${randomBytes(6).toString("hex")}`, password: newPassword() };
}

/** The sealed text: always this JSON shape, keys in a fixed order. */
export function serializeServiceCredentials(c: ServiceCredentials): string {
  return JSON.stringify({ user: c.user, password: c.password, ...(c.database !== undefined ? { database: c.database } : {}) });
}

export interface ParsedCredentials {
  credentials: ServiceCredentials;
  /** The row still holds an older install's bare password. */
  legacy: boolean;
}

/** What a legacy bare password stands for, completed the way generateServiceCredentials would. */
function fromLegacy(kind: ServiceKindName, appName: string, password: string): ServiceCredentials {
  if (kind === "postgres") return { user: "dockify", password, database: databaseNameFor(appName) };
  if (kind === "redis") return { user: "default", password };
  return { user: "dockify", password };
}

/**
 * Reads a sealed value. Never throws a raw JSON error: anything unreadable becomes one
 * ServiceCredentialsError that names the service and never quotes the value.
 */
export function parseServiceCredentials(raw: string, svc: { kind: ServiceKindName; name: string }): ParsedCredentials {
  const text = raw.trim();
  const damaged = () => new ServiceCredentialsError(`The stored credentials of ${svc.name} are damaged and cannot be read`);
  if (text.startsWith("{")) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw damaged();
    }
    const o = (v ?? {}) as Record<string, unknown>;
    if (typeof o.user !== "string" || !o.user || typeof o.password !== "string" || !o.password) throw damaged();
    if (o.database !== undefined && (typeof o.database !== "string" || !o.database)) throw damaged();
    return {
      credentials: { user: o.user, password: o.password, ...(typeof o.database === "string" ? { database: o.database } : {}) },
      legacy: false,
    };
  }
  if (GENERATED_PASSWORD.test(text)) return { credentials: fromLegacy(svc.kind, svc.name, text), legacy: true };
  throw damaged();
}

/** Returns the new row's id, for App.passwordSecretId. */
export function sealServiceCredentials(tx: Tx, access: SecretAccess, appId: string, c: ServiceCredentials): Promise<string> {
  return storeSecret(tx, access, { kind: "database_password", ownerType: "app", ownerId: appId }, serializeServiceCredentials(c), null);
}

export interface CredentialHolder {
  id: string;
  name: string;
  kind: string;
  passwordSecretId: string | null;
}

/**
 * Opens and parses a service's credentials, either shape. A missing or unreadable row is a
 * ServiceCredentialsError; a vault that cannot be reached throws its own error, which a job retries.
 */
export async function openServiceCredentials(tx: Tx, access: SecretAccess, app: CredentialHolder): Promise<ParsedCredentials> {
  if (!isServiceKindName(app.kind)) throw new ServiceCredentialsError(`${app.name} is not a managed service`);
  if (!app.passwordSecretId) throw new ServiceCredentialsError(`${app.name} has no stored credentials`);
  const raw = await readSecretValue(tx, access, app.passwordSecretId);
  if (raw === null) throw new ServiceCredentialsError(`The stored credentials of ${app.name} are missing`);
  return parseServiceCredentials(raw, { kind: app.kind, name: app.name });
}

/**
 * Rewrites one legacy row as JSON. The app is repointed only if it still points at the old row, so a
 * concurrent upgrade wins once. The password is the same value, so nothing running needs to change.
 */
export async function upgradeServiceCredentials(db: Db, ring: Keyring, app: CredentialHolder & { passwordSecretId: string }, c: ServiceCredentials): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const id = await sealServiceCredentials(tx, ring, app.id, c);
    const moved = await tx.app.updateMany({ where: { id: app.id, passwordSecretId: app.passwordSecretId }, data: { passwordSecretId: id } });
    if (moved.count !== 1) {
      await tx.secret.delete({ where: { id } });
      return false;
    }
    await tx.secret.deleteMany({ where: { id: app.passwordSecretId } });
    return true;
  });
}

/** Idempotent and safe to run at every api start. A row that cannot be read is left as it is and reported back. */
export async function upgradeLegacyServiceCredentials(db: Db, ring: Keyring): Promise<{ upgraded: number; unreadable: string[] }> {
  const apps = await db.app.findMany({
    where: { kind: { in: [...SERVICE_KIND_NAMES] }, passwordSecretId: { not: null } },
    select: { id: true, name: true, kind: true, passwordSecretId: true },
  });
  let upgraded = 0;
  const unreadable: string[] = [];
  for (const app of apps) {
    try {
      const parsed = await openServiceCredentials(db, ring, app);
      if (parsed.legacy && (await upgradeServiceCredentials(db, ring, { ...app, passwordSecretId: app.passwordSecretId! }, parsed.credentials))) upgraded++;
    } catch {
      unreadable.push(app.name);
    }
  }
  return { upgraded, unreadable };
}
