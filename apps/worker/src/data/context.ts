/**
 * What every data job needs, resolved from the database: the backup key, the store for a
 * destination, and a service's sealed credentials. Kept apart from the pipelines so those can be
 * tested with plain fakes.
 */
import { join } from "node:path";
import { openServiceCredentials, readSecretValue, ServiceCredentialsError, storeSecret, type Db, type SecretAccess, type SecretVault } from "@dockify/db";
import type { DockerPort } from "./docker-port.ts";
import { backupKeyFingerprint, newBackupKey, parseBackupKey } from "./envelope.ts";
import type { ServiceCredentials } from "./services.ts";
import { LOCAL_FLAG, LocalStore, S3Store, localBackupsAllowed, type FetchLike, type ObjectStore, type OutboundGuard } from "./store.ts";

export interface BackupKeys {
  /** The secrets row the key lives in: what the escrow call names. */
  secretId: string;
  active: Buffer;
  fingerprint: string;
  /** Every key that can open a backup, by fingerprint. */
  all: Map<string, Buffer>;
}

export interface ResolvedStore {
  store: ObjectStore;
  prefix: string;
  destinationId: string | null;
  type: "s3" | "local";
}

export interface DataDeps {
  db: Db;
  vault: SecretVault;
  docker: DockerPort;
  /** Scratch space for encrypted blobs in transit. Plaintext never touches it. */
  tmpDir: string;
  backupKeys(): Promise<BackupKeys>;
  storeFor(destinationId: string | null): Promise<ResolvedStore>;
  credentials(appId: string): Promise<ServiceCredentials>;
  /** Where the updater left a pre-update control-plane dump (the shared backups volume). */
  controlDumpPath?: (dumpId: string) => string;
  now?: () => Date;
  log?: (msg: string, extra?: object) => void;
}

/** What needs no server: the database, the backup key, the stores and a service's credentials. */
export type DataStores = Omit<DataDeps, "docker">;

export class DataError extends Error {
  /** True when retrying cannot help (missing config, bad input). */
  readonly permanent: boolean;
  constructor(message: string, permanent = false) {
    super(message);
    this.name = "DataError";
    this.permanent = permanent;
  }
}

/** A data job ran past its wall clock limit (handlers.ts). Permanent: a retry would hold the lane as long again. */
export class DeadlineError extends DataError {
  constructor(message: string) {
    super(message, true);
    this.name = "DeadlineError";
  }
}

/**
 * The instance backup key, created on first use. Separate from the master key and from every
 * storage credential (security rule 19); sealed in the secrets table like any other value.
 */
