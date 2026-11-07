/**
 * The one way a managed Postgres or Redis gets its container: the deploy job of a service app (a
 * resource created through the api queues one too) and a restore into a new service both come
 * here, never through the generic app pipeline. In order:
 *
 *   1. read its credentials (the shared JSON shape, or an older install's bare password)
 *   2. find its data volume row: the named volume every deploy, backup and restore uses
 *   3. resolve its image: the recorded digest, or the configured tag pulled once and pinned
 *   4. stop everything serving the app (one writer, always) and park the previous container
 *   5. a setup helper with the volume mounted: into an empty named volume, copy the data the
 *      previous container kept on an anonymous volume (older installs), then write the secret
 *      file (the Redis config, the Postgres password file) from stdin
 *   6. start the new container and wait for its health check; an adopted Postgres then gets the
 *      stored password set over its local socket (it was created with other credentials); finally
 *      prove a login with the stored credentials
 *   7. success removes the parked container (its anonymous volumes stay, the janitor lists them);
 *      a failure removes the new one, empties a volume it had just adopted into, and puts the
 *      previous container back as it was
 *
 * The setup helper runs the service's image with nothing at the image's VOLUME path, which makes
 * Docker create an empty anonymous volume for it, so it is always removed along with that.
 *
 * No project or app variable is ever read: a service runs with exactly what this file gives it.
 */
import { readAll } from "./context.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { GENERATED_PASSWORD, openServiceCredentials, ServiceCredentialsError, type Db, type SecretAccess, type ServiceCredentials } from "@dockify/db";
import { containerSpec } from "@dockify/engine";
import type { DockerPort } from "./docker-port.ts";
import { resolveServiceImage } from "./images.ts";
import {
  assertServiceAlias, containerNameFor, dataPathFor, HELPER_NETWORK, LABEL_APP, LABEL_ENV, LABEL_PROJECT, LABEL_ROLE, networkFor, POSTGRES_PASSWORD_FILE,
  ProvisionError, REDIS_CONFIG_FILE, redisConfig, SERVICE_FILES_DIR, SERVICE_IMAGES, SERVICE_PORTS, SERVICE_USER, serviceSpec,
  STORAGE_UNAVAILABLE, waitReady, type ServiceApp, type ServiceKind,
} from "./services.ts";

/** Postgres needs the longest to flush and checkpoint on the way down. */
export const SERVICE_STOP_SECONDS = 30;
/** Mount points inside the setup helper. */
export const SETUP_DATA = "/v";
export const SETUP_FROM = "/from";
/** How long the idle setup helper lives if the worker dies before removing it. */
const HELPER_LIFETIME_SECONDS = 6 * 3600;
/** Docker names an anonymous volume by 64 hex characters. */
export const ANONYMOUS_VOLUME = /^[0-9a-f]{64}$/;

export const setupName = (appId: string) => `${containerNameFor(appId)}-setup`;
const parkedPattern = (appId: string) => new RegExp(`^dk-${appId}-prev-[0-9a-z]+$`);
/** The roles of a container that serves the app (a deployed app, or a service), never a helper. */
const serving = (role: string | undefined) => role === "app" || (role ?? "").startsWith("service-");

/** A failed managed deploy. rolledBack: the previous container was put back as it was. */
export class ManagedServiceError extends Error {
  readonly permanent: boolean;
  readonly rolledBack: boolean;
  constructor(message: string, opts: { permanent: boolean; rolledBack?: boolean }) {
    super(message);
    this.name = "ManagedServiceError";
    this.permanent = opts.permanent;
    this.rolledBack = opts.rolledBack ?? false;
  }
}

/**
 * The setup helper's first step. Adopts only into a volume that holds nothing but Dockify's own
 * folder, from a source that holds something, so a named volume with data is never written over.
 * The source is mounted read-only: it is never changed or deleted. Prints adopted=0|1 and
 * layout=root|sub (a Postgres cluster at the volume root, as an adopted one is, or the pgdata
 * folder a fresh volume gets).
 */
