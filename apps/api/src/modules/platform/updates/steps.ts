import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Dump, Images, Preflight, Service, UpdateSteps } from "./runner.ts";
import { archOf, bare, fetchVerifiedFeed, imagesFor, refuseTarget, type Channel, type FeedRelease, type VerifiedFeed } from "./release.ts";
import { runningVersion } from "@dockify/contracts";

export interface StepsConfig {
  /**
   * Host folder holding docker-compose.yml and .env (root-owned, read-only to this process) and
   * release/release.env (the one file the updater rewrites), bound at the same path.
   */
  composeDir: string;
  backupDir: string;
  readyzUrl: string;
  /** Seconds each service gets to report healthy after it is recreated. */
  healthTimeoutS: number;
  feedUrl: string;
  publicKey: string;
  /** Free bytes the backup folder must keep beyond three times the database size. */
  minFreeBytes: number;
  /** The version of the running updater image, the true current version a downgrade is measured against. */
  currentVersion: string;
}

export function loadStepsConfig(env: NodeJS.ProcessEnv, publicKey: string | null): StepsConfig {
  // Without a feed or a key, a rollback still works; resolve() refuses an update.
  const feed = env.DOCKIFY_RELEASE_FEED?.trim() ?? "";
  return {
    composeDir: env.DOCKIFY_COMPOSE_DIR?.trim() || "/opt/dockify",
    backupDir: env.DOCKIFY_BACKUP_DIR?.trim() || "/var/lib/dockify/backups",
    readyzUrl: env.DOCKIFY_UPDATER_READYZ?.trim() || "http://api:3001/readyz",
    healthTimeoutS: Number(env.DOCKIFY_UPDATER_HEALTH_TIMEOUT ?? 180) || 180,
    feedUrl: feed,
    publicKey: publicKey ?? "",
    minFreeBytes: Number(env.DOCKIFY_UPDATER_MIN_FREE_BYTES ?? 2 * 1024 ** 3) || 2 * 1024 ** 3,
    // The image's own (contracts runningVersion): .env's DOCKIFY_VERSION is the version last installed
    // by hand, and an update does not rewrite it, so it says nothing about what runs.
    currentVersion: runningVersion(env),
  };
}

/**
 * How long release.env.prev vouches for the images it names: the rollback window (state.ts
 * ROLLBACK_DAYS) and a day, the same as a pre-update dump is kept.
 */
export const PREV_TRUST_MS = 8 * 86_400_000;

const DIGEST_REF = /^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/;

/**
 * release.env holds only the two pinned image references, so the updater never rewrites .env.
 * It is the one file in the install a non-root uid can write, and compose reads it as an env
 * file, so any other key in it (DOCKIFY_DIR, COMPOSE_PROFILES, a tag instead of a digest) would
 * let that uid steer what root runs. Every line must be blank, a comment, or one of the two keys
 * pinned by digest, once each. The installer's `dockify` wrapper applies the same rule.
 */
export function parseReleaseEnv(text: string): Images {
  const seen = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(DOCKIFY_CONTROL_IMAGE|DOCKIFY_WEB_IMAGE)=(\S+)$/.exec(line);
    const key = m?.[1];
    const ref = m?.[2];
    if (!key || !ref || !DIGEST_REF.test(ref) || seen.has(key)) {
      throw new Error("release.env may only pin DOCKIFY_CONTROL_IMAGE and DOCKIFY_WEB_IMAGE, once each, by digest");
    }
    seen.set(key, ref);
  }
  const control = seen.get("DOCKIFY_CONTROL_IMAGE");
  const web = seen.get("DOCKIFY_WEB_IMAGE");
  if (!control || !web) throw new Error("release.env does not pin both images");
  return { control, web };
}
export const renderReleaseEnv = (i: Images) =>
  `# Written by the Dockify updater. Pinned by digest; do not edit by hand.\nDOCKIFY_CONTROL_IMAGE=${i.control}\nDOCKIFY_WEB_IMAGE=${i.web}\n`;

