/**
 * Backups of an app's own volumes. A short-lived helper on the helpers' network (no way out) mounts them and
 * runs GNU tar: read-only for a backup, writable only for a restore. The archive holds one folder per volume.
 */
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { containerSpec, reason as message, type ContainerInput, type VolumeMount } from "@dockify/engine";
import { diskVerdict, type DiskUsageReader } from "../deploy/disk-guard.ts";
import { DataError, DeadlineError, readAll, type DataDeps } from "./context.ts";
import type { DockerPort, ExecHandle, ExecResult } from "./docker-port.ts";
import { resolveServiceImage } from "./images.ts";
import { BACKUP_HELPER_PREFIX, BACKUP_HELPER_ROLE, RESTORE_HELPER_PREFIX, RESTORE_HELPER_ROLE, RESTORE_TEST_ROLE, restoreTestContainer, restoreTestVolume } from "./leftovers.ts";
import { HELPER_NETWORK, LABEL_APP, LABEL_ROLE } from "./services.ts";
import { TarGuard, type SetgidEntry } from "./tar-guard.ts";

/** Debian for its GNU tar: it pads a file that shrank while it was read, where busybox tar gives up mid archive. */
export const VOLUME_HELPER_IMAGE = "debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc";
export const backupHelperName = (backupId: string) => `${BACKUP_HELPER_PREFIX}${backupId}`;
export const restoreHelperName = (backupId: string) => `${RESTORE_HELPER_PREFIX}${backupId}`;
export const VOLUME_ROOT = "/v";
/** Longer than any data job may run (handlers.ts), so a helper nobody removed still ends by itself. */
const HELPER_LIFE_SECONDS = 13 * 3600;
const STDERR_TAIL = 2_000;
/** GNU tar's "some files differ": a file changed or went away while it was read. The archive is whole. */
export const TAR_CHANGED_EXIT = 1;

export interface VolumeApp {
  id: string;
  name: string;
  environmentId: string;
  /** Docker volume names, the folders of the archive. */
  volumes: string[];
}

/** Pax, so a file past 8 GiB or a long name is a record the tar guard reads. Owners stay numbers: the helper has no such users. */
export function volumeTarCommand(volumes: readonly string[]): string[] {
  return ["tar", "--create", "--file=-", "--format=pax", "--pax-option=delete=atime,delete=ctime", "--numeric-owner", `--directory=${VOLUME_ROOT}`, "--", ...volumes];
}

/** Run only on an archive the tar guard passed in full. `empty` clears each mounted volume first, never the mount itself. */
export function volumeExtractCommand(empty: boolean): string[] {
  const extract = `exec tar --extract --file=- --directory=${VOLUME_ROOT} --numeric-owner --same-owner --same-permissions`;
  return ["sh", "-c", empty ? `find ${VOLUME_ROOT} -mindepth 2 -delete && ${extract}` : extract];
}

/**
 * The helper has no CAP_FSETID (no tenant container does), so the kernel drops the setgid bit when tar sets the
 * mode of a file or folder whose group is not the helper's own. Set again as that group, the bit stays.
 * Reads NUL separated pairs on stdin: a gid, then a path under the volumes. A symlink is skipped, never followed.
 */
export const setgidCommand = (): string[] => ["xargs", "-0", "-r", "-n", "2", "sh", "-c", 'cd /v && if [ ! -L "./$2" ]; then exec setpriv --regid "$1" --clear-groups chmod g+s -- "./$2"; fi', "setgid"];

/** One byte per extracted entry, so a name with a newline in it still counts once. */
export const volumeCountCommand = (): string[] => ["sh", "-c", `find ${VOLUME_ROOT} -mindepth 1 -printf x | wc -c`];

/** Every path an archive of volumes extracts to. */
export const tarEntries = (g: Pick<TarGuard, "summary" | "links">): number => g.summary.files + g.summary.dirs + g.links;

export interface HelperOptions {
  name: string;
  image: string;
  role: string;
  appId: string;
  backupId: string;
  mounts: VolumeMount[];
}