export const SETUP_SCRIPT = [
  "set -eu",
  "umask 077",
  `V=${SETUP_DATA}`,
  `mkdir -p "$V/${SERVICE_FILES_DIR}"`,
  "adopted=0",
  `if [ -d ${SETUP_FROM} ] && [ -z "$(ls -A "$V" | grep -v -x -F '${SERVICE_FILES_DIR}' || true)" ] && [ -n "$(ls -A ${SETUP_FROM})" ]; then`,
  `  cp -a ${SETUP_FROM}/. "$V/"`,
  `  chown -R "$DK_OWNER" "$V"`,
  "  adopted=1",
  "fi",
  'if [ -f "$V/PG_VERSION" ]; then layout=root; else layout=sub; fi',
  `chown "$DK_OWNER" "$V" "$V/${SERVICE_FILES_DIR}"`,
  `chmod 0700 "$V/${SERVICE_FILES_DIR}"`,
  'echo "adopted=$adopted"',
  'echo "layout=$layout"',
].join("\n");

/**
 * Writes one secret file from stdin. Reads exactly DK_BYTES bytes, so it never waits for the end
 * of stdin to reach it through the socket proxy, then renames into place. The value is never on
 * argv or in the exec's environment.
 */
export const SECRET_SCRIPT = [
  "set -eu",
  "umask 077",
  `f="${SETUP_DATA}/${SERVICE_FILES_DIR}/$DK_FILE"`,
  'head -c "$DK_BYTES" > "$f.tmp"',
  '[ "$(( $(wc -c < "$f.tmp") ))" -eq "$DK_BYTES" ]',
  'chown "$DK_OWNER" "$f.tmp"',
  'mv -f "$f.tmp" "$f"',
].join("\n");

/** Empties the volume after an adoption whose deploy failed, so the next deploy adopts again. */
export const WIPE_SCRIPT = `rm -rf ${SETUP_DATA}/..?* ${SETUP_DATA}/.[!.]* ${SETUP_DATA}/*`;

/** The one-off SQL file that sets an adopted cluster's password; removed as soon as it has run. */
export const RESET_FILE = "reset-password.sql";
/** Where the official Postgres image puts its socket, which its pg_hba.conf trusts for local connections. */
export const PG_SOCKET_DIR = "/var/run/postgresql";
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The SQL that gives the stored role the stored password in an adopted cluster: ALTER ROLE when the
 * role exists, else CREATE ROLE, as the superuser the image would have made it. It is written into
 * the volume and read with psql -f, so the password is never on argv or in an exec's environment.
 * The role is a name Dockify generated and the password is base64url: neither can break a quote.
 */
export function resetPasswordSql(c: ServiceCredentials): string {
  if (!ROLE_NAME.test(c.user)) throw new ProvisionError(`The stored user ${c.user} is not a role name Dockify can reset`, true);
  if (!GENERATED_PASSWORD.test(c.password)) throw new ProvisionError("The stored password is not one Dockify generated", true);
  return [
    "DO $dockify$",
    "BEGIN",
    `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${c.user}') THEN`,
    `    ALTER ROLE "${c.user}" WITH LOGIN PASSWORD '${c.password}';`,
    "  ELSE",
    `    CREATE ROLE "${c.user}" WITH LOGIN SUPERUSER PASSWORD '${c.password}';`,
    "  END IF;",
    "END",
    "$dockify$;",
    "",
  ].join("\n");
}

/** A KEY=value from a container's environment, or null. */
const envValue = (env: string[] | undefined, key: string): string | null => env?.find((e) => e.startsWith(`${key}=`))?.slice(key.length + 1) || null;

/** The secret file a kind keeps in its volume, and its contents. */
export function secretFileFor(kind: ServiceKind, c: ServiceCredentials): { file: string; content: string } {
  if (kind === "postgres") return { file: POSTGRES_PASSWORD_FILE, content: c.password };
  if (kind === "redis") return { file: REDIS_CONFIG_FILE, content: redisConfig(c) };
  throw new ManagedServiceError(STORAGE_UNAVAILABLE, { permanent: true });
}

