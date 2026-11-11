/**
 * Backup, restore and restore test, each a job on the data lane so a long dump never blocks a deploy. Only
 * ciphertext touches scratch files, and a restore verifies the whole download before anything is replayed.
 */
import { readAll } from "./context.ts";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Transform, Writable, type Readable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { Backup, Prisma, Tx } from "@dockify/db";
import { reason as message } from "@dockify/engine";
import { isPermanentError } from "../errors.ts";
import type { DataDeps } from "./context.ts";
import { DataError, DeadlineError } from "./context.ts";
import type { ExecHandle } from "./docker-port.ts";
import {
  pgDumpCommand, psqlCommand, redisDumpCommand, redisShutdownCommand, redisStageCommand, redisSwapCommand, restoreCheckCommand,
  parseRestoreCheck, RestoreFramer, type Command,
} from "./dump.ts";
import { DecryptStream, EncryptStream } from "./envelope.ts";
import { resolveServiceImage } from "./images.ts";
import { writeBackupKeyEscrow } from "./key-escrow.ts";
import { discardRestoreScratch, RESTORE_TEST_NAME, RESTORE_TEST_ROLE, restoreTestContainer, restoreTestVolume } from "./leftovers.ts";
import { deployManagedService, verifyCredentials } from "./managed.ts";
import {
  containerNameFor, generateCredentials, HELPER_NETWORK, LABEL_APP, LABEL_ROLE, provisionService, SERVICE_IMAGES, STORAGE_UNAVAILABLE, waitReady,
  type ServiceApp, type ServiceCredentials, type ServiceKind,
} from "./services.ts";
import { backupKindFor, backupSourceOf, isServiceKind, type AppSnapshot, type RestorePayload } from "./requests.ts";
import { backupObjectKey } from "./store.ts";
import { tierOfType } from "./tiers.ts";
import { TarGuard } from "./tar-guard.ts";
import { assertRoom, openVolumeDump, restoreVolumes, RoomWatch, TAR_CHANGED_EXIT, TarChecked, testVolumeRestore, type VolumeApp } from "./volume-backup.ts";

const STDERR_TAIL = 2_000;
const SERVICE_KINDS_SIBLINGS = ["frontend", "backend", "bot"] as const;
const DEPLOY_IN_FLIGHT = ["queued", "building", "deploying", "cancelling"] as const;

export class HashCount extends Transform {
  #h = createHash("sha256");
  #max: number;
  bytes = 0;
  /** `max`: fails the stream past this many bytes, before the byte over it is passed on. */
  constructor(max = Infinity) {
    super();
    this.#max = max;
  }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.#max) return cb(new DataError(`The stored backup is larger than the ${this.#max} bytes recorded for it`, true));
    this.#h.update(chunk);
    cb(null, chunk);
  }
  digest(): string {
    return this.#h.digest("hex");
  }
}

const devNull = () => new Writable({ write: (_c, _e, cb) => cb() });

export function checkExit(what: string, r: { exitCode: number; stderr: string }): void {
  if (r.exitCode !== 0) throw new DataError(`${what} exited with code ${r.exitCode}: ${r.stderr.slice(-STDERR_TAIL).trim() || "no output"}`);
}


interface ServiceTarget {
  app: ServiceApp;
  containerId: string;
  creds: ServiceCredentials;
}

async function serviceApp(deps: DataDeps, appId: string): Promise<ServiceApp> {
  const app = await deps.db.app.findUnique({ where: { id: appId }, include: { environment: { select: { projectId: true } } } });
  if (!app) throw new DataError("That app no longer exists", true);
  if (!isServiceKind(app.kind)) throw new DataError(`${app.name} is not a managed service`, true);
  return {
    id: app.id,
    name: app.name,
    kind: app.kind as ServiceKind,
    environmentId: app.environmentId,
    projectId: app.environment.projectId,
    image: app.image,
    memoryLimitMb: app.memoryLimitMb,
    cpuLimit: app.cpuLimit,
    pidsLimit: app.pidsLimit,
  };
}

async function locate(deps: DataDeps, app: ServiceApp): Promise<string> {
  const s = await deps.docker.inspect(containerNameFor(app.id));
  if (!s) throw new DataError(`${app.name} has no container. Start it first.`, true);
  if (s.labels[LABEL_APP] !== app.id || s.labels["dockify.managed"] !== "true") throw new DataError(`The container found for ${app.name} is not one Dockify manages`, true);
  if (!s.running) throw new DataError(`${app.name} is not running. Start it first.`, true);
  // Address it by its managed name (dk-<appId>), not the daemon id: the socket proxy can then gate
  // exec/attach to dk-/dockify-rt-/dockify-bk- names, so a compromised worker cannot exec into the
  // api or postgres control containers to read the master key.
  return containerNameFor(app.id);
}

export async function target(deps: DataDeps, appId: string): Promise<ServiceTarget> {
  const app = await serviceApp(deps, appId);
  return { app, containerId: await locate(deps, app), creds: await deps.credentials(app.id) };
}