export async function loadBackupKeys(db: Db, vault: SecretAccess): Promise<BackupKeys> {
  const secretId = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('dockify.backup-key'))`;
    const inst = await tx.instance.findUnique({ where: { id: 1 }, select: { backupKeySecretId: true } });
    if (!inst) throw new DataError("Finish setup before taking backups", true);
    if (inst.backupKeySecretId) return inst.backupKeySecretId;
    const id = await storeSecret(tx, vault, { kind: "backup_key", ownerType: "instance", ownerId: "1" }, newBackupKey(), null);
    await tx.instance.update({ where: { id: 1 }, data: { backupKeySecretId: id } });
    return id;
  });
  const raw = await readSecretValue(db, vault, secretId);
  if (!raw) throw new DataError("The backup key is missing", true);
  const active = parseBackupKey(raw);
  const fingerprint = backupKeyFingerprint(active);
  return { secretId, active, fingerprint, all: new Map([[fingerprint, active]]) };
}

interface StorageConfig {
  endpoint?: string;
  bucket?: string;
  region?: string;
}

export interface StoreOptions {
  localRoot: string;
  guard: OutboundGuard;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

/**
 * The store behind a destination. A null destination means "the default": the default S3
 * destination when there is one, else this server's disk unless the owner turned that off. One
 * rule for manual, scheduled and pre-deploy runs alike.
 */
export async function resolveStore(db: Db, vault: SecretAccess, destinationId: string | null, opts: StoreOptions): Promise<ResolvedStore> {
  const dest = destinationId
    ? await db.backupDestination.findUnique({ where: { id: destinationId }, include: { integration: true } })
    : await db.backupDestination.findFirst({ where: { isDefault: true }, include: { integration: true } });
  if (!dest) {
    if (!destinationId && localBackupsAllowed(opts.env)) return { store: new LocalStore(opts.localRoot), prefix: "", destinationId: null, type: "local" };
    if (destinationId) throw new DataError("That backup destination no longer exists. Pick another one in the backup schedule.", true);
    throw new DataError(`No backup destination is set up and local backups are turned off on this server (${LOCAL_FLAG}=0). Add an S3 compatible storage destination in Integrations.`, true);
  }
  if (dest.type === "local") {
    if (!localBackupsAllowed(opts.env)) throw new DataError(`Local backups are turned off on this server (${LOCAL_FLAG}=0)`, true);
    return { store: new LocalStore(opts.localRoot), prefix: dest.prefix, destinationId: dest.id, type: "local" };
  }
  const integ = dest.integration;
  if (!integ || integ.kind !== "storage") throw new DataError(`Backup destination ${dest.name} has no storage connection`, true);
  const cfg = (integ.config ?? {}) as StorageConfig;
  if (!cfg.endpoint || !cfg.bucket || !integ.secretId || !integ.secondSecretId) throw new DataError(`Storage ${integ.name} is missing its endpoint, bucket or keys`, true);
  const accessKeyId = await readSecretValue(db, vault, integ.secretId);
  const secretAccessKey = await readSecretValue(db, vault, integ.secondSecretId);
  if (!accessKeyId || !secretAccessKey) throw new DataError(`Storage ${integ.name} keys could not be opened`, true);
  const store = new S3Store(
    { endpoint: cfg.endpoint, bucket: cfg.bucket, region: cfg.region || "auto", accessKeyId, secretAccessKey },
    { guard: opts.guard, ...(opts.fetch ? { fetch: opts.fetch } : {}) },
  );
  return { store, prefix: dest.prefix, destinationId: dest.id, type: "s3" };
}

/** A service's credentials through the shared reader (@dockify/db), either stored shape. */
export async function readCredentials(db: Db, vault: SecretAccess, appId: string): Promise<ServiceCredentials> {
  const app = await db.app.findUnique({ where: { id: appId }, select: { id: true, name: true, kind: true, passwordSecretId: true } });
  if (!app) throw new DataError("That app no longer exists", true);
  try {
    return (await openServiceCredentials(db, vault, app)).credentials;
  } catch (e) {
    if (e instanceof ServiceCredentialsError) throw new DataError(e.message, true);
    throw e;
  }
}

export function createDataStores(base: { db: Db; vault: SecretVault; tmpDir: string } & StoreOptions): DataStores {
  let keys: Promise<BackupKeys> | null = null;
  return {
    db: base.db,
    vault: base.vault,
    tmpDir: base.tmpDir,
    backupKeys: () => {
      keys ??= loadBackupKeys(base.db, base.vault).catch((e: unknown) => {
        keys = null;
        throw e;
      });
      return keys;
    },
    storeFor: (id) => resolveStore(base.db, base.vault, id, base),
    credentials: (appId) => readCredentials(base.db, base.vault, appId),
    controlDumpPath: (id) => join(base.localRoot, "control", `pre-update-${id}.dump`),
  };
}

export const createDataDeps = (stores: DataStores, docker: DockerPort): DataDeps => ({ ...stores, docker });

/** A helper's output as text, up to a cap: a helper that talks too much cannot grow the worker. */
export async function readAll(stream: NodeJS.ReadableStream, cap = 64 * 1024): Promise<string> {
  let out = "";
  for await (const chunk of stream) if (out.length < cap) out += (chunk as Buffer).toString("utf8");
  return out.slice(0, cap);
}