export function parseSetupOutput(out: string): { adopted: boolean; layout: "root" | "sub" } {
  return { adopted: /^adopted=1$/m.test(out), layout: /^layout=root$/m.test(out) ? "root" : "sub" };
}

export interface ManagedDeps {
  db: Db;
  /** Opens secrets only; nothing here seals one. */
  vault: SecretAccess;
  docker: DockerPort;
  /** One line for the deploy log. */
  log: (line: string) => void;
  /** Called once the image is known, before anything running is touched (the deploy's steps). */
  onImage?: (image: { imageId: string; pin: string | null }) => Promise<void>;
  /** Called before anything running is touched; throws to cancel. */
  checkpoint?: () => void;
  readyTimeoutMs?: number;
  pollMs?: number;
}

export interface ManagedOptions {
  /** A rollback's image id: run it this once instead of the pinned digest. */
  imageId?: string | null;
  /** Called from inside a restore of this service, which holds the service's restore job itself. */
  fromRestore?: boolean;
}

export interface ManagedOutcome {
  containerId: string;
  imageId: string;
  /** The recorded digest reference, null when a rollback ran another image this once. */
  pin: string | null;
  /** The anonymous volume the data was copied from, when this deploy adopted one. */
  adoptedFrom: string | null;
  /** Anonymous volumes the replaced containers left behind. Never deleted. */
  keptVolumes: string[];
}

/** Runs one exec to the end: its stdout, or a ProvisionError naming the step and its stderr tail. */
async function run(docker: DockerPort, container: string, what: string, cmd: string[], env: Record<string, string> = {}, input?: string): Promise<string> {
  const h = await docker.exec(container, { cmd, env, stdin: input !== undefined });
  if (input !== undefined) {
    if (!h.stdin) throw new ProvisionError(`${what}: the exec was started without stdin`, true);
    // Written, not ended: the script reads exactly this many bytes, and half-closing the socket is
    // not something every proxy hop passes on.
    h.stdin.write(input);
  }
  const [out, res] = await Promise.all([readAll(h.stdout), h.done]);
  if (res.exitCode !== 0) throw new ProvisionError(`${what} exited with code ${res.exitCode}: ${res.stderr.trim().slice(-500) || "no output"}`, true);
  return out;
}

/** How long a Redis may stay busy loading its dataset into memory before the deploy gives up on it. */
const LOADING_TIMEOUT_MS = 5 * 60_000;

/**
 * Proves the stored credentials open the running service, and that Redis refuses a client without
 * them. Redis answers NOAUTH (its health check) before it has loaded its data, and LOADING to an
 * authenticated client until it has, so that answer is waited out rather than read as a refusal.
 */
export async function verifyCredentials(docker: DockerPort, container: string, kind: ServiceKind, c: ServiceCredentials, pollMs = 1_000, loadingTimeoutMs = LOADING_TIMEOUT_MS): Promise<void> {
  if (kind === "postgres") {
    const database = c.database ?? "postgres";
    let out: string;
    try {
      out = await run(docker, container, "psql", ["psql", "-X", "-q", "-h", "127.0.0.1", "-U", c.user, "-d", database, "-tAc", "select 1"], { PGPASSWORD: c.password });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (/database "[^"]+" does not exist/.test(why)) throw new ProvisionError(`This Postgres has no database ${database}, the one Dockify's credentials name`, true);
      if (/password authentication failed|role "[^"]+" does not exist/.test(why)) throw new ProvisionError(`Postgres did not accept the stored credentials of ${c.user}`, true);
      throw new ProvisionError(`The Postgres credential check failed (${why})`, true);
    }
    if (out.trim() !== "1") throw new ProvisionError("Postgres did not answer the credential check", true);
    return;
  }
  const deadline = Date.now() + loadingTimeoutMs;
  let authed = await run(docker, container, "redis-cli", ["redis-cli", "--no-auth-warning", "ping"], { REDISCLI_AUTH: c.password });
  while (/^LOADING\b/.test(authed.trim())) {
    if (Date.now() > deadline) throw new ProvisionError("Redis was still loading its data when the deploy stopped waiting", true);
    await sleep(pollMs);
    authed = await run(docker, container, "redis-cli", ["redis-cli", "--no-auth-warning", "ping"], { REDISCLI_AUTH: c.password });
  }
  if (authed.trim() !== "PONG") throw new ProvisionError("Redis did not accept the stored password", true);
  const open = await run(docker, container, "redis-cli", ["redis-cli", "ping"]).catch(() => "");
  if (open.trim() === "PONG") throw new ProvisionError("Redis answered a client without the password; refusing to run it", true);
}

