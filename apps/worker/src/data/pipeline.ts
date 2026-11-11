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
import type { Backup, Prisma } from "@dockify/db";
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
import { backupKindFor, isServiceKind, type AppSnapshot, type RestorePayload } from "./requests.ts";
import { backupObjectKey } from "./store.ts";
import { tierOfType } from "./tiers.ts";
import { TarGuard } from "./tar-guard.ts";

const STDERR_TAIL = 2_000;
const SERVICE_KINDS_SIBLINGS = ["frontend", "backend", "bot"] as const;

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
  // Only a Storage service took volume backups, and none runs any more.
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
 */
export async function runBackup(deps: DataDeps, backupId: string, final = true, copyIds: readonly string[] = []): Promise<void> {
  const { db } = deps;
  const backup = await db.backup.findUnique({ where: { id: backupId } });
  if (!backup) throw new DataError("That backup row no longer exists", true);
  if (backup.kind === "control_plane") return backup.status === "running" ? copyControlPlaneDump(deps, backup, final) : undefined;
  const extra = copyIds.length ? await db.backup.findMany({ where: { id: { in: [...copyIds] }, sourceAppId: backup.sourceAppId } }) : [];
  const rows = [backup, ...extra].filter((r) => r.status === "running");
  if (!rows.length) return;
  if (!backup.appId) {
    const gone = new DataError("The app was deleted before its backup ran", true);
    for (const r of rows) await db.backup.update({ where: { id: r.id }, data: failureData(gone, true) });
    throw gone;
  }

  const copies: Copy[] = rows.map((row) => ({ row, tmp: join(deps.tmpDir, `backup-${row.id}.dkbk`), counter: new HashCount() }));
  let source: DumpSource | null = null;
  let fan: Fan | null = null;
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
    const t = await target(deps, backup.appId);
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
    source = await openDump(deps, backup, t);
    const branches = live.map((c) => {
      const into = new PassThrough();
      return { into, done: pipeline(into, new EncryptStream(keys.active, c.row.id), c.counter, createWriteStream(c.tmp, { mode: 0o600 })) };
    });
    fan = new Fan(branches.map((b) => b.into));
    const flow = pipeline(source.handle.stdout, createGzip({ level: 6 }), fan);
    const [, result] = await Promise.all([flow, source.handle.done, ...branches.map((b) => b.done)]);
    checkExit(backup.kind === "postgres" ? "pg_dump" : backup.kind === "redis" ? "redis-cli" : "tar", result);

    for (const c of live) {
      try {
        const key = backupObjectKey(c.dest.prefix, { sourceAppId: c.row.sourceAppId, backupId: c.row.id, createdAt: c.row.createdAt, kind: c.row.kind });
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
export async function fetchVerified(deps: DataDeps, backup: Backup & { objectKey: string }): Promise<string> {
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
    const sink = backup.kind === "volume" ? new TarGuard() : devNull();
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

export async function quiesce(deps: DataDeps, jobId: string, payload: Pick<RestorePayload, "quiesced" | "resumedAt">, environmentId: string): Promise<string[]> {
  const siblings = await deps.db.app.findMany({
    where: { environmentId, kind: { in: [...SERVICE_KINDS_SIBLINGS] }, desiredState: "running" },
    select: { id: true },
  });
  const running: string[] = [];
  for (const s of siblings) {
    const st = await deps.docker.inspect(containerNameFor(s.id));
    if (st?.running && st.labels[LABEL_APP] === s.id) running.push(s.id);
  }
  // Written BEFORE anything stops: if the worker dies from here on, recovery knows what to start.
  await deps.db.job.update({ where: { id: jobId }, data: { payload: { ...payload, quiesced: running } as unknown as Prisma.InputJsonValue } });
  for (const id of running) await deps.docker.stop(containerNameFor(id), 20);
  return running;
}

/** Starts the apps a quiesce stopped. With any left down, resumedAt stays unset, so recovery tries them again. */
export async function resume(deps: DataDeps, jobId: string, payload: Pick<RestorePayload, "quiesced" | "resumedAt">, ids: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const id of ids) {
    const app = await deps.db.app.findUnique({ where: { id }, select: { desiredState: true } });
    if (!app || app.desiredState !== "running") continue;
    await deps.docker.start(containerNameFor(id)).catch((e: unknown) => {
      if ((e as { status?: unknown } | null)?.status !== 304) failed.push(id);
    });
  }
  await deps.db.job.update({
    where: { id: jobId },
    data: { payload: { ...payload, quiesced: ids, ...(failed.length ? {} : { resumedAt: new Date().toISOString() }) } as unknown as Prisma.InputJsonValue },
  });
  return failed;
}

async function activity(deps: DataDeps, action: string, verb: string, targetId: string, label: string, failed = false, suffix?: string): Promise<void> {
  await deps.db.activityLog
    .create({ data: { category: "system", action, verb, actorType: "system", targetType: "app", targetId, targetLabel: label, failed, suffix: suffix?.slice(0, 300) ?? null } })
    .catch(() => {});
}

export async function runRestore(deps: DataDeps, jobId: string, payload: RestorePayload): Promise<void> {
  const { db } = deps;
  const backup = await db.backup.findUnique({ where: { id: payload.backupId } });
  restorable(backup);
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
      // A dump of what is about to be replaced, so a wrong restore is itself undoable.
      const pre = await db.backup.create({
        data: {
          appId: app.id,
          sourceAppId: app.id,
          appSnapshot: (backup.appSnapshot ?? {}) as Prisma.InputJsonValue,
          kind: backup.kind,
          trigger: "pre_restore",
          status: "running",
          destinationId: backup.destinationId,
        },
        select: { id: true },
      });
      await runBackup(deps, pre.id, true);
      quiesced = await quiesce(deps, jobId, payload, app.environmentId);
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
    tmp = await fetchVerified(deps, backup);
    if (backup.kind === "postgres") {
      const snap = (backup.appSnapshot ?? {}) as Partial<AppSnapshot>;
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
