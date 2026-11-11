/**
 * A restore test's scratch volume holds a decrypted copy of a database, so one a crashed worker left is removed.
 * An unused anonymous volume goes only when empty; any other is kept and reported for the owner.
 */
import { readAll } from "./context.ts";
import type { Db } from "@dockify/db";
import { containerSpec } from "@dockify/engine";
import { appsHere } from "../server/apps-here.ts";
import type { DiskUsageVolume } from "@dockify/engine";
import type { DockerPort } from "./docker-port.ts";
import { HELPER_NETWORK, LABEL_ROLE, SERVICE_IMAGES } from "./services.ts";
import { isAnonymousVolume } from "./volumes.ts";

export const RESTORE_TEST_ROLE = "restore-test";
/** What the socket proxy lets the worker exec into (deploy/socket-proxy/haproxy.cfg). */
const SCRATCH_PREFIX = "dockify-rt-";
/** Within the dk- volume names the socket proxy lets the worker delete. */
const SCRATCH_VOLUME_PREFIX = "dk-rt-";
/** The helpers that read and fill an app's volumes (volume-backup.ts), named dockify-bk-<backup> and dockify-rs-<backup>. */
export const BACKUP_HELPER_ROLE = "backup-helper";
export const RESTORE_HELPER_ROLE = "restore-helper";
export const BACKUP_HELPER_PREFIX = "dockify-bk-";
export const RESTORE_HELPER_PREFIX = "dockify-rs-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The app name a restore test's credentials are made for, so also its database's name. */
export const RESTORE_TEST_NAME = "restore_test";

export const restoreTestContainer = (backupId: string) => `${SCRATCH_PREFIX}${backupId}`;
export const restoreTestVolume = (backupId: string) => `${SCRATCH_VOLUME_PREFIX}${backupId}`;
const isRestoreTestContainer = (name: string) => name.startsWith(SCRATCH_PREFIX) && !name.startsWith(CHECK_PREFIX);
const CHECK_PREFIX = `${SCRATCH_PREFIX}check-`;
const CHECK_ROLE = "restore-check";
const CHECK_MOUNT = "/c";

/** Each part is tried whatever happened to the other; the first failure is rethrown, and the next sweep tries again. */
export async function discardRestoreScratch(docker: DockerPort, backupId: string): Promise<void> {
  let failure: unknown = null;
  await docker.remove(restoreTestContainer(backupId), { volumes: true }).catch((e: unknown) => {
    if ((e as { status?: unknown } | null)?.status !== 404) failure = e;
  });
  await docker.removeVolume(restoreTestVolume(backupId)).catch((e: unknown) => {
    failure ??= e;
  });
  if (failure) throw failure;
}

async function liveRestoreTest(db: Db, serverId: string, backupId: string, now: Date): Promise<boolean> {
  const open = await db.job.findFirst({ where: { kind: "restore_test", ...appsHere(serverId), dedupeKey: `restore-test:${backupId}`, completedAt: null, failedAt: null, lockedUntil: { gt: now } }, select: { id: true } });
  return !!open;
}

/** A volume helper is in use while its backup row still runs, or its restore job is held by a worker. */
async function liveVolumeHelper(db: Db, serverId: string, role: string, backupId: string, now: Date): Promise<boolean> {
  if (!UUID.test(backupId)) return false;
  if (role === BACKUP_HELPER_ROLE) return !!(await db.backup.findFirst({ where: { id: backupId, status: "running" }, select: { id: true } }));
  const open = await db.job.findFirst({ where: { kind: "restore", ...appsHere(serverId), payload: { path: ["backupId"], equals: backupId }, completedAt: null, failedAt: null, lockedUntil: { gt: now } }, select: { id: true } });
  return !!open;
}

/**
 * Prints "scratch" for a volume laid out as a restore test's Postgres: a cluster in pgdata/ (an older
 * version's is at the root) whose shared pg_database catalog (file 1262) names the test's database.
 */
export const CHECK_SCRIPT = `if [ -f ${CHECK_MOUNT}/pgdata/PG_VERSION ] && grep -q ${RESTORE_TEST_NAME} ${CHECK_MOUNT}/pgdata/global/1262; then echo scratch; else echo keep; fi`;

async function checkImage(db: Db, docker: DockerPort, serverId: string): Promise<string | null> {
  const pinned = await db.app.findMany({ where: { kind: "postgres", pinnedImage: { not: null }, ...appsHere(serverId) }, select: { pinnedImage: true }, take: 5 });
  for (const ref of [...pinned.map((a) => a.pinnedImage!), SERVICE_IMAGES.postgres]) {
    const have = await docker.inspectImage(ref).catch(() => null);
    if (have) return have.id;
  }
  await docker.pullImage(SERVICE_IMAGES.postgres).catch(() => {});
  return (await docker.inspectImage(SERVICE_IMAGES.postgres).catch(() => null))?.id ?? null;
}