/**
 * An adopted cluster keeps the users and passwords it was created with: the old container took its
 * POSTGRES_PASSWORD from the project's variables. Over the local socket, which the official image
 * trusts, the stored role gets the stored password; the caller then proves a login with them.
 * Connects as the first role that exists: the stored user, the old container's POSTGRES_USER, then
 * postgres, the image's default superuser. Returns the role it connected as.
 */
async function resetAdoptedPassword(
  docker: DockerPort,
  o: { service: string; helper: string; dataPath: string; owner: string; creds: ServiceCredentials; roles: string[] },
): Promise<string> {
  const sql = resetPasswordSql(o.creds);
  await run(docker, o.helper, "writing the password reset", ["sh", "-c", SECRET_SCRIPT], { DK_FILE: RESET_FILE, DK_BYTES: String(Buffer.byteLength(sql)), DK_OWNER: o.owner }, sql);
  try {
    let last = "no role to connect as";
    for (const role of o.roles) {
      try {
        await run(docker, o.service, "psql", ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=terse", "-v", "SHOW_CONTEXT=never", "-h", PG_SOCKET_DIR, "-U", role, "-d", "template1", "-f", `${o.dataPath}/${SERVICE_FILES_DIR}/${RESET_FILE}`]);
        return role;
      } catch (e) {
        last = (e instanceof Error ? e.message : String(e)).replace(/^psql exited with code \d+: /, "");
        // Only a missing role is worth another try; anything else would fail the same way.
        if (!/role "[^"]+" does not exist/.test(last)) break;
      }
    }
    throw new ProvisionError(`Could not set the password of ${o.creds.user} in the adopted Postgres over its local socket (${last})`, true);
  } finally {
    await run(docker, o.helper, "removing the password reset", ["rm", "-f", `${SETUP_DATA}/${SERVICE_FILES_DIR}/${RESET_FILE}`]).catch(() => {});
  }
}

/**
 * An adopted cluster keeps every role it came with, and their passwords. Dockify does not
 * touch them: the owner's apps may log in with them, and a conversion that runs by itself on an
 * upgrade must not take those apps down. It says so instead, in the deploy log and in Activity, so
 * the owner can change or drop them. Best effort: this never fails a deploy that has succeeded.
 */
async function reportOtherRoles(deps: ManagedDeps, o: { service: string; as: string; stored: string; app: { id: string; name: string } }): Promise<void> {
  try {
    const out = await run(deps.docker, o.service, "psql", ["psql", "-X", "-q", "-h", PG_SOCKET_DIR, "-U", o.as, "-d", "template1", "-tAc", "SELECT rolname FROM pg_roles WHERE rolcanlogin ORDER BY 1"]);
    const others = out.split("\n").map((l) => l.trim()).filter((r) => ROLE_NAME.test(r) && r !== o.stored);
    if (!others.length) return;
    const list = others.join(", ");
    deps.log(`this adopted database also has the login role${others.length === 1 ? "" : "s"} ${list}, which keep their old passwords. Apps may use them, so Dockify leaves them: change or drop any you no longer need`);
    await deps.db.activityLog.create({
      data: {
        category: "system", action: "service.adopted.roles", verb: "kept the old login roles of", actorType: "system", actorName: "Dockify", targetType: "app", targetId: o.app.id, targetLabel: o.app.name,
        suffix: `(${list.slice(0, 200)}). They keep their old passwords; change or drop any you no longer need.`,
      },
    });
  } catch (e) {
    deps.log(`could not list the database's other login roles: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const sentence = (s: string) => {
  const t = s.trim().replace(/\.+$/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Docker answers 304 to a stop of a stopped container and a start of a running one: both are success. */
const unlessNotModified = (e: unknown) => {
  if ((e as { status?: unknown } | null)?.status !== 304) throw e;
};

/**
 * Deploys one managed service. Throws ManagedServiceError, a credentials error or an image error
 * on failure; by then whatever ran before runs again.
 */
export async function deployManagedService(deps: ManagedDeps, appId: string, opts: ManagedOptions = {}): Promise<ManagedOutcome> {
  const { db, docker, log } = deps;
  const app = await db.app.findUnique({ where: { id: appId }, include: { environment: { select: { projectId: true } }, volumes: true } });
  if (!app) throw new ManagedServiceError("That service no longer exists", { permanent: true });
  const kind = app.kind as ServiceKind;
  if (kind === "s3") throw new ManagedServiceError(STORAGE_UNAVAILABLE, { permanent: true });
  if (kind !== "postgres" && kind !== "redis") throw new ManagedServiceError(`${app.name} is not a managed service`, { permanent: true });
  // Its alias is its name: refused here, before anything running is touched (serviceInput refuses it too).
  assertServiceAlias(app.name);
  if (!opts.fromRestore) {
    const busy = await db.job.findFirst({
      where: { kind: { in: ["backup", "restore", "service_upgrade"] }, dedupeKey: { in: [`backup:${app.id}`, `restore:${app.id}`, `service-upgrade:${app.id}`] }, completedAt: null, failedAt: null },
      select: { kind: true },
    });
    if (busy) throw new ManagedServiceError(`A ${busy.kind === "service_upgrade" ? "version change" : busy.kind} of ${app.name} is running; deploy it again when that finishes`, { permanent: true });
  }

  const { credentials: creds, legacy } = await openServiceCredentials(db, deps.vault, app);
  if (legacy) log("the stored credentials are in the format older versions wrote; they are read as they are");
  if (!GENERATED_PASSWORD.test(creds.password)) throw new ServiceCredentialsError(`The stored password of ${app.name} is not one Dockify generated`);

  const dataPath = dataPathFor(kind);
  const volume = app.volumes.find((v) => v.mountPath === dataPath);
  if (!volume) throw new ManagedServiceError(`${app.name} has no data volume at ${dataPath}, so it is not started: without one its data would not survive a redeploy`, { permanent: true });
  const ignored = app.volumes.filter((v) => v.id !== volume.id);
  if (ignored.length) log(`a managed service mounts only its data volume; not mounting ${ignored.map((v) => v.name).join(", ")}`);
  log("a managed service takes no project or app variables; Dockify sets its configuration itself");

  // The image first: a pull that fails costs no downtime.
  let imageId: string;
  let pin: string | null = app.pinnedImage;
  if (opts.imageId) {
    const have = await docker.inspectImage(opts.imageId);
    if (!have) throw new ManagedServiceError(`The image ${opts.imageId.slice(0, 19)} of the rollback target is no longer on this server`, { permanent: true });
    imageId = have.id;
    pin = null;
    log(`running the rollback target's image ${imageId.slice(0, 19)} this once; later deploys run the pinned digest again`);
  } else {
    const r = await resolveServiceImage(docker, app.image || SERVICE_IMAGES[kind], app.pinnedImage, log);
    imageId = r.imageId;
    pin = r.pin;
    if (r.pin !== app.pinnedImage) {
      await db.app.update({ where: { id: app.id }, data: { pinnedImage: r.pin } });
      log(`pinned ${r.pin}; redeploys run this digest until the version is changed`);
    } else {
      log(`running the pinned ${r.pin}`);
    }
  }
  await deps.onImage?.({ imageId, pin });
  deps.checkpoint?.();

  const name = containerNameFor(app.id);
  const svc: ServiceApp = {
    id: app.id, name: app.name, kind, environmentId: app.environmentId, projectId: app.environment.projectId, image: imageId,
    memoryLimitMb: app.memoryLimitMb, cpuLimit: app.cpuLimit, pidsLimit: app.pidsLimit,
  };

  // Every container that serves this app, a parked one a crashed deploy left behind included.
  const mine = (await docker.list({ [LABEL_APP]: app.id })).filter((c) => serving(c.labels[LABEL_ROLE]));
  const parked = parkedPattern(app.id);
  const canonical = mine.find((c) => c.names.includes(name)) ?? null;
  const newestParked = mine.filter((c) => c.names.some((n) => parked.test(n))).sort((a, b) => (a.names[0]! < b.names[0]! ? 1 : -1))[0] ?? null;
  const prevListing = canonical ?? newestParked;
  const prevState = prevListing ? await docker.inspect(prevListing.id) : null;
  if (prevState && prevState.labels[LABEL_APP] !== app.id) throw new ManagedServiceError(`container ${name} exists and is not this app's`, { permanent: true });
  const anonymousOf = (mounts: NonNullable<typeof prevState>["mounts"]) => (mounts ?? []).filter((m) => m.type === "volume" && !!m.name && ANONYMOUS_VOLUME.test(m.name));
  const adoptFrom = anonymousOf(prevState?.mounts).find((m) => m.destination === dataPath)?.name ?? null;
  const prevRunning = prevState?.running ?? prevListing?.running ?? false;

  const helper = setupName(app.id);
  const owner = `${SERVICE_USER[kind]}:${SERVICE_USER[kind]}`;
  // Where the previous container is now: under a parked name, or still under its own if parking it failed.
  let parkedAs: string | null = prevListing && prevListing !== canonical ? prevListing.names.find((n) => parked.test(n))! : null;
  let adopted = false;
  let created = false;
  try {
    // One writer at a time: everything serving this app stops before anything new starts.
    for (const c of mine) if (c.running) await docker.stop(c.id, SERVICE_STOP_SECONDS).catch(unlessNotModified);
    if (prevListing === canonical && canonical) {
      const to = `${name}-prev-${Date.now().toString(36)}`;
      await docker.rename(name, to);
      parkedAs = to;
    }
    if (prevListing) log(`previous container ${prevRunning ? "stopped and " : ""}parked as ${parkedAs}`);

    await docker.remove(helper, { volumes: true }).catch(() => {});
    await docker.ensureNetwork(networkFor(app.environmentId), { "dockify.managed": "true", [LABEL_ENV]: app.environmentId, [LABEL_PROJECT]: app.environment.projectId });
    await docker.ensureNetwork(HELPER_NETWORK, { [LABEL_ROLE]: "helpers" }, { internal: true });
    await docker.ensureVolume(volume.name, { "dockify.managed": "true", [LABEL_APP]: app.id });
    await docker.createContainer(helper, containerSpec({
      name: helper,
      image: imageId,
      network: HELPER_NETWORK,
      cmd: ["sleep", String(HELPER_LIFETIME_SECONDS)],
      volumes: [{ name: volume.name, mountPath: SETUP_DATA }, ...(adoptFrom ? [{ name: adoptFrom, mountPath: SETUP_FROM, readOnly: true }] : [])],
      restart: "no",
      memoryMb: 128,
      pidsLimit: 64,
      readOnlyRootfs: true,
      labels: { [LABEL_APP]: app.id, [LABEL_ROLE]: "setup-helper" },
    }, docker.cpuCores));
    await docker.start(helper);
    const setup = parseSetupOutput(await run(docker, helper, "preparing the data volume", ["sh", "-c", SETUP_SCRIPT], { DK_OWNER: owner }));
    adopted = setup.adopted;
    if (adopted) log(`copied the data the previous container kept on volume ${adoptFrom} into ${volume.name}; the old volume is kept as it was`);
    else if (adoptFrom) log(`${volume.name} already holds data, so the previous container's volume ${adoptFrom} was not copied; it is kept as it was`);
    const secret = secretFileFor(kind, creds);
    await run(docker, helper, "writing the service's secret file", ["sh", "-c", SECRET_SCRIPT], { DK_FILE: secret.file, DK_BYTES: String(Buffer.byteLength(secret.content)), DK_OWNER: owner }, secret.content);

    const pgdata = kind === "postgres" ? (setup.layout === "root" ? dataPath : `${dataPath}/pgdata`) : undefined;
    if (pgdata === dataPath) log("this volume keeps the Postgres data at its root, as an older container wrote it; running it there");
    const containerId = await docker.createContainer(name, serviceSpec(svc, creds, { image: imageId, volume: volume.name, ...(pgdata ? { pgdata } : {}) }, docker.cpuCores));
    created = true;
    await docker.start(name);
    await waitReady(docker, name, deps.readyTimeoutMs, deps.pollMs);
    if (kind === "postgres" && adopted) {
      const roles = [...new Set([creds.user, envValue(prevState?.env, "POSTGRES_USER"), "postgres"])].filter((r): r is string => !!r && ROLE_NAME.test(r));
      const as = await resetAdoptedPassword(docker, { service: name, helper, dataPath, owner, creds, roles });
      log(`set the password of ${creds.user} in the adopted database to the stored one, over its local socket as ${as}`);
      await reportOtherRoles(deps, { service: name, as, stored: creds.user, app: { id: app.id, name: app.name } });
    }
    await verifyCredentials(docker, name, kind, creds, deps.pollMs);
    log(`${app.name} is ready at ${app.name}:${SERVICE_PORTS[kind]} on its environment's network`);

    await docker.remove(helper, { volumes: true }).catch(() => {});
    const kept = new Set(anonymousOf(prevState?.mounts).map((m) => m.name!));
    const old = [...(parkedAs ? [parkedAs] : []), ...mine.filter((c) => c !== prevListing).map((c) => c.id)];
    for (const id of old) {
      const st = await docker.inspect(id).catch(() => null);
      for (const m of anonymousOf(st?.mounts)) kept.add(m.name!);
      await docker.remove(id).catch((e: unknown) => log(`could not remove the old container ${id}: ${e instanceof Error ? e.message : String(e)}`));
    }
    if (kept.size) log(`kept the anonymous volume${kept.size === 1 ? "" : "s"} ${[...kept].join(", ")} of the replaced container; Dockify never deletes them, and the janitor lists them in Activity`);
    return { containerId, imageId, pin, adoptedFrom: adopted ? adoptFrom : null, keptVolumes: [...kept] };
  } catch (e) {
    if (created) await docker.remove(name).catch(() => {});
    if (adopted) {
      await run(docker, helper, "emptying the volume after a failed adoption", ["sh", "-c", WIPE_SCRIPT]).catch((w: unknown) => log(`could not empty ${volume.name}: ${w instanceof Error ? w.message : String(w)}`));
    }
    await docker.remove(helper, { volumes: true }).catch(() => {});
    let restored = false;
    if (prevListing) {
      try {
        // Parked: its own name back. Not parked (the rename itself failed): it never lost it.
        if (parkedAs && parkedAs !== name) await docker.rename(parkedAs, name);
        if (prevRunning) await docker.start(name).catch(unlessNotModified);
        restored = true;
        log(prevRunning ? "previous container restored and running again" : "previous container restored");
      } catch (r) {
        log(`could not restore the previous container: ${r instanceof Error ? r.message : String(r)}`);
      }
    }
    const tail = restored
      ? prevRunning ? " Rolled back: the previous container runs again." : " Rolled back to the previous container."
      : prevListing ? "" : " There was no previous container, so nothing is running.";
    const permanent = (e as { permanent?: unknown } | null)?.permanent === true;
    throw new ManagedServiceError(`${sentence(e instanceof Error ? e.message : String(e))}.${tail}`, { permanent, rolledBack: restored });
  }
}