/** An app whose own volumes are backed up as files. It need not be running: a helper mounts them. */
export async function volumeApp(deps: DataDeps, appId: string): Promise<VolumeApp> {
  const app = await deps.db.app.findUnique({ where: { id: appId }, select: { id: true, name: true, kind: true, environmentId: true, volumes: { select: { name: true }, orderBy: { createdAt: "asc" } } } });
  if (!app) throw new DataError("That app no longer exists", true);
  if (isServiceKind(app.kind) || backupSourceOf(app) !== "volume") throw new DataError(`${app.name} has no volume of its own to back up`, true);
  return { id: app.id, name: app.name, environmentId: app.environmentId, volumes: app.volumes.map((v) => v.name) };
}

const exec = (deps: DataDeps, id: string, c: Command, stdin = false) => deps.docker.exec(id, { cmd: c.cmd, env: c.env, stdin });
/** An exec whose output nobody reads: discarded, so the process is never held back on it. */
const execQuiet = async (deps: DataDeps, id: string, c: Command, stdin = false) => {
  const h = await exec(deps, id, c, stdin);
  h.stdout.resume();
  return h;
};

interface DumpSource {
  handle: ExecHandle;
  cleanup: () => Promise<void>;
}

async function openDump(deps: DataDeps, backup: Backup, t: ServiceTarget): Promise<DumpSource> {
  if (backup.kind === "postgres") return { handle: await exec(deps, t.containerId, pgDumpCommand(t.creds)), cleanup: async () => {} };
  if (backup.kind === "redis") return { handle: await exec(deps, t.containerId, redisDumpCommand(t.creds)), cleanup: async () => {} };
  // The volume of a Storage service, which no longer runs. An app's own volumes go through openVolumeDump.
  if (backup.kind === "volume") throw new DataError(STORAGE_UNAVAILABLE, true);
  throw new DataError(`backups of kind ${backup.kind} are taken by the control plane updater`, true);
}

const failureData = (e: unknown, final: boolean) =>
  final || isPermanentError(e) ? { status: "failed" as const, error: message(e), finishedAt: new Date() } : { error: message(e) };

/**
 * Writes every chunk to each branch, waiting for all of them to drain: one dump feeds the
 * encryption of each copy at the pace of the slowest.
 */