/** Pure, so the tests hold it to the container policy and the agent's gate. */
export function volumeHelperInput(o: HelperOptions): ContainerInput {
  return {
    name: o.name,
    image: o.image,
    network: HELPER_NETWORK,
    cmd: ["sleep", String(HELPER_LIFE_SECONDS)],
    restart: "no",
    memoryMb: 256,
    pidsLimit: 32,
    readOnlyRootfs: true,
    volumes: o.mounts,
    labels: { [LABEL_ROLE]: o.role, [LABEL_APP]: o.appId, "dockify.backup": o.backupId },
  };
}

export const volumeMounts = (volumes: readonly string[], readOnly: boolean): VolumeMount[] => volumes.map((name) => ({ name, mountPath: `${VOLUME_ROOT}/${name}`, readOnly }));

async function helperImage(docker: DockerPort, log: (line: string) => void): Promise<string> {
  return (await resolveServiceImage(docker, VOLUME_HELPER_IMAGE, null, log)).imageId;
}

const discard = (docker: DockerPort, name: string) => docker.remove(name, { volumes: true }).catch(() => {});

async function startHelper(deps: DataDeps, o: Omit<HelperOptions, "image">): Promise<void> {
  const { docker } = deps;
  const image = await helperImage(docker, (line) => deps.log?.(line));
  let spec;
  try {
    spec = containerSpec(volumeHelperInput({ ...o, image }), docker.cpuCores);
  } catch (e) {
    throw new DataError(`These volumes cannot be mounted by a backup helper: ${message(e)}`, true);
  }
  await docker.ensureNetwork(HELPER_NETWORK, { [LABEL_ROLE]: "helpers" }, { internal: true });
  await discard(docker, o.name);
  await docker.createContainer(o.name, spec);
  await docker.start(o.name);
}

function exited(what: string, r: ExecResult): void {
  if (r.exitCode !== 0) throw new DataError(`${what} exited with code ${r.exitCode}: ${r.stderr.slice(-STDERR_TAIL).trim() || "no output"}`);
}

/** Passes the archive on while the tar guard reads it, so a backup a restore would refuse fails as a backup. */
export class TarChecked extends Transform {
  readonly guard = new TarGuard({ volumes: true });
  constructor() {
    super();
    // The failure reaches the pipeline through the callbacks below.
    this.guard.on("error", () => {});
  }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    this.guard.write(chunk, (e) => cb(e ?? null, chunk));
  }
  override _flush(cb: TransformCallback): void {
    this.guard.end((e?: Error | null) => cb(e ?? null));
  }
}