/** The install layout. release.env sits in its own folder, the only one the updater may write. */
export const installPaths = (dir: string) => ({
  dir,
  compose: path.join(dir, "docker-compose.yml"),
  env: path.join(dir, ".env"),
  releaseEnv: path.join(dir, "release", "release.env"),
});

export interface GuardFs {
  /** mtimeMs: when the file was last written. A real lstat always says. */
  lstat(p: string): Promise<{ uid: number; mode: number; mtimeMs?: number; isSymbolicLink(): boolean }>;
  readFile(p: string): Promise<Buffer>;
}
const realFs: GuardFs = { lstat: (p) => lstat(p), readFile: (p) => readFile(p) };

export const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * Refuses to drive compose unless what it executes is root's alone. The updater holds the Docker
 * socket, so a compose file or .env that a non-root host user could edit would be a path from that
 * user to root on the next update. The folder, docker-compose.yml and .env must be real entries
 * owned by uid 0 and not writable by group or others; the compose file must still hash to
 * DOCKIFY_COMPOSE_SHA256 as the installer pinned it in .env (read from disk, never from this
 * process's environment, which a tampered compose file could have set); release.env must be
 * strict. Returns the on-disk compose hash.
 */
export async function checkInstallTree(dir: string, fs: GuardFs = realFs): Promise<string> {
  const p = installPaths(dir);
  for (const f of [p.dir, p.compose, p.env]) {
    const st = await fs.lstat(f);
    if (st.isSymbolicLink()) throw new Error(`${f} is a symlink; refusing to update`);
    if (st.uid !== 0) throw new Error(`${f} must be owned by root, found uid ${st.uid}; refusing to update`);
    if (st.mode & 0o022) throw new Error(`${f} is writable by group or others (mode ${(st.mode & 0o7777).toString(8)}); refusing to update`);
  }
  const env = (await fs.readFile(p.env)).toString("utf8");
  const pin = /^DOCKIFY_COMPOSE_SHA256=([a-f0-9]{64})$/m.exec(env)?.[1];
  if (!pin) throw new Error(".env does not pin DOCKIFY_COMPOSE_SHA256; rerun the installer");
  const onDisk = sha256Hex(await fs.readFile(p.compose));
  if (onDisk !== pin) throw new Error("docker-compose.yml does not match the hash pinned at install; refusing to update");
  if ((await fs.lstat(p.releaseEnv)).isSymbolicLink()) throw new Error(`${p.releaseEnv} is a symlink; refusing to update`);
  parseReleaseEnv((await fs.readFile(p.releaseEnv)).toString("utf8"));
  return onDisk;
}

/** A signed release that names a compose hash must name the file that is on disk. */
export function checkComposeMatchesRelease(onDiskSha256: string, rel: Pick<FeedRelease, "composeSha256">): void {
  if (rel.composeSha256 && rel.composeSha256 !== onDiskSha256) {
    throw new Error("this release ships a different docker-compose.yml than the one installed; rerun the installer to apply it");
  }
}

export interface RunOpts {
  env?: NodeJS.ProcessEnv;
  stdinFile?: string;
  stdoutFile?: string;
  timeoutMs?: number;
}
export type Runner = (cmd: string, args: string[], opts?: RunOpts) => Promise<string>;

/** Long enough for the largest dump or pull. The heartbeat renews the lease, so a hung command would otherwise hold an update running for good. */
const COMMAND_TIMEOUT_MS = 2 * 3_600_000;

/** Runs a command with an argument array (never a shell string) and rejects on a non-zero exit. */
export const run: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const child = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
    let out = "";
    let err = "";
    const done: Promise<unknown>[] = [];
    if (opts.stdoutFile) {
      const stdout = pipeline(child.stdout, createWriteStream(opts.stdoutFile, { mode: 0o600 }));
      stdout.catch(() => {});
      done.push(stdout);
    }
    else child.stdout.on("data", (d: Buffer) => { out = (out + d.toString()).slice(-20_000); });
    child.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-4000); });
    if (opts.stdinFile) {
      // A reader may stop early and exit 0: pg_restore --list reads only the table of contents, so a dump
      // larger than the pipe breaks it. The exit code says whether that was fine. Handled now, since a
      // rejection with no handler until the close below takes this whole process down mid-update.
      const quietEarlyClose = (e: NodeJS.ErrnoException) => {
        if (e.code !== "EPIPE" && e.code !== "ERR_STREAM_PREMATURE_CLOSE") throw e;
      };
      const stdin = pipeline(createReadStream(opts.stdinFile), child.stdin).catch(quietEarlyClose);
      stdin.catch(() => {});
      done.push(stdin);
    } else child.stdin.end();
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const failure = signal === "SIGTERM" ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `exited ${code}: ${err.trim().split("\n").at(-1) ?? ""}`;
      void Promise.all(done).then(
        () => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.slice(0, 6).join(" ")} ${failure}`))),
        reject,
      );
    });
  });

/** The restore script runs inside the postgres container: drop and rebuild the schema atomically. */
export const RESTORE_SCRIPT =
  // Its own file each time: it runs as postgres, and could not overwrite a dump an older root run left
  // in /tmp at the old fixed name.
  "set -eu; set -o pipefail; f=$(mktemp /tmp/dockify-restore.XXXXXX); cat > \"$f\"; " +
  // The last line, in the restore's own transaction: the dump was taken during the update being undone,
  // so it holds that update's job, still open. Left open, the updater claims it once its lease lapses and
  // installs the release again, minutes after the rollback. Schema-qualified: the dump empties search_path.
  "{ echo 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'; pg_restore --no-owner --no-privileges -f - \"$f\"; " +
  "echo 'UPDATE public.jobs SET \"completedAt\" = now(), \"lockedUntil\" = NULL WHERE lane::text = $$update$$ AND \"completedAt\" IS NULL AND \"failedAt\" IS NULL;'; } " +
  "| psql -v ON_ERROR_STOP=1 --single-transaction -q -U dockify -d dockify; rm -f \"$f\"";

/** A restored dump is a program: it runs as the image's own unprivileged user, never as root in the container. */
const AS_POSTGRES = ["-u", "postgres"];

/** What the steps read from the control-plane database. The engine passes Prisma-backed queries. */
export interface ControlProbe {
  /** A trivial query answers. */
  databaseOk(): Promise<boolean>;
  databaseBytes(): Promise<number>;
  /** A deploy, restore or backup that is running right now, by name, or null. */
  busy(): Promise<string | null>;
  workerSeenAt(): Promise<Date | null>;
}

export interface StepsDeps {
  probe: ControlProbe;
  fs?: GuardFs;
  fetchFeed?: (feedUrl: string, publicKey: string) => Promise<VerifiedFeed>;
  /** Free bytes in a folder; statfs by default. */
  freeBytes?: (dir: string) => Promise<number>;
  run?: Runner;
  sleep?: (ms: number) => Promise<void>;
  /** GETs a URL and answers its status (the api readiness probe). */
  getStatus?: (url: string) => Promise<number>;
  /** process.arch by default. */
  arch?: string;
  /** The channel to re-verify against. */
  channel: () => Promise<Channel>;
  now?: () => number;
}

const realFree = async (dir: string) => {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
};

export async function fileSha256(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** The dump file for an id. The worker reads the same path (same volume) to copy it offsite. */
export const dumpPath = (backupDir: string, id: string) => path.join(backupDir, "control", `pre-update-${id}.dump`);

/** The digest part of a pinned reference. */
export const digestOf = (ref: string) => ref.slice(ref.lastIndexOf("@") + 1);

export function dockerSteps(cfg: StepsConfig, deps: StepsDeps): UpdateSteps {
  const fs = deps.fs ?? realFs;
  const exec = deps.run ?? run;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchFeed = deps.fetchFeed;
  const free = deps.freeBytes ?? realFree;
  const getStatus = deps.getStatus ?? (async (u: string) => (await fetch(u, { signal: AbortSignal.timeout(5000), redirect: "error" })).status);
  const p = installPaths(cfg.composeDir);
  const releaseEnv = p.releaseEnv;
  // Images this process has checked, by resolve() or trustImages().
  const checked = new Set<string>();
  const imagesKey = (i: Images) => `${i.control} ${i.web}`;
  const pinnedInFile = async (file: string): Promise<Images | null> => {
    try {
      return parseReleaseEnv((await fs.readFile(file)).toString("utf8"));
    } catch {
      return null;
    }
  };
  /**
   * The previous pins, while a rollback to them can still be asked for. Past that a row naming them is
   * no rollback: a forged one (phase rollback, or its images) would be a downgrade nobody approved.
   * The age is the file's own, which only pin() writes, never a row's.
   */
  const pinnedBefore = async (): Promise<Images | null> => {
    const file = `${releaseEnv}.prev`;
    const written = await fs.lstat(file).then((st) => st.mtimeMs, () => undefined);
    if (written !== undefined && (deps.now ?? Date.now)() - written > PREV_TRUST_MS) return null;
    return pinnedInFile(file);
  };
  /**
   * The one gate on what the updater may run, which holds the Docker socket: images must be what
   * release.env pins or pinned within the rollback window (files only this process writes), or be
   * listed for this architecture in a signed feed fetched and verified right now. Everything a journal
   * row says is a claim: a database write could forge toImages or fromImages, or a row that starts past
   * the pull step, and this is the step between an api bug and root on the host.
   */
  const trustImages = async (images: Images): Promise<void> => {
    const key = imagesKey(images);
    if (checked.has(key)) return;
    const local = await Promise.all([pinnedInFile(releaseEnv), pinnedBefore()]);
    if (local.some((l) => l && imagesKey(l) === key)) return void checked.add(key);
    if (!cfg.feedUrl || !cfg.publicKey) throw new Error("these images are not what this server has pinned, and no signed release feed is configured to check them against; refusing to run them");
    const channel = await deps.channel();
    const feed = fetchFeed ? await fetchFeed(cfg.feedUrl, cfg.publicKey) : await fetchVerifiedFeed(cfg.feedUrl, channel, cfg.publicKey);
    const arch = archOf(deps.arch);
    const listed = feed.releases.some((r) => {
      // The feed keeps old releases, signed for good. A row that starts past the pull step never reaches
      // resolve(), so this is where a forged row meets the downgrade rule. A real rollback is .prev, above.
      if (refuseTarget(r, cfg.currentVersion)) return false;
      try {
        return imagesKey(imagesFor(r, arch)) === key;
      } catch {
        return false;
      }
    });
    if (!listed) throw new Error("these images are neither pinned on this server nor in the signed release feed; refusing to run them");
    checked.add(key);
  };
  /**
   * Docker merges an image's labels into its container, so a tenant container made before the worker
   * blanked them can claim com.docker.compose.project=dockify, and `compose exec`, `stop` and `up`
   * would act on it. Real services never carry dockify.managed. Refuse rather than guess.
   */
  const refuseImpostors = async (): Promise<void> => {
    const out = await exec("docker", ["ps", "-aq", "--filter", "label=dockify.managed=true", "--filter", "label=com.docker.compose.project=dockify"]);
    const ids = out.split("\n").map((l) => l.trim()).filter(Boolean);
    if (ids.length) throw new Error(`tenant containers ${ids.slice(0, 5).join(", ")} carry Docker Compose's labels for this stack and could answer for its services; redeploy or remove their apps, then try again`);
  };
  // Every compose run re-checks the tree first, so an edit made during an update is caught too.
  const compose = async (args: string[], opts: RunOpts = {}) => {
    await checkInstallTree(cfg.composeDir, fs);
    await refuseImpostors();
    return exec("docker", ["compose", "--project-directory", p.dir, "-f", p.compose, "--env-file", p.env, "--env-file", releaseEnv, ...args], opts);
  };
  const until = async (what: string, ok: () => Promise<boolean>): Promise<void> => {
    const end = Date.now() + cfg.healthTimeoutS * 1000;
    for (;;) {
      if (await ok().catch(() => false)) return;
      if (Date.now() > end) throw new Error(`${what} did not report healthy within ${cfg.healthTimeoutS} s`);
      await sleep(2000);
    }
  };
  const apiReady = async () => (await getStatus(cfg.readyzUrl)) === 200;
  const workerBeat = (since: Date) => async () => ((await deps.probe.workerSeenAt())?.getTime() ?? 0) > since.getTime();
  // The updater is not on the web's network, so web health is the container's own health check.
  const webHealthy = async () => {
    const out = await compose(["ps", "--format", "json", "web"]);
    return out.split("\n").filter((l) => l.trim()).some((l) => {
      const c = JSON.parse(l) as { State?: string; Health?: string };
      return c.State === "running" && c.Health === "healthy";
    });
  };

  return {
    async preflight(): Promise<Preflight> {
      if (!(await deps.probe.databaseOk().catch(() => false))) return { ok: false, wait: true, reason: "the control-plane database does not answer" };
      const busy = await deps.probe.busy();
      if (busy) return { ok: false, wait: true, reason: `${busy} is in flight` };
      await mkdir(path.join(cfg.backupDir, "control"), { recursive: true, mode: 0o700 });
      const need = 3 * (await deps.probe.databaseBytes()) + cfg.minFreeBytes;
      const have = await free(cfg.backupDir);
      if (have < need) {
        return { ok: false, wait: false, reason: `not enough free disk: ${Math.floor(have / 1024 ** 2)} MiB free, ${Math.ceil(need / 1024 ** 2)} MiB needed for the dump and the new images` };
      }
      await checkInstallTree(cfg.composeDir, fs);
      return { ok: true };
    },
    async resolve(version, manifestSha256) {
      if (!cfg.feedUrl || !cfg.publicKey) throw new Error("updates are not configured: no DOCKIFY_RELEASE_FEED or release public key");
      const onDisk = await checkInstallTree(cfg.composeDir, fs);
      const channel = await deps.channel();
      const feed = fetchFeed ? await fetchFeed(cfg.feedUrl, cfg.publicKey) : await fetchVerifiedFeed(cfg.feedUrl, channel, cfg.publicKey);
      if (feed.sha256 !== manifestSha256) throw new Error("the signed release feed changed since this update was approved; check again");
      const rel = feed.releases.find((r) => bare(r.version) === bare(version));
      if (!rel) throw new Error(`the signed feed no longer lists ${version}`);
      // Re-check the downgrade and minFrom rules against the actually running version, so a row
      // inserted straight into the database (bypassing beginApply's check) cannot drive a signed
      // downgrade: the version here is the running updater image's, not the row's forgeable fromVersion.
      const reason = refuseTarget(rel, cfg.currentVersion);
      if (reason) throw new Error(reason);
      checkComposeMatchesRelease(onDisk, rel);
      const images = imagesFor(rel, archOf(deps.arch));
      checked.add(imagesKey(images));
      return images;
    },
    async currentImages() {
      return parseReleaseEnv(await readFile(releaseEnv, "utf8"));
    },
    async pull(images) {
      await trustImages(images);
      for (const ref of [images.control, images.web]) {
        await exec("docker", ["pull", "--quiet", ref]);
        // What landed must carry exactly the signed digest.
        const out = await exec("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", ref]);
        const digests = (JSON.parse(out.trim() || "[]") as string[]).map(digestOf);
        if (!digests.includes(digestOf(ref))) throw new Error(`the pulled image does not carry ${digestOf(ref)}`);
      }
    },
    async quiesce() {
      await compose(["stop", "api", "worker"]);
    },
    async dump(): Promise<Dump> {
      const id = randomUUID();
      const file = dumpPath(cfg.backupDir, id);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await compose(["exec", "-T", ...AS_POSTGRES, "postgres", "pg_dump", "-U", "dockify", "-d", "dockify", "-Fc", "--no-owner"], { stdoutFile: file });
      const { size } = await stat(file);
      if (size < 64) throw new Error("the dump is empty");
      // A dump that pg_restore cannot list is not a rollback point.
      await compose(["exec", "-T", ...AS_POSTGRES, "postgres", "pg_restore", "--list"], { stdinFile: file });
      const sha256 = await fileSha256(file);
      await writeFile(`${file}.sha256`, `${sha256}  ${path.basename(file)}\n`, { mode: 0o600 });
      return { id, sha256, bytes: size };
    },
    async migrate(images) {
      await trustImages(images);
      await compose(["run", "--rm", "--no-deps", "migrate"], {
        env: { ...process.env, DOCKIFY_CONTROL_IMAGE: images.control, DOCKIFY_WEB_IMAGE: images.web },
      });
    },
    async pin(images) {
      await trustImages(images);
      const cur = await readFile(releaseEnv, "utf8").catch(() => "");
      const next = renderReleaseEnv(images);
      if (cur === next) return;
      if (cur) await writeFile(`${releaseEnv}.prev`, cur, { mode: 0o600 });
      const tmp = `${releaseEnv}.tmp`;
      await writeFile(tmp, next, { mode: 0o600 });
      await rename(tmp, releaseEnv);
    },
    async swap(service: Service, since: Date) {
      // The agent runs the worker's image, and the worker reaches Docker through it. It goes first, so the
      // new worker's first look at Docker is already the new agent. It restarts nothing it serves.
      if (service === "worker") await compose(["up", "-d", "--no-deps", "--wait", "--wait-timeout", String(cfg.healthTimeoutS), "agent"]);
      await compose(["up", "-d", "--no-deps", "--wait", "--wait-timeout", String(cfg.healthTimeoutS), service]);
      if (service === "api") await until("the api", apiReady);
      if (service === "worker") await until("the worker heartbeat", workerBeat(since));
      if (service === "web") await until("the web", webHealthy);
    },
    async healthy(since: Date) {
      if (!(await apiReady().catch(() => false))) return "the api is not ready (/readyz)";
      try {
        await until("the worker heartbeat", workerBeat(since));
      } catch {
        return "the worker has not sent a heartbeat since the swap";
      }
      if (!(await webHealthy().catch(() => false))) return "the web is not healthy";
      return null;
    },
    async restoreDump(dump) {
      const file = dumpPath(cfg.backupDir, dump.id);
      const got = await fileSha256(file);
      if (got !== dump.sha256) throw new Error(`dump ${dump.id} does not match its recorded sha256; refusing to restore it`);
      await compose(["exec", "-T", ...AS_POSTGRES, "postgres", "sh", "-c", RESTORE_SCRIPT], { stdinFile: file });
    },
  };
}