class Fan extends Writable {
  readonly #outs: Writable[];
  constructor(outs: Writable[]) {
    super();
    this.#outs = outs;
  }
  override _write(chunk: Buffer, _e: BufferEncoding, cb: (err?: Error | null) => void): void {
    let waiting = 0;
    for (const o of this.#outs) {
      if (o.write(chunk)) continue;
      waiting++;
      o.once("drain", () => {
        if (--waiting === 0) cb();
      });
    }
    if (waiting === 0) cb();
  }
  override _final(cb: (err?: Error | null) => void): void {
    for (const o of this.#outs) o.end();
    cb();
  }
}

interface Copy {
  row: Backup;
  tmp: string;
  counter: HashCount;
}

/**
 * One dump, gzipped once, then encrypted and stored once per copy: a bucket that is down never fails the local
 * copy. `final` (the last attempt) or a permanent error fails a row at once; otherwise the retry dumps again.
 * Answers the bytes of the files in an archive of volumes, null for any other dump.
 */
export async function runBackup(deps: DataDeps, backupId: string, final = true, copyIds: readonly string[] = []): Promise<number | null> {
  const { db } = deps;
  const backup = await db.backup.findUnique({ where: { id: backupId } });
  if (!backup) throw new DataError("That backup row no longer exists", true);
  if (backup.kind === "control_plane") {
    if (backup.status === "running") await copyControlPlaneDump(deps, backup, final);
    return null;
  }
  const extra = copyIds.length ? await db.backup.findMany({ where: { id: { in: [...copyIds] }, sourceAppId: backup.sourceAppId } }) : [];
  const rows = [backup, ...extra].filter((r) => r.status === "running");
  if (!rows.length) return null;
  if (!backup.appId) {
    const gone = new DataError("The app was deleted before its backup ran", true);
    for (const r of rows) await db.backup.update({ where: { id: r.id }, data: failureData(gone, true) });
    throw gone;
  }

  const copies: Copy[] = rows.map((row) => ({ row, tmp: join(deps.tmpDir, `backup-${row.id}.dkbk`), counter: new HashCount() }));
  let source: DumpSource | null = null;
  let fan: Fan | null = null;
  let checked: TarChecked | null = null;
  let firstError: unknown = null;
  const settled = new Set<string>();
  const fail = async (c: Copy, e: unknown) => {
    firstError ??= e;
    settled.add(c.row.id);
    await db.backup.update({ where: { id: c.row.id }, data: failureData(e, final) });
  };
  try {
    // Inside the try: a scratch folder that cannot be made fails the rows with its reason.
    await mkdir(deps.tmpDir, { recursive: true, mode: 0o700 });
    const sourceApp = await db.app.findUnique({ where: { id: backup.appId }, select: { kind: true } });
    // An app's own volumes, read by a helper. A Storage service's volume backup still ends in openDump's refusal.
    const files = backup.kind === "volume" && !!sourceApp && !isServiceKind(sourceApp.kind) ? await volumeApp(deps, backup.appId) : null;
    const t = files ? null : await target(deps, backup.appId);
    const keys = await deps.backupKeys();
    // Each destination first: one that cannot be reached fails its copy before anything is dumped.
    const live: Array<Copy & { dest: Awaited<ReturnType<DataDeps["storeFor"]>> }> = [];
    for (const c of copies) {
      try {
        live.push({ ...c, dest: await deps.storeFor(c.row.destinationId) });
      } catch (e) {
        await fail(c, e);
      }
    }
    if (!live.length) throw firstError;
    source = files ? await openVolumeDump(deps, backup.id, files) : await openDump(deps, backup, t!);
    const branches = live.map((c) => {
      const into = new PassThrough();
      return { into, done: pipeline(into, new EncryptStream(keys.active, c.row.id), c.counter, createWriteStream(c.tmp, { mode: 0o600 })) };
    });
    fan = new Fan(branches.map((b) => b.into));
    if (files) checked = new TarChecked();
    // An archive of volumes can be as large as the disk, so its staged ciphertext is watched (scratchDisk).
    const flow = checked ? pipeline(source.handle.stdout, checked, createGzip({ level: 6 }), new RoomWatch(deps.scratchDisk), fan) : pipeline(source.handle.stdout, createGzip({ level: 6 }), fan);
    const [, result] = await Promise.all([flow, source.handle.done, ...branches.map((b) => b.done)]);
    if (files && result.exitCode === TAR_CHANGED_EXIT) {
      // Nothing is paused for a backup of volumes, so this is expected of a busy one. The archive is whole.
      await activity(deps, "backup.run", "backed up the volumes of", files.id, files.name, false, `Some files changed while they were read: ${result.stderr.slice(-200).trim() || "tar named none"}`);
    } else checkExit(backup.kind === "postgres" ? "pg_dump" : backup.kind === "redis" ? "redis-cli" : "tar", result);

    for (const c of live) {
      try {
        const key = backupObjectKey(c.dest.prefix, { sourceAppId: c.row.sourceAppId, backupId: c.row.id, createdAt: c.row.createdAt, kind: c.row.kind });
        // A local copy lands on the same disk as the staged one, so it needs that much room again.
        if (files && c.dest.type === "local") await assertRoom(deps.scratchDisk, c.counter.bytes, (need, free, floor) => `The copy on this server needs ${need} and its disk has ${free} free. Dockify keeps ${floor} free, so it was not stored.`);
        await c.dest.store.put(key, createReadStream(c.tmp), c.counter.bytes);
        // The backup key travels with the dumps, sealed under the master key, so losing this server's
        // database never makes the offsite copies unreadable (key-escrow.ts).
        await writeBackupKeyEscrow(c.dest.store, c.dest.prefix, deps.db, deps.vault, keys);
        const now = deps.now?.() ?? new Date();
        await db.backup.update({
          where: { id: c.row.id },
          data: {
            status: "ready",
            objectKey: key,
            sizeBytes: BigInt(c.counter.bytes),
            sha256: c.counter.digest(),
            encrypted: true,
            keyFingerprint: keys.fingerprint,
            destinationId: c.dest.destinationId,
            finishedAt: now,
            error: null,
          },
        });
        settled.add(c.row.id);
        // A scheduled run's tier counts its next run from when this one finished.
        if (c.row.trigger === "schedule") {
          await db.backupSchedule.updateMany({ where: { appId: backup.appId, tier: tierOfType(c.dest.type), OR: [{ lastRunAt: null }, { lastRunAt: { lt: now } }] }, data: { lastRunAt: now } }).catch(() => {});
        }
      } catch (e) {
        await fail(c, e);
      }
    }
    if (firstError) throw firstError;
    return checked ? checked.guard.summary.bytes : null;
  } catch (e) {
    await source?.handle.kill().catch(() => {});
    fan?.destroy();
    for (const c of copies) if (!settled.has(c.row.id)) await db.backup.update({ where: { id: c.row.id }, data: failureData(e, final) });
    throw e;
  } finally {
    await source?.cleanup();
    for (const c of copies) await rm(c.tmp, { force: true });
  }
}

/** The updater (which holds no vault) recorded the dump's sha256; it is checked while the dump is gzipped and encrypted. */
async function copyControlPlaneDump(deps: DataDeps, backup: Backup, final: boolean): Promise<void> {
  const { db } = deps;
  const expected = (backup.appSnapshot as { dumpSha256?: unknown } | null)?.dumpSha256;
  const src = deps.controlDumpPath?.(backup.id);
  const tmp = join(deps.tmpDir, `backup-${backup.id}.dkbk`);
  try {
    await mkdir(deps.tmpDir, { recursive: true, mode: 0o700 });
    if (!src || typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new DataError("The control-plane dump has no recorded checksum", true);
    const keys = await deps.backupKeys();
    const dest = await deps.storeFor(backup.destinationId);
    const plain = new HashCount();
    const counter = new HashCount();
    await pipeline(createReadStream(src), plain, createGzip({ level: 6 }), new EncryptStream(keys.active, backup.id), counter, createWriteStream(tmp, { mode: 0o600 }));
    if (plain.digest() !== expected) throw new DataError("The control-plane dump on disk does not match the checksum the updater recorded", true);
    const key = backupObjectKey(dest.prefix, { sourceAppId: backup.sourceAppId, backupId: backup.id, createdAt: backup.createdAt, kind: backup.kind });
    await dest.store.put(key, createReadStream(tmp), counter.bytes);
    await writeBackupKeyEscrow(dest.store, dest.prefix, deps.db, deps.vault, keys);
    await db.backup.update({
      where: { id: backup.id },
      data: {
        status: "ready", objectKey: key, sizeBytes: BigInt(counter.bytes), sha256: counter.digest(), encrypted: true,
        keyFingerprint: keys.fingerprint, destinationId: dest.destinationId, finishedAt: deps.now?.() ?? new Date(), error: null,
      },
    });
  } catch (e) {
    await db.backup.update({ where: { id: backup.id }, data: failureData(e, final) });
    throw e;
  } finally {
    await rm(tmp, { force: true });
  }
}

function restorable(b: Backup | null): asserts b is Backup & { objectKey: string } {
  if (!b) throw new DataError("That backup does not exist", true);
  if (b.status !== "ready" || !b.objectKey) throw new DataError("Only a finished backup can be restored", true);
  if (b.expiredAt) throw new DataError("This backup has expired and its file was removed", true);
  // A control-plane dump is restored by the updater's rollback or by hand, never into an app.
  if (b.kind === "control_plane") throw new DataError("A control-plane dump cannot be restored into an app", true);
}

/**
 * Downloads the ciphertext and proves it whole before anything is touched: sha256, every chunk through the
 * final one, a clean gzip end, the tar guard. Returns the scratch path (still ciphertext).
 */
export async function fetchVerified(deps: DataDeps, backup: Backup & { objectKey: string }, guard?: TarGuard): Promise<string> {
  await mkdir(deps.tmpDir, { recursive: true, mode: 0o700 });
  const tmp = join(deps.tmpDir, `restore-${backup.id}-${Date.now()}.dkbk`);
  try {
    const dest = await deps.storeFor(backup.destinationId);
    // The store is not trusted with the length: a body that never ends would fill the disk before
    // the checksum is ever compared.
    const max = backup.sizeBytes == null ? undefined : Number(backup.sizeBytes);
    const counter = new HashCount(max);
    await pipeline(await dest.store.get(backup.objectKey, max), counter, createWriteStream(tmp, { mode: 0o600 }));
    if (backup.sha256 && counter.digest() !== backup.sha256) throw new DataError("The stored backup does not match its checksum", true);
    const keys = await deps.backupKeys();
    const sink = guard ?? (backup.kind === "volume" ? new TarGuard() : devNull());
    await pipeline(createReadStream(tmp), new DecryptStream(keys.all, backup.id), createGunzip(), sink);
    return tmp;
  } catch (e) {
    await rm(tmp, { force: true });
    throw e instanceof DataError ? e : new DataError(`The backup failed verification: ${message(e)}`, true);
  }
}

async function plain(deps: DataDeps, tmp: string, backupId: string): Promise<Readable> {
  const keys = await deps.backupKeys();
  const out = new PassThrough();
  pipeline(createReadStream(tmp), new DecryptStream(keys.all, backupId), createGunzip(), out).catch((e: unknown) => out.destroy(e as Error));
  return out;
}

/**
 * Feeds the verified dump into psql inside one explicit transaction. If the source fails, the
 * pipeline destroys psql's stdin without the COMMIT line, and the transaction rolls back.
 */
export async function replayPostgres(deps: DataDeps, tmp: string, backupId: string, containerId: string, creds: ServiceCredentials, replace: boolean): Promise<void> {
  const h = await execQuiet(deps, containerId, psqlCommand(creds), true);
  if (!h.stdin) throw new DataError("psql was started without stdin");
  try {
    await pipeline(await plain(deps, tmp, backupId), new RestoreFramer({ replace }), h.stdin);
  } catch (e) {
    await h.kill().catch(() => {});
    const late = await h.done.then(() => null, (d: unknown) => d);
    // Past the job's limit the cut stream is the symptom; the limit is the reason.
    if (late instanceof DeadlineError) throw late;
    throw new DataError(`The restore was rolled back: ${message(e)}`);
  }
  checkExit("psql", await h.done);
}

async function replayRedis(deps: DataDeps, tmp: string, backupId: string, t: ServiceTarget): Promise<void> {
  const stage = await execQuiet(deps, t.containerId, redisStageCommand(), true);
  if (!stage.stdin) throw new DataError("the staging exec was started without stdin");
  await pipeline(await plain(deps, tmp, backupId), stage.stdin);
  checkExit("staging the snapshot", await stage.done);
  const swap = await execQuiet(deps, t.containerId, redisSwapCommand(t.creds));
  checkExit("swapping the snapshot in", await swap.done);
  await execQuiet(deps, t.containerId, redisShutdownCommand(t.creds)).then((h) => h.done).catch(() => {});
  // Stop waits for the exit the shutdown began, or finds it over; a restart policy may have started it again.
  await deps.docker.stop(t.containerId, 10).catch(() => {});
  try {
    await deps.docker.start(t.containerId);
    await waitReady(deps.docker, t.containerId);
    await verifyCredentials(deps.docker, t.containerId, "redis", t.creds);
  } catch (e) {
    throw new DataError(`Redis did not come back on the restored snapshot, which may be newer than this version can read: ${message(e)}. The backup taken just before this restore holds the data it replaced.`, true);
  }
}

export async function quiesce(deps: DataDeps, jobId: string, payload: Pick<RestorePayload, "quiesced" | "resumedAt">, environmentId: string, opts: QuiesceOptions = {}): Promise<string[]> {
  const siblings = await deps.db.app.findMany({
    where: { environmentId, kind: { in: [...SERVICE_KINDS_SIBLINGS] }, desiredState: "running" },
    select: { id: true },
  });
  return stopRunning(deps, jobId, payload, siblings.map((s) => s.id), opts);
}

const lockDeploy = (tx: Tx, appId: string) => {
  const key = `deploy:${appId}`;
  return tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
};

/**
 * Marks the apps as held by this restore (App.quiescedByJobId) and records what will be stopped, in one
 * transaction under each app's deploy lock. What runs is read under those locks, and an open deploy or start of
 * a held app refuses the restore: so nothing can start one between this look and the mark.
 */
async function hold(deps: DataDeps, jobId: string, payload: object, ids: readonly string[], own: string | null): Promise<string[]> {
  return deps.db.$transaction(
    async (tx) => {
      for (const id of [...new Set([...(own ? [own] : []), ...ids])].sort()) await lockDeploy(tx, id);
      const running: string[] = [];
      for (const id of ids) {
        const st = await deps.docker.inspect(containerNameFor(id));
        if (st?.running && st.labels[LABEL_APP] === id) running.push(id);
      }
      const held = [...new Set([...(own ? [own] : []), ...running])];
      const rows = held.length ? await tx.app.findMany({ where: { id: { in: held } }, select: { id: true, name: true, quiescedByJobId: true } }) : [];
      for (const a of rows) {
        if (a.quiescedByJobId && a.quiescedByJobId !== jobId) throw new DataError(`Another restore is holding ${a.name}. Restore when it has finished.`, true);
        const busy =
          (await tx.deployment.findFirst({ where: { appId: a.id, previewId: null, status: { in: [...DEPLOY_IN_FLIGHT] } }, select: { id: true } })) ??
          (await tx.job.findFirst({ where: { dedupeKey: { in: [`deploy:${a.id}`, `app.power:${a.id}:start`, `app.power:${a.id}:restart`] }, completedAt: null, failedAt: null }, select: { id: true } }));
        if (busy) throw new DataError(`A deployment or a start of ${a.name} is in progress. Restore when it has finished.`, true);
      }
      if (held.length) await tx.app.updateMany({ where: { id: { in: held } }, data: { quiescedByJobId: jobId } });
      // Written BEFORE anything stops: if the worker dies from here on, recovery knows what to start.
      await tx.job.update({ where: { id: jobId }, data: { payload: { ...payload, quiesced: running } as unknown as Prisma.InputJsonValue } });
      return running;
    },
    { timeout: 30_000 },
  );
}

export interface QuiesceOptions {
  /** A restore: no deploy, start or restart of these apps until resume. A version change leaves this off, it redeploys them itself. */
  hold?: boolean;
  /** The app whose own volumes are replaced: held even when stopped. */
  own?: string;
}

/** Stops those of `ids` that run, and returns them. */
async function stopRunning(deps: DataDeps, jobId: string, payload: Pick<RestorePayload, "quiesced" | "resumedAt">, ids: readonly string[], opts: QuiesceOptions = {}): Promise<string[]> {
  let running: string[];
  if (opts.hold) running = await hold(deps, jobId, payload, ids, opts.own ?? null);
  else {
    running = [];
    for (const id of ids) {
      const st = await deps.docker.inspect(containerNameFor(id));
      if (st?.running && st.labels[LABEL_APP] === id) running.push(id);
    }
    // Written BEFORE anything stops: if the worker dies from here on, recovery knows what to start.
    await deps.db.job.update({ where: { id: jobId }, data: { payload: { ...payload, quiesced: running } as unknown as Prisma.InputJsonValue } });
  }
  try {
    for (const id of running) await deps.docker.stop(containerNameFor(id), 20);
  } catch (e) {
    // A caller that gets this error holds nothing: what did stop is started and the hold ends here.
    if (opts.hold) await resume(deps, jobId, payload, running).catch(() => {});
    throw e;
  }
  return running;
}

/**
 * Starts the apps a quiesce stopped, then ends this job's hold. With any left down, resumedAt stays unset, so
 * recovery tries them again. An app another restore holds by now is never started.
 */
export async function resume(deps: DataDeps, jobId: string, payload: Pick<RestorePayload, "quiesced" | "resumedAt">, ids: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const id of ids) {
    // Under the app's deploy lock, which a restore takes its hold under: it never finds a start half done.
    await deps.db.$transaction(
      async (tx) => {
        await lockDeploy(tx, id);
        const app = await tx.app.findUnique({ where: { id }, select: { desiredState: true, quiescedByJobId: true } });
        if (!app || app.desiredState !== "running" || (app.quiescedByJobId && app.quiescedByJobId !== jobId)) return;
        await deps.docker.start(containerNameFor(id)).catch((e: unknown) => {
          if ((e as { status?: unknown } | null)?.status !== 304) failed.push(id);
        });
      },
      { timeout: 60_000 },
    );
  }
  // One transaction: a job that reads resumed holds no app. The hold ends even for an app that would not
  // start, since a deploy may be what fixes it.
  const freed = await deps.db.$transaction(async (tx) => {
    const rows = await tx.app.findMany({ where: { quiescedByJobId: jobId }, select: { id: true } });
    if (rows.length) await tx.app.updateMany({ where: { quiescedByJobId: jobId }, data: { quiescedByJobId: null } });
    await tx.job.update({
      where: { id: jobId },
      data: { payload: { ...payload, quiesced: ids, ...(failed.length ? {} : { resumedAt: new Date().toISOString() }) } as unknown as Prisma.InputJsonValue },
    });
    return rows;
  });
  // A push that arrived meanwhile was kept, not dropped: it deploys now.
  for (const a of freed) await deps.promotePending?.(a.id).catch(() => null);
  return failed;
}

/**
 * A restore of volumes that failed after they were emptied: the app must not run on what is left. It stays
 * stopped, by its desired state, until its owner restores the backup taken just before and starts it.
 */
export async function leaveStopped(deps: DataDeps, jobId: string, payload: RestorePayload, app: { id: string; name: string }): Promise<void> {
  const { db } = deps;
  const waiting = await db.$transaction(async (tx) => {
    await tx.app.updateMany({ where: { id: app.id }, data: { desiredState: "stopped" } });
    await tx.app.updateMany({ where: { quiescedByJobId: jobId }, data: { quiescedByJobId: null } });
    await tx.job.update({ where: { id: jobId }, data: { payload: { ...payload, leftStopped: true, resumedAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue } });
    return (await tx.app.findUnique({ where: { id: app.id }, select: { pendingDeployAt: true } }))?.pendingDeployAt ?? null;
  });
  const pre = payload.preRestoreBackupId ? await db.backup.findUnique({ where: { id: payload.preRestoreBackupId }, select: { createdAt: true } }) : null;
  const which = pre ? `the pre-restore backup from ${pre.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "the backup taken just before this restore";
  await activity(deps, "backup.restore", "left stopped on purpose, after a failed restore of the volumes of", app.id, app.name, true, `Its volumes are empty or half filled, so it was not started. Restore ${which}, then start the app.`);
  // The push is kept on the app (pendingDeployAt) and deploys when the app is started (power.ts).
  if (waiting) await activity(deps, "deploy.pending", "is holding a push that arrived during the restore of", app.id, app.name, false, "It deploys when the app is started.");
}

async function activity(deps: DataDeps, action: string, verb: string, targetId: string, label: string, failed = false, suffix?: string): Promise<void> {
  await deps.db.activityLog
    .create({ data: { category: "system", action, verb, actorType: "system", targetType: "app", targetId, targetLabel: label, failed, suffix: suffix?.slice(0, 300) ?? null } })
    .catch(() => {});
}

/** A dump of what is about to be replaced, so a wrong restore is itself undoable. `fileBytes`: see runBackup. */
async function backupBeforeRestore(deps: DataDeps, appId: string, backup: Backup): Promise<{ id: string; fileBytes: number | null }> {
  const pre = await deps.db.backup.create({
    data: {
      appId,
      sourceAppId: appId,
      appSnapshot: (backup.appSnapshot ?? {}) as Prisma.InputJsonValue,
      kind: backup.kind,
      trigger: "pre_restore",
      status: "running",
      destinationId: backup.destinationId,
    },
    select: { id: true },
  });
  return { id: pre.id, fileBytes: await runBackup(deps, pre.id, true) };
}

/**
 * Over the app the backup came from, and only the volumes it still has. Verified in full first. The app is
 * stopped before the pre-restore backup, so that copy misses no write. A failure before the volumes are
 * emptied starts the app again, unchanged; one after leaves it stopped (leaveStopped).
 */
async function runVolumeRestore(deps: DataDeps, jobId: string, payload: RestorePayload, backup: Backup & { objectKey: string }): Promise<void> {
  if (payload.mode !== "replace") throw new DataError("A backup of volumes restores over the app it came from, not into a new one", true);
  const app = await volumeApp(deps, payload.targetAppId);
  if (backup.sourceAppId !== app.id) throw new DataError("A backup of volumes restores only over the app it came from", true);
  const guard = new TarGuard({ volumes: true });
  await assertRoom(deps.scratchDisk, Number(backup.sizeBytes ?? 0), (need, free, floor) => `The backup is ${need} and the disk it is staged on has ${free} free. Dockify keeps ${floor} free, so nothing was changed.`);
  const tmp = await fetchVerified(deps, backup, guard);
  let p: RestorePayload = payload;
  let stopped: string[] | null = null;
  let emptied = false;
  try {
    const volumes = guard.roots;
    const gone = volumes.filter((v) => !app.volumes.includes(v));
    if (gone.length) throw new DataError(`This backup holds ${gone.join(", ")}, which ${app.name} no longer has. Download the backup to get those files.`, true);
    if (!volumes.length) throw new DataError("This backup holds no volume", true);
    stopped = await stopRunning(deps, jobId, p, [app.id], { hold: true, own: app.id });
    p = { ...p, quiesced: stopped };
    const pre = await backupBeforeRestore(deps, app.id, backup);
    // Emptied first, then filled: only what the archive holds beyond the files there now is new room.
    await assertRoom(deps.volumeDisk, Math.max(0, guard.summary.bytes - (pre.fileBytes ?? 0)), (need, free, floor) => `The restore needs ${need} more than the volumes hold now and the server's disk has ${free} free. Dockify keeps ${floor} free, so nothing was changed.`);
    p = { ...p, preRestoreBackupId: pre.id, emptiedAt: new Date().toISOString() };
    // Written BEFORE the volumes are touched: recovery reads it to know the app must stay stopped.
    await deps.db.job.update({ where: { id: jobId }, data: { payload: p as unknown as Prisma.InputJsonValue } });
    emptied = true;
    const note = await restoreVolumes(deps, { backupId: backup.id, app, volumes, archive: await plain(deps, tmp, backup.id), setgid: guard.setgid });
    // On the job before the app is started: a start that fails must never read as a restore that did.
    p = { ...p, restoredAt: new Date().toISOString() };
    await deps.db.job.update({ where: { id: jobId }, data: { payload: p as unknown as Prisma.InputJsonValue } });
    emptied = false;
    const cut = guard.setgidCut ? `The setgid bit was set again on the first ${guard.setgid.length} files and folders that had it, not on the rest.` : null;
    await activity(deps, "backup.restore", "restored a backup over the volumes of", app.id, app.name, false, note ?? cut ?? undefined);
  } catch (e) {
    await activity(deps, "backup.restore", "failed to restore a backup over the volumes of", app.id, app.name, true, message(e));
    throw e;
  } finally {
    if (emptied) await leaveStopped(deps, jobId, p, app);
    else if (stopped) {
      const down = await resume(deps, jobId, p, stopped);
      if (down.length) await activity(deps, "backup.restore", "could not start the app again after the restore of the volumes of", app.id, app.name, true, p.restoredAt ? "The files were restored. Only the start failed, and it is retried each minute." : "Its files were not changed. The start is retried each minute.");
    }
    await rm(tmp, { force: true });
  }
}

export async function runRestore(deps: DataDeps, jobId: string, payload: RestorePayload): Promise<void> {
  const { db } = deps;
  const backup = await db.backup.findUnique({ where: { id: payload.backupId } });
  restorable(backup);
  const into = await db.app.findUnique({ where: { id: payload.targetAppId }, select: { kind: true } });
  if (backup.kind === "volume" && into && !isServiceKind(into.kind)) return runVolumeRestore(deps, jobId, payload, backup);
  const app = await serviceApp(deps, payload.targetAppId);
  if (backupKindFor(app.kind) !== backup.kind) throw new DataError(`A ${backup.kind} backup cannot be restored into a ${app.kind} service`, true);
  if (backup.kind === "volume") throw new DataError(STORAGE_UNAVAILABLE, true);

  const tmp = await fetchVerified(deps, backup);
  let quiesced: string[] = [];
  try {
    if (payload.mode === "new") {
      const out = await deployManagedService({ db, vault: deps.vault, docker: deps.docker, log: () => {} }, app.id, { fromRestore: true });
      await db.app.update({ where: { id: app.id }, data: { status: "running", desiredState: "running", containerId: out.containerId } });
    } else {
      await backupBeforeRestore(deps, app.id, backup);
      quiesced = await quiesce(deps, jobId, payload, app.environmentId, { hold: true });
    }
    const t = await target(deps, app.id);
    if (backup.kind === "postgres") await replayPostgres(deps, tmp, backup.id, t.containerId, t.creds, payload.mode === "replace");
    else await replayRedis(deps, tmp, backup.id, t);
    await activity(deps, "backup.restore", `restored ${payload.mode === "new" ? "a backup into" : "a backup over"}`, app.id, app.name);
  } catch (e) {
    await activity(deps, "backup.restore", "failed to restore a backup into", app.id, app.name, true, message(e));
    throw e;
  } finally {
    if (payload.mode === "replace" && quiesced.length) {
      const down = await resume(deps, jobId, payload, quiesced);
      if (down.length) await activity(deps, "backup.restore", "could not start every app again after restoring a backup over", app.id, app.name, true, `${down.length} still stopped; retried each minute.`);
    }
    await rm(tmp, { force: true });
  }
}

const REDIS_MAGIC = Buffer.from("REDIS", "latin1");

export interface RestoreTestOutcome {
  status: "passed" | "failed";
  tables: number | null;
  rows: number | null;
  error: string | null;
}

export async function runRestoreTest(deps: DataDeps, backupId: string): Promise<RestoreTestOutcome> {
  const { db } = deps;
  const backup = await db.backup.findUnique({ where: { id: backupId } });
  let outcome: RestoreTestOutcome;
  let scratch = false;
  let tmp: string | null = null;
  try {
    restorable(backup);
    const snap = (backup.appSnapshot ?? {}) as Partial<AppSnapshot>;
    // An app's own volumes. A Storage service's older archive has no folder per volume and gets the format check alone.
    const guard = backup.kind === "volume" && snap.kind !== "s3" ? new TarGuard({ volumes: true }) : undefined;
    if (guard) await assertRoom(deps.scratchDisk, Number(backup.sizeBytes ?? 0), (need, free, floor) => `The backup is ${need} and the disk it is staged on has ${free} free. Dockify keeps ${floor} free, so the test was not run.`);
    tmp = await fetchVerified(deps, backup, guard);
    if (backup.kind === "postgres") {
      const app: ServiceApp = { id: backup.sourceAppId, name: "restore-test", kind: "postgres", environmentId: snap.environmentId ?? backup.sourceAppId, projectId: "restore-test", memoryLimitMb: 512 };
      const creds = generateCredentials("postgres", RESTORE_TEST_NAME);
      const rtName = restoreTestContainer(backup.id);
      // The same Postgres the dump came from: its pinned digest, so a newer server never reads an older dump differently.
      const source = backup.appId ? await db.app.findUnique({ where: { id: backup.appId }, select: { image: true, pinnedImage: true } }) : null;
      const image = await resolveServiceImage(deps.docker, source?.image || snap.image || SERVICE_IMAGES.postgres, source?.pinnedImage ?? snap.pinnedImage ?? null, () => {});
      // From here on there may be a container and a volume to discard, even if starting it fails.
      // Anything an earlier run left is discarded first: a half replayed copy is no test.
      scratch = true;
      await discardRestoreScratch(deps.docker, backup.id);
      await provisionService(deps.docker, app, creds, {
        name: rtName, image: image.imageId, role: RESTORE_TEST_ROLE, network: HELPER_NETWORK,
        volume: restoreTestVolume(backup.id), volumeLabels: { [LABEL_ROLE]: RESTORE_TEST_ROLE, "dockify.backup": backup.id },
      });
      // Address by name so exec/attach stay inside the gate's managed-name allowlist.
      await replayPostgres(deps, tmp, backup.id, rtName, creds, false);
      const check = await exec(deps, rtName, restoreCheckCommand(creds));
      const [out, res] = await Promise.all([readAll(check.stdout), check.done]);
      checkExit("the restore check", res);
      const counts = parseRestoreCheck(out);
      outcome = { status: "passed", tables: counts.tables, rows: counts.rows, error: null };
    } else if (backup.kind === "redis") {
      const head = await readAll(await plain(deps, tmp, backup.id), 16);
      if (!Buffer.from(head, "latin1").subarray(0, 5).equals(REDIS_MAGIC)) throw new DataError("The snapshot is not a Redis RDB file");
      outcome = { status: "passed", tables: null, rows: null, error: null };
    } else if (guard) {
      // Extracted for real into a scratch volume; for volumes `rows` is the number of files that came out.
      scratch = true;
      await discardRestoreScratch(deps.docker, backup.id);
      const files = await testVolumeRestore(deps, { backupId: backup.id, sourceAppId: backup.sourceAppId, archive: await plain(deps, tmp, backup.id), expected: guard });
      outcome = { status: "passed", tables: null, rows: files, error: null };
    } else {
      outcome = { status: "passed", tables: null, rows: null, error: null };
    }
  } catch (e) {
    outcome = { status: "failed", tables: null, rows: null, error: message(e) };
  } finally {
    // A failed delete does not change what the test found; the next sweep removes it.
    if (scratch) await discardRestoreScratch(deps.docker, backupId).catch(() => {});
    if (tmp) await rm(tmp, { force: true });
  }
  if (backup) {
    await db.backup.update({
      where: { id: backup.id },
      data: {
        restoreTestStatus: outcome.status,
        restoreTestedAt: deps.now?.() ?? new Date(),
        restoreTestTables: outcome.tables,
        restoreTestRows: outcome.rows === null ? null : BigInt(outcome.rows),
        restoreTestError: outcome.error,
      },
    });
  }
  return outcome;
}