const gib = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GiB`;

/**
 * Refuses work that would leave the disk under the floor the deploys keep free (deploy/disk-guard.ts).
 * `say` gets what is needed, what is free and the floor. A disk that cannot be read stops nothing.
 */
export async function assertRoom(read: DiskUsageReader | undefined, needBytes: number, say: (need: string, free: string, floor: string) => string): Promise<void> {
  const u = read ? await read().catch(() => null) : null;
  if (!u) return;
  const { floorBytes } = diskVerdict(u);
  if (u.freeBytes - needBytes < floorBytes) throw new DataError(say(gib(needBytes), gib(u.freeBytes), gib(floorBytes)), true);
}

const WATCH_EVERY_BYTES = 64 * 1024 ** 2;

/** Stops a backup whose staged ciphertext is filling the disk: checked before the first byte and every 64 MiB after. */
export class RoomWatch extends Transform {
  readonly #read: DiskUsageReader | undefined;
  #next = 0;
  #seen = 0;
  constructor(read: DiskUsageReader | undefined) {
    super();
    this.#read = read;
  }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback): void {
    this.#seen += chunk.length;
    if (this.#seen < this.#next) return cb(null, chunk);
    this.#next = this.#seen + WATCH_EVERY_BYTES;
    assertRoom(this.#read, 0, (_need, free, floor) => `The backup was stopped: the disk it is staged on has ${free} free, under the ${floor} Dockify keeps free. Free some space, then back up again.`).then(() => cb(null, chunk), cb);
  }
}

export interface VolumeDump {
  handle: ExecHandle;
  cleanup: () => Promise<void>;
}

/** The volumes stay mounted in the app meanwhile: nothing is paused, and the helper cannot write to them. */
export async function openVolumeDump(deps: DataDeps, backupId: string, app: VolumeApp): Promise<VolumeDump> {
  const name = backupHelperName(backupId);
  const cleanup = () => discard(deps.docker, name);
  try {
    await startHelper(deps, { name, role: BACKUP_HELPER_ROLE, appId: app.id, backupId, mounts: volumeMounts(app.volumes, true) });
    return { handle: await deps.docker.exec(name, { cmd: volumeTarCommand(app.volumes) }), cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

async function extract(deps: DataDeps, container: string, archive: Readable, empty: boolean, onCut: string): Promise<void> {
  const h = await deps.docker.exec(container, { cmd: volumeExtractCommand(empty), stdin: true });
  h.stdout.resume();
  if (!h.stdin) throw new DataError("tar was started without stdin");
  try {
    await pipeline(archive, h.stdin);
  } catch (e) {
    await h.kill().catch(() => {});
    const late = await h.done.then(() => null, (d: unknown) => d);
    if (late instanceof DeadlineError) throw late;
    throw new DataError(`${onCut}: ${message(e)}`);
  }
  exited("tar", await h.done);
}

/** Puts the setgid bits back after an extraction. Throws with the reason when any could not be set. */
async function restoreSetgid(deps: DataDeps, container: string, entries: readonly SetgidEntry[]): Promise<void> {
  if (!entries.length) return;
  const h = await deps.docker.exec(container, { cmd: setgidCommand(), stdin: true });
  h.stdout.resume();
  if (!h.stdin) throw new DataError("the setgid pass was started without stdin");
  await pipeline(Readable.from(entries.map((e) => Buffer.from(`${e.gid}\0${e.path.replace(/^\.\/+/, "")}\0`))), h.stdin);
  exited("setting the setgid bits again", await h.done);
}

/**
 * Empties each of `volumes` and extracts the archive over them. The app must be stopped, and the archive verified.
 * Answers a note when the files are back but some setgid bits are not, which is no reason to fail the restore.
 */
export async function restoreVolumes(deps: DataDeps, o: { backupId: string; app: VolumeApp; volumes: readonly string[]; archive: Readable; setgid: readonly SetgidEntry[] }): Promise<string | null> {
  const name = restoreHelperName(o.backupId);
  try {
    await startHelper(deps, { name, role: RESTORE_HELPER_ROLE, appId: o.app.id, backupId: o.backupId, mounts: volumeMounts(o.volumes, false) });
    await extract(deps, name, o.archive, true, "The restore stopped part way, so the volumes are incomplete. The backup taken just before this restore holds the files it replaced");
    return await restoreSetgid(deps, name, o.setgid).then(() => null, (e: unknown) => `Every file is back, but the setgid bit could not be set again on some of ${o.setgid.length} files and folders: ${message(e)}`);
  } finally {
    await discard(deps.docker, name);
  }
}

/**
 * Extracts into the restore test's one scratch volume and counts what landed. The caller discards the
 * scratch (leftovers.ts), whatever happens here.
 */
export async function testVolumeRestore(deps: DataDeps, o: { backupId: string; sourceAppId: string; archive: Readable; expected: Pick<TarGuard, "summary" | "links"> }): Promise<number> {
  const name = restoreTestContainer(o.backupId);
  const volume = restoreTestVolume(o.backupId);
  await assertRoom(deps.volumeDisk, o.expected.summary.bytes, (need, free, floor) => `The test extracts ${need} of files and the server's disk has ${free} free. Dockify keeps ${floor} free, so the test was not run. Free some space and test again.`);
  await deps.docker.ensureVolume(volume, { "dockify.managed": "true", [LABEL_ROLE]: RESTORE_TEST_ROLE, "dockify.backup": o.backupId });
  await startHelper(deps, { name, role: RESTORE_TEST_ROLE, appId: o.sourceAppId, backupId: o.backupId, mounts: [{ name: volume, mountPath: VOLUME_ROOT }] });
  await extract(deps, name, o.archive, false, "The test copy could not be extracted");
  const count = await deps.docker.exec(name, { cmd: volumeCountCommand() });
  const [out, res] = await Promise.all([readAll(count.stdout), count.done]);
  exited("counting the extracted files", res);
  const found = Number(out.trim());
  const want = tarEntries(o.expected);
  if (!Number.isInteger(found) || found !== want) throw new DataError(`The archive lists ${want} files and folders, and ${Number.isInteger(found) ? found : "an unknown number"} came out of it`);
  return o.expected.summary.files;
}