/** Reads one unused anonymous volume, mounted read-only in a helper with no way out. */
async function holdsRestoreCopy(docker: DockerPort, image: string, volume: string): Promise<boolean> {
  const name = `${CHECK_PREFIX}${volume.slice(0, 12)}`;
  await docker.remove(name, { volumes: true }).catch(() => {});
  await docker.ensureNetwork(HELPER_NETWORK, { [LABEL_ROLE]: "helpers" }, { internal: true });
  await docker.createContainer(name, containerSpec({
    name, image, network: HELPER_NETWORK, cmd: ["sleep", "300"], restart: "no", memoryMb: 64, pidsLimit: 32, readOnlyRootfs: true,
    volumes: [{ name: volume, mountPath: CHECK_MOUNT, readOnly: true }],
    labels: { [LABEL_ROLE]: CHECK_ROLE },
  }, docker.cpuCores));
  try {
    await docker.start(name);
    const h = await docker.exec(name, { cmd: ["sh", "-c", CHECK_SCRIPT] });
    const [out, res] = await Promise.all([readAll(h.stdout), h.done]);
    return res.exitCode === 0 && out.trim() === "scratch";
  } finally {
    await docker.remove(name, { volumes: true }).catch(() => {});
  }
}

export interface LeftoverDeps {
  db: Db;
  serverId: string;
  docker: DockerPort;
  volumes: () => Promise<DiskUsageVolume[]>;
  log: (msg: string, extra?: object) => void;
  now?: () => Date;
  kept?: Set<string>;
}

export interface LeftoverReport {
  scratchContainers: number;
  scratchVolumes: number;
  emptyVolumes: number;
}

/** A pass reads at most this many unknown volumes. The next pass goes on. */
const CHECKS_PER_PASS = 10;

export async function sweepLeftovers(deps: LeftoverDeps): Promise<LeftoverReport> {
  const { db, docker, log, serverId } = deps;
  const now = deps.now?.() ?? new Date();
  const report: LeftoverReport = { scratchContainers: 0, scratchVolumes: 0, emptyVolumes: 0 };
  const fail = (what: string) => (e: unknown) => log(`could not remove ${what}`, { error: e instanceof Error ? e.message : String(e) });

  // A helper that outlived its check, and the scratch containers of tests that are over.
  for (const c of await docker.list({ [LABEL_ROLE]: CHECK_ROLE })) await docker.remove(c.id, { volumes: true }).catch(fail("a volume check helper"));
  for (const c of await docker.list({ [LABEL_ROLE]: RESTORE_TEST_ROLE })) {
    const name = c.names.find(isRestoreTestContainer);
    if (name && (await liveRestoreTest(db, serverId, name.slice(SCRATCH_PREFIX.length), now))) continue;
    await docker.remove(c.id, { volumes: true }).then(() => report.scratchContainers++, fail("a restore test container"));
  }

  // A volume helper a dead worker left: it holds an app's volumes mounted, so it goes once nothing uses it.
  for (const [role, prefix] of [[BACKUP_HELPER_ROLE, BACKUP_HELPER_PREFIX], [RESTORE_HELPER_ROLE, RESTORE_HELPER_PREFIX]] as const) {
    for (const c of await docker.list({ [LABEL_ROLE]: role })) {
      const name = c.names.find((n) => n.startsWith(prefix));
      if (name && (await liveVolumeHelper(db, serverId, role, name.slice(prefix.length), now))) continue;
      await docker.remove(c.id, { volumes: true }).then(() => report.scratchContainers++, fail("a volume backup helper"));
    }
  }

  const volumes = await deps.volumes();
  for (const v of volumes) {
    if (!v.Name.startsWith(SCRATCH_VOLUME_PREFIX) || (v.UsageData?.RefCount ?? 0) > 0) continue;
    if (await liveRestoreTest(db, serverId, v.Name.slice(SCRATCH_VOLUME_PREFIX.length), now)) continue;
    await docker.removeVolume(v.Name).then(() => report.scratchVolumes++, fail("a restore test volume"));
  }

  const unused = volumes.filter((v) => isAnonymousVolume(v) && v.UsageData?.RefCount === 0);
  for (const v of unused) {
    if (v.UsageData?.Size === 0) await docker.removeVolume(v.Name).then(() => report.emptyVolumes++, fail("an empty anonymous volume"));
  }
  const kept = deps.kept ?? new Set<string>();
  const unknown = unused.filter((v) => v.UsageData?.Size !== 0 && !kept.has(v.Name)).slice(0, CHECKS_PER_PASS);
  const image = unknown.length ? await checkImage(db, docker, serverId) : null;
  if (image) {
    for (const v of unknown) {
      const scratch = await holdsRestoreCopy(docker, image, v.Name).catch((e: unknown) => {
        fail("a restore test copy")(e);
        return null;
      });
      if (scratch === null) continue;
      if (scratch) await docker.removeVolume(v.Name).then(() => report.scratchVolumes++, fail("a restore test copy"));
      else kept.add(v.Name);
    }
  }
  return report;
}