/**
 * Recreates the updater itself on the newly pinned image, from a separate one-off container, so
 * the process being replaced is never the one doing the replacing. Called after a job settled.
 */
export async function refreshUpdater(cfg: StepsConfig, exec: Runner = run, fs: GuardFs = realFs): Promise<void> {
  const p = installPaths(cfg.composeDir);
  await checkInstallTree(cfg.composeDir, fs);
  await exec("docker", [
    "compose", "--project-directory", p.dir, "-f", p.compose, "--env-file", p.env, "--env-file", p.releaseEnv,
    "run", "-d", "--rm", "--no-deps", "--name", `dockify-updater-refresh-${Date.now()}`, "updater", "updater-refresh",
  ]);
}

/** Removes pre-update dumps older than `olderThan`, except the ones named in `keep`. */
export async function pruneDumps(backupDir: string, keep: Set<string>, olderThan: Date): Promise<number> {
  const dir = path.join(backupDir, "control");
  let n = 0;
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    const m = /^pre-update-([0-9a-f-]{36})\.dump$/.exec(f);
    if (!m || keep.has(m[1]!)) continue;
    const st = await stat(path.join(dir, f)).catch(() => null);
    if (!st || st.mtime >= olderThan) continue;
    await rm(path.join(dir, f), { force: true });
    await rm(path.join(dir, `${f}.sha256`), { force: true });
    n++;
  }
  return n;
}
