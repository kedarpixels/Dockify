import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Db, SecretVault } from "@dockify/db";
import { assertSafeSpec, type ContainerSpec } from "@dockify/engine";
import { isPermanentError } from "../errors.ts";
import type { ContainerMount, ContainerState, DockerPort, ExecHandle, ImageState } from "./docker-port.ts";
import { ImageResolveError } from "./images.ts";
import { deployManagedService, ManagedServiceError, PG_SOCKET_DIR, RESET_FILE, resetPasswordSql, SECRET_SCRIPT, SETUP_SCRIPT, WIPE_SCRIPT, type ManagedDeps } from "./managed.ts";
import { STORAGE_UNAVAILABLE } from "./services.ts";

// ------------------------------------------------------------------------------------- fakes

type Row = Record<string, any>;
type Files = Map<string, string>;

interface FakeContainer {
  name: string;
  running: boolean;
  health: ContainerState["health"];
  labels: Record<string, string>;
  mounts: ContainerMount[];
  spec?: ContainerSpec;
  env?: string[];
}

/** A Postgres cluster as far as logins go: each role's password (null for none) and the databases. */
interface Cluster {
  roles: Map<string, string | null>;
  databases: Set<string>;
}

const APP = "0f0f0f0f-0000-4000-8000-0000000000a1";
const ENV_ID = "0f0f0f0f-0000-4000-8000-0000000000e1";
const SECRET = "0f0f0f0f-0000-4000-8000-0000000000c1";
const ANON = "a".repeat(64);
const DIGEST = `sha256:${"1".repeat(64)}`;
const NEWER = `sha256:${"2".repeat(64)}`;
const PASSWORD = "Gen_Password-0123456789abcdefABCD";

/** A Docker engine with just enough behaviour for the managed path: containers, volumes as file maps, a registry. */
function fakeEngine() {
  const containers = new Map<string, FakeContainer>();
  const volumes = new Map<string, Files>();
  const images = new Map<string, ImageState>();
  const registry = new Map<string, string>([["redis:7.4-alpine", DIGEST], ["postgres:16-alpine", DIGEST]]);
  const log: string[] = [];
  const execs: Array<{ container: string; cmd: string[]; env: Record<string, string> }> = [];
  /** Every create body, kept after the container is removed. */
  const specs = new Map<string, ContainerSpec>();
  /** What the services do: pass their health check, or answer Redis without a password. */
  const state = { healthy: true, redisOpen: false, loadingPings: 0 };
  /** The Postgres cluster each volume holds: roles with their passwords, and databases. */
  const clusters = new Map<string, Cluster>();
  /** The roles psql connected as over the local socket, in order. */
  const socketLogins: string[] = [];
  const vol = (name: string) => {
    if (!volumes.has(name)) volumes.set(name, new Map());
    return volumes.get(name)!;
  };
  const mountOf = (c: FakeContainer | undefined, dest: string) => c?.mounts.find((m) => m.destination === dest)?.name ?? null;
  const repoOf = (ref: string) => ref.split("@")[0]!.replace(/:[^/]*$/, "");

  const handle = (out: string, exitCode = 0, stderr = "", stdinBytes?: number, onInput?: (s: string) => void): ExecHandle => {
    const stdout = new PassThrough();
    let resolve!: (r: { exitCode: number; stderr: string }) => void;
    const done = new Promise<{ exitCode: number; stderr: string }>((r) => (resolve = r));
    if (stdinBytes === undefined) {
      setImmediate(() => {
        stdout.end(out);
        resolve({ exitCode, stderr });
      });
      return { stdout, stdin: null, done, kill: async () => {} };
    }
    // Like `head -c N`: the process ends once it has its bytes, whether or not stdin is ever closed.
    let got = "";
    const stdin = new Writable({
      write: (c, _e, cb) => {
        got += String(c);
        if (Buffer.byteLength(got) >= stdinBytes) {
          onInput?.(got);
          stdout.end(out);
          resolve({ exitCode, stderr });
        }
        cb();
      },
    });
    return { stdout, stdin, done, kill: async () => {} };
  };

  const docker: DockerPort = {
    cpuCores: 4,
    ensureNetwork: async (name, _labels, opts) => void log.push(`network:${name}${opts?.internal ? ":internal" : ""}`),
    ensureVolume: async (name) => {
      vol(name);
      log.push(`volume:${name}`);
    },
    removeVolume: async (name) => void log.push(`removeVolume:${name}`),
    createContainer: async (name, spec) => {
      assertSafeSpec(spec);
      if (containers.has(name)) throw Object.assign(new Error(`Conflict. The container name "/${name}" is already in use`), { status: 409 });
      const service = (spec.Labels["dockify.role"] ?? "").startsWith("service-");
      containers.set(name, {
        name,
        running: false,
        health: spec.Healthcheck ? (service && !state.healthy ? "unhealthy" : "healthy") : "none",
        labels: spec.Labels,
        mounts: spec.HostConfig.Mounts.map((m) => ({ type: "volume", name: m.Source, destination: m.Target })),
        spec,
      });
      specs.set(name, spec);
      log.push(`create:${name}`);
      return name;
    },
    start: async (id) => {
      const c = containers.get(id)!;
      c.running = true;
      // The image's first start of an empty data volume: initdb with POSTGRES_USER, POSTGRES_DB and the password file.
      const data = mountOf(c, "/var/lib/postgresql/data");
      if (data && c.labels["dockify.role"] === "service-postgres" && !clusters.has(data)) {
        const env = Object.fromEntries((c.spec?.Env ?? []).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
        clusters.set(data, { roles: new Map([[env.POSTGRES_USER!, vol(data).get(".dockify/postgres-password") ?? null]]), databases: new Set(["postgres", env.POSTGRES_DB!]) });
      }
      log.push(`start:${id}`);
    },
    stop: async (id) => {
      const c = containers.get(id);
      if (c) c.running = false;
      log.push(`stop:${id}`);
    },
    remove: async (id) => {
      if (!containers.delete(id)) throw Object.assign(new Error("No such container"), { status: 404 });
      log.push(`remove:${id}`);
    },
    inspect: async (id) => {
      const c = containers.get(id);
      return c ? { id: c.name, running: c.running, health: c.health, labels: c.labels, addresses: {}, mounts: c.mounts, ...(c.env ? { env: c.env } : {}) } : null;
    },
    exec: async (id, o) => {
      execs.push({ container: id, cmd: o.cmd, env: o.env ?? {} });
      const c = containers.get(id);
      const script = o.cmd[0] === "sh" ? o.cmd[2] : null;
      if (script === SETUP_SCRIPT) {
        const v = vol(mountOf(c, "/v")!);
        const fromName = mountOf(c, "/from");
        v.set(".dockify/", "");
        let adopted = 0;
        const holds = [...v.keys()].some((k) => !k.startsWith(".dockify/"));
        if (fromName && !holds && (volumes.get(fromName)?.size ?? 0) > 0) {
          for (const [k, val] of volumes.get(fromName)!) v.set(k, val);
          const from = clusters.get(fromName);
          if (from) clusters.set(mountOf(c, "/v")!, { roles: new Map(from.roles), databases: new Set(from.databases) });
          adopted = 1;
        }
        return handle(`adopted=${adopted}\nlayout=${v.has("PG_VERSION") ? "root" : "sub"}\n`);
      }
      if (script === SECRET_SCRIPT) {
        const v = vol(mountOf(c, "/v")!);
        return handle("", 0, "", Number(o.env!.DK_BYTES), (s) => v.set(`.dockify/${o.env!.DK_FILE}`, s));
      }
      if (script === WIPE_SCRIPT) {
        vol(mountOf(c, "/v")!).clear();
        clusters.delete(mountOf(c, "/v")!);
        return handle("");
      }
      if (o.cmd[0] === "rm") {
        vol(mountOf(c, "/v")!).delete(o.cmd[2]!.replace(/^\/v\//, ""));
        return handle("");
      }
      if (o.cmd[0] === "psql") {
        const dataVol = mountOf(c, "/var/lib/postgresql/data")!;
        const cluster = clusters.get(dataVol);
        const arg = (flag: string) => o.cmd[o.cmd.indexOf(flag) + 1]!;
        if (!cluster) return handle("", 2, "psql: error: connection to server failed: Connection refused");
        if (arg("-h") === PG_SOCKET_DIR) {
          // The image trusts its local socket: any existing role gets in without a password.
          const role = arg("-U");
          if (!cluster.roles.has(role)) return handle("", 2, `psql: error: connection to server on socket "${PG_SOCKET_DIR}/.s.PGSQL.5432" failed: FATAL:  role "${role}" does not exist`);
          // The read of the cluster's other login roles, after the reset.
          if (o.cmd.includes("-tAc")) return handle([...cluster.roles.keys()].join("\n"));
          socketLogins.push(role);
          const sql = vol(dataVol).get(arg("-f").replace("/var/lib/postgresql/data/", "")) ?? "";
          const m = /ALTER ROLE "(\w+)" WITH LOGIN PASSWORD '([^']+)'/.exec(sql);
          if (!m) return handle("", 3, "psql: error: no such file");
          cluster.roles.set(m[1]!, m[2]!);
          return handle("");
        }
        const user = arg("-U");
        const database = arg("-d");
        if (cluster.roles.get(user) !== o.env?.PGPASSWORD) return handle("", 2, `psql: error: connection to server at "127.0.0.1", port 5432 failed: FATAL:  password authentication failed for user "${user}"`);
        if (!cluster.databases.has(database)) return handle("", 2, `psql: error: connection to server at "127.0.0.1", port 5432 failed: FATAL:  database "${database}" does not exist`);
        return handle("1\n");
      }
      if (o.cmd[0] === "redis-cli") {
        const conf = vol(mountOf(c, "/data")!).get(".dockify/redis.conf") ?? "";
        const want = /^requirepass (\S+)$/m.exec(conf)?.[1];
        if (!want || state.redisOpen) return handle("PONG\n");
        if (o.env?.REDISCLI_AUTH !== want) return handle("NOAUTH Authentication required.\n");
        if (state.loadingPings > 0) {
          state.loadingPings--;
          return handle("LOADING Redis is loading the dataset in memory\n");
        }
        return handle("PONG\n");
      }
      return handle("", 127, `unexpected exec ${o.cmd.join(" ")}`);
    },
    attach: async () => {
      throw new Error("the managed path never attaches");
    },
    list: async (labels) =>
      [...containers.values()]
        .filter((c) => Object.entries(labels).every(([k, v]) => c.labels[k] === v))
        .map((c) => ({ id: c.name, names: [c.name], running: c.running, labels: c.labels })),
    rename: async (name, next) => {
      const c = containers.get(name)!;
      containers.delete(name);
      containers.set(next, { ...c, name: next });
      log.push(`rename:${name}:${next}`);
    },
    inspectImage: async (ref) => images.get(ref) ?? null,
    pullImage: async (ref) => {
      log.push(`pull:${ref}`);
      const digest = ref.includes("@") ? ref.split("@")[1]! : registry.get(ref);
      if (!digest) throw new Error(`manifest unknown: ${ref}`);
      const img = { id: `sha256:${(digest === DIGEST ? "b" : "c").repeat(64)}`, repoDigests: [`${repoOf(ref)}@${digest}`] };
      images.set(ref, img);
      images.set(`${repoOf(ref)}@${digest}`, img);
    },
  };

  /**
   * A container the generic pipeline made for this app before managed services existed. For a
   * Postgres, `cluster` is what its volume holds (the users it was created with) and `env` what the
   * project's variables gave it.
   */
  const addLegacy = (kind: "redis" | "postgres", data: Record<string, string>, opts: { cluster?: Cluster; env?: string[] } = {}) => {
    const dest = kind === "redis" ? "/data" : "/var/lib/postgresql/data";
    volumes.set(ANON, new Map(Object.entries(data)));
    if (opts.cluster) clusters.set(ANON, opts.cluster);
    containers.set(`dk-${APP}`, {
      name: `dk-${APP}`, running: true, health: "none", mounts: [{ type: "volume", name: ANON, destination: dest }],
      labels: { "dockify.app": APP, "dockify.role": "app", "dockify.managed": "true" },
      ...(opts.env ? { env: opts.env } : {}),
    });
  };
  return { docker, containers, volumes, images, registry, log, execs, specs, state, vol, addLegacy, clusters, socketLogins };
}

function fakeDb(app: Row, jobs: Row[] = []) {
  const db = {
    app: {
      findUnique: async ({ where }: Row) => (where.id === app.id ? app : null),
      update: async ({ where, data }: Row) => (where.id === app.id ? Object.assign(app, data) : null),
    },
    job: {
      findFirst: async ({ where }: Row) => jobs.find((j) => (where.dedupeKey.in as string[]).includes(j.dedupeKey) && !j.completedAt && !j.failedAt) ?? null,
    },
  };
  return db as unknown as Db;
}

const vaultOf = (value: string | null): SecretVault => ({
  open: async (_tx, ids) => new Map(ids.map((id) => [id, id === SECRET ? value : null])),
  seal: async () => {
    throw new Error("the managed path never seals a secret");
  },
  escrow: async () => {
    throw new Error("not used");
  },
});

const appRow = (kind: "redis" | "postgres" | "s3" | "backend", over: Row = {}): Row => ({
  id: APP, name: kind === "postgres" ? "main-db" : "cache", kind, environmentId: ENV_ID, environment: { projectId: "p1" },
  image: kind === "postgres" ? "postgres:16-alpine" : "redis:7.4-alpine", pinnedImage: null, passwordSecretId: SECRET,
  memoryLimitMb: null, cpuLimit: null, pidsLimit: null,
  volumes: [{ id: "v1", name: `dockify-data-${APP}`, mountPath: kind === "postgres" ? "/var/lib/postgresql/data" : "/data" }],
  ...over,
});

function setup(kind: "redis" | "postgres" | "s3" | "backend", opts: { secret?: string | null; app?: Row; jobs?: Row[] } = {}) {
  const engine = fakeEngine();
  const app = appRow(kind, opts.app);
  const lines: string[] = [];
  const secret = opts.secret === undefined ? JSON.stringify(kind === "postgres" ? { user: "dockify", password: PASSWORD, database: "main_db" } : { user: "default", password: PASSWORD }) : opts.secret;
  const deps: ManagedDeps = { db: fakeDb(app, opts.jobs), vault: vaultOf(secret), docker: engine.docker, log: (l) => lines.push(l), readyTimeoutMs: 1_000, pollMs: 1 };
  return { ...engine, app, deps, lines };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Error & { permanent?: boolean; rolledBack?: boolean };
  }
  throw new Error("expected the deploy to fail");
};

// ------------------------------------------------------------------------------------- tests

describe("managed service deploy", () => {
  it("first Redis deploy: pulls the tag once, pins the digest, writes its config into its own volume, and never hands it the password on argv or in env", async () => {
    const s = setup("redis");
    const out = await deployManagedService(s.deps, APP);

    expect(s.log.filter((l) => l.startsWith("pull:"))).toEqual(["pull:redis:7.4-alpine"]);
    expect(s.app.pinnedImage).toBe(`redis:7.4-alpine@${DIGEST}`);
    expect(out.pin).toBe(`redis:7.4-alpine@${DIGEST}`);

    const svc = s.containers.get(`dk-${APP}`)!;
    expect(svc.running).toBe(true);
    expect(svc.spec!.Image).toBe(out.imageId);
    expect(svc.spec!.User).toBe("redis");
    expect(svc.spec!.HostConfig.Mounts).toEqual([{ Type: "volume", Source: `dockify-data-${APP}`, Target: "/data", ReadOnly: false }]);
    expect(JSON.stringify(svc.spec)).not.toContain(PASSWORD);
    // The config is in the named volume, with the password, and arrived on stdin, not in the exec's env.
    expect(s.vol(`dockify-data-${APP}`).get(".dockify/redis.conf")).toContain(`requirepass ${PASSWORD}`);
    const write = s.execs.find((e) => e.cmd[2] === SECRET_SCRIPT)!;
    expect(write.container).toBe(`dk-${APP}-setup`);
    expect(JSON.stringify(write)).not.toContain(PASSWORD);
    // The setup helper is gone and sat on the internal helper network.
    expect(s.containers.has(`dk-${APP}-setup`)).toBe(false);
    expect(s.log).toContain("network:dockify-helpers:internal");
    expect(out.adoptedFrom).toBeNull();
  });

  it("redeploys the pinned digest without pulling the tag, stopping the previous container before the new one starts", async () => {
    const s = setup("redis");
    await deployManagedService(s.deps, APP);
    s.registry.set("redis:7.4-alpine", NEWER); // the tag moved upstream
    s.log.length = 0;
    await deployManagedService(s.deps, APP);
    expect(s.log.some((l) => l.startsWith("pull:"))).toBe(false);
    expect(s.app.pinnedImage).toBe(`redis:7.4-alpine@${DIGEST}`);
    const stop = s.log.indexOf(`stop:dk-${APP}`);
    const park = s.log.findIndex((l) => l.startsWith(`rename:dk-${APP}:dk-${APP}-prev-`));
    const start = s.log.lastIndexOf(`start:dk-${APP}`);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(park).toBeGreaterThan(stop);
    expect(start).toBeGreaterThan(park);
    // Only the new container is left.
    expect([...s.containers.keys()]).toEqual([`dk-${APP}`]);
  });

  it("a changed version resolves a new digest", async () => {
    const s = setup("redis", { app: { pinnedImage: `redis:7.4-alpine@${DIGEST}` } });
    s.app.image = "redis:8.2-alpine";
    s.registry.set("redis:8.2-alpine", NEWER);
    await deployManagedService(s.deps, APP);
    expect(s.log).toContain("pull:redis:8.2-alpine");
    expect(s.app.pinnedImage).toBe(`redis:8.2-alpine@${NEWER}`);
  });

  it("upgrade from an older service: a legacy bare password, no project variables, and the data the old container kept on an anonymous volume is adopted and that volume kept", async () => {
    const s = setup("redis", { secret: "Legacy_bare-0123456789abcdefXYZ0" });
    s.addLegacy("redis", { "dump.rdb": "REDIS0011 saved key" });
    const out = await deployManagedService(s.deps, APP);

    expect(out.adoptedFrom).toBe(ANON);
    expect(s.vol(`dockify-data-${APP}`).get("dump.rdb")).toBe("REDIS0011 saved key");
    expect(s.vol(`dockify-data-${APP}`).get(".dockify/redis.conf")).toContain("requirepass Legacy_bare-0123456789abcdefXYZ0");
    // The anonymous volume was mounted read-only into the helper, and is untouched and never removed.
    const helper = s.execs.find((e) => e.cmd[2] === SETUP_SCRIPT)!;
    expect(helper.container).toBe(`dk-${APP}-setup`);
    expect(s.volumes.get(ANON)!.get("dump.rdb")).toBe("REDIS0011 saved key");
    expect(s.log.some((l) => l === `removeVolume:${ANON}`)).toBe(false);
    expect(out.keptVolumes).toEqual([ANON]);
    expect(s.lines.join("\n")).toContain(`kept the anonymous volume ${ANON}`);
    // The old generic container is gone; the managed one runs with the password the old row held.
    expect(s.containers.get(`dk-${APP}`)!.labels["dockify.role"]).toBe("service-redis");
    expect(s.lines.join("\n")).toMatch(/format older versions wrote/);
  });

  it("never copies over a named volume that already holds data", async () => {
    const s = setup("redis");
    s.addLegacy("redis", { "dump.rdb": "old" });
    s.vol(`dockify-data-${APP}`).set("dump.rdb", "current");
    const out = await deployManagedService(s.deps, APP);
    expect(out.adoptedFrom).toBeNull();
    expect(s.vol(`dockify-data-${APP}`).get("dump.rdb")).toBe("current");
    expect(s.lines.join("\n")).toMatch(/already holds data/);
  });

  it("a failed health check after an adoption empties the volume again and puts the old container back, running", async () => {
    const s = setup("redis");
    s.addLegacy("redis", { "dump.rdb": "data" });
    s.state.healthy = false;
    const e = await failure(deployManagedService(s.deps, APP));
    expect(e).toBeInstanceOf(ManagedServiceError);
    expect(e.permanent).toBe(true);
    expect(e.rolledBack).toBe(true);
    expect(e.message).toBe("The service failed its health check. Rolled back: the previous container runs again.");
    const back = s.containers.get(`dk-${APP}`)!;
    expect(back.labels["dockify.role"]).toBe("app");
    expect(back.running).toBe(true);
    expect(s.vol(`dockify-data-${APP}`).size).toBe(0);
    expect(s.volumes.get(ANON)!.get("dump.rdb")).toBe("data");
    expect(s.containers.has(`dk-${APP}-setup`)).toBe(false);
  });

  it("waits while a big Redis dataset is still loading instead of reading it as a wrong password", async () => {
    const s = setup("redis");
    s.state.loadingPings = 3;
    await deployManagedService(s.deps, APP);
    expect(s.state.loadingPings).toBe(0);
    expect(s.execs.filter((e) => e.cmd[0] === "redis-cli" && e.env.REDISCLI_AUTH).length).toBe(4);
  });

  it("refuses a Redis that answers a client without its password, and runs nothing", async () => {
    const s = setup("redis");
    s.state.redisOpen = true;
    const e = await failure(deployManagedService(s.deps, APP));
    expect(e.message).toBe("Redis answered a client without the password; refusing to run it. There was no previous container, so nothing is running.");
    expect(e.permanent).toBe(true);
    expect(s.containers.has(`dk-${APP}`)).toBe(false);
  });

  it("Postgres: the password file goes into the volume, the cluster in pgdata, and the stored credentials are proven", async () => {
    const s = setup("postgres");
    await deployManagedService(s.deps, APP);
    const spec = s.containers.get(`dk-${APP}`)!.spec!;
    expect(spec.Env).toContain("PGDATA=/var/lib/postgresql/data/pgdata");
    expect(spec.Env).toContain("POSTGRES_PASSWORD_FILE=/var/lib/postgresql/data/.dockify/postgres-password");
    expect(JSON.stringify(spec)).not.toContain(PASSWORD);
    expect(s.vol(`dockify-data-${APP}`).get(".dockify/postgres-password")).toBe(PASSWORD);
    expect(s.execs.some((e) => e.cmd[0] === "psql" && e.env.PGPASSWORD === PASSWORD && !e.cmd.join(" ").includes(PASSWORD))).toBe(true);
  });

  /** A cluster the generic pipeline's Postgres created: its own superuser and password, and the app's data in main_db. */
  const oldCluster = (roles: Record<string, string>, databases = ["postgres", "main_db"]): Cluster => ({ roles: new Map(Object.entries(roles)), databases: new Set(databases) });

  it("an adopted Postgres gets the stored password over its local socket, at its root, then logs in with it", async () => {
    const s = setup("postgres");
    s.addLegacy("postgres", { PG_VERSION: "16", "base/1": "rows" }, { cluster: oldCluster({ postgres: "old-password" }) });
    const out = await deployManagedService(s.deps, APP);

    expect(out.adoptedFrom).toBe(ANON);
    // The adopted cluster runs where it was, at the root of the named volume.
    expect(s.specs.get(`dk-${APP}`)!.Env).toContain("PGDATA=/var/lib/postgresql/data");
    // dockify did not exist yet, so the reset connected as the image's superuser and created it with the stored password.
    expect(s.socketLogins).toEqual(["postgres"]);
    expect(s.clusters.get(`dockify-data-${APP}`)!.roles.get("dockify")).toBe(PASSWORD);
    expect(s.lines.join("\n")).toMatch(/set the password of dockify in the adopted database to the stored one, over its local socket as postgres/);
    // The password never rode on argv or in an exec's environment, and the SQL file is gone.
    const reset = s.execs.filter((e) => e.cmd[0] === "psql" && e.cmd.includes(PG_SOCKET_DIR) && e.cmd.includes("-f"));
    expect(reset.length).toBe(2);
    for (const e of reset) expect(JSON.stringify(e)).not.toContain(PASSWORD);
    expect(s.vol(`dockify-data-${APP}`).has(`.dockify/${RESET_FILE}`)).toBe(false);
    // The old cluster in the anonymous volume was never touched.
    expect(s.clusters.get(ANON)!.roles.has("dockify")).toBe(false);
  });

  it("says which old login roles an adopted database keeps, and leaves them alone", async () => {
    const s = setup("postgres");
    s.addLegacy("postgres", { PG_VERSION: "16" }, { cluster: oldCluster({ dockify: "an-older-password", legacy: "legacy-password", "not a role": "x" }) });
    const logged: Array<Record<string, unknown>> = [];
    (s.deps.db as unknown as { activityLog: unknown }).activityLog = { create: async (a: { data: Record<string, unknown> }) => void logged.push(a.data) };
    await deployManagedService(s.deps, APP);
    expect(s.clusters.get(`dockify-data-${APP}`)!.roles.get("legacy")).toBe("legacy-password");
    expect(s.lines.join("\n")).toMatch(/also has the login role legacy, which keep their old passwords/);
    expect(logged[0]).toMatchObject({ action: "service.adopted.roles", targetId: APP });
    expect(String(logged[0]!.suffix)).toContain("legacy");
    expect(String(logged[0]!.suffix)).not.toContain("legacy-password");
  });

  it("removes the setup helper with the anonymous volume its image's VOLUME created", async () => {
    const s = setup("redis");
    const removals: Array<{ id: string; volumes: boolean }> = [];
    const remove = s.deps.docker.remove;
    s.deps.docker.remove = async (id, o) => {
      removals.push({ id, volumes: !!o?.volumes });
      return remove(id, o);
    };
    await deployManagedService(s.deps, APP);
    const helper = removals.filter((r) => r.id === `dk-${APP}-setup`);
    expect(helper.length).toBeGreaterThan(0);
    expect(helper.every((r) => r.volumes)).toBe(true);
  });

  it("connects as the superuser the old container's variables named", async () => {
    const s = setup("postgres");
    s.addLegacy("postgres", { PG_VERSION: "16" }, { cluster: oldCluster({ app: "x" }), env: ["POSTGRES_USER=app", "POSTGRES_PASSWORD=x", "PATH=/usr/bin"] });
    await deployManagedService(s.deps, APP);
    expect(s.socketLogins).toEqual(["app"]);
    expect(s.clusters.get(`dockify-data-${APP}`)!.roles.get("dockify")).toBe(PASSWORD);
  });

  it("an adopted cluster whose stored role already exists just gets the stored password", async () => {
    const s = setup("postgres");
    s.addLegacy("postgres", { PG_VERSION: "16" }, { cluster: oldCluster({ dockify: "an-older-password" }) });
    await deployManagedService(s.deps, APP);
    expect(s.socketLogins).toEqual(["dockify"]);
    expect(s.clusters.get(`dockify-data-${APP}`)!.roles.get("dockify")).toBe(PASSWORD);
  });

  it("a reset that cannot connect leaves the old container running, with one clear error", async () => {
    const s = setup("postgres");
    s.addLegacy("postgres", { PG_VERSION: "16" }, { cluster: oldCluster({ someone: "x" }) });
    const e = await failure(deployManagedService(s.deps, APP));
    expect(e.message).toBe(
      `Could not set the password of dockify in the adopted Postgres over its local socket (psql: error: connection to server on socket "${PG_SOCKET_DIR}/.s.PGSQL.5432" failed: FATAL:  role "postgres" does not exist). Rolled back: the previous container runs again.`,
    );
    expect(e.permanent).toBe(true);
    expect(e.rolledBack).toBe(true);
    expect(s.containers.get(`dk-${APP}`)).toMatchObject({ running: true });
    expect(s.containers.get(`dk-${APP}`)!.labels["dockify.role"]).toBe("app");
    expect(s.volumes.get(ANON)!.get("PG_VERSION")).toBe("16");
    expect(s.vol(`dockify-data-${APP}`).size).toBe(0);
  });

  it("an adopted cluster without the stored database is refused clearly and rolled back", async () => {
    const s = setup("postgres");
    s.addLegacy("postgres", { PG_VERSION: "16" }, { cluster: oldCluster({ postgres: "x" }, ["postgres", "shop"]) });
    const e = await failure(deployManagedService(s.deps, APP));
    expect(e.message).toBe("This Postgres has no database main_db, the one Dockify's credentials name. Rolled back: the previous container runs again.");
    expect(e.rolledBack).toBe(true);
    expect(s.containers.get(`dk-${APP}`)!.running).toBe(true);
  });

  it("writes the reset as SQL with the role quoted and the stored password, refusing names it cannot quote", () => {
    const sql = resetPasswordSql({ user: "dockify", password: PASSWORD });
    expect(sql).toContain(`ALTER ROLE "dockify" WITH LOGIN PASSWORD '${PASSWORD}';`);
    expect(sql).toContain(`CREATE ROLE "dockify" WITH LOGIN SUPERUSER PASSWORD '${PASSWORD}';`);
    expect(() => resetPasswordSql({ user: 'x"; DROP ROLE postgres; --', password: PASSWORD })).toThrow(/not a role name/);
    expect(() => resetPasswordSql({ user: "dockify", password: "it's" })).toThrow(/not one Dockify generated/);
  });

  it("a stored value that is not the JSON shape fails with one clear permanent error, never a JSON exception", async () => {
    const s = setup("redis", { secret: "{broken json" });
    const e = await failure(deployManagedService(s.deps, APP));
    expect(e.message).toBe("The stored credentials of cache are damaged and cannot be read");
    expect(isPermanentError(e)).toBe(true);
    expect(s.log).toEqual([]);
  });

  it("refuses Storage, a non-service, a missing data volume, and a deploy while a backup runs, before touching anything", async () => {
    for (const [s, want] of [
      [setup("s3"), STORAGE_UNAVAILABLE],
      [setup("backend"), "cache is not a managed service"],
      [setup("redis", { app: { volumes: [] } }), /has no data volume at \/data/],
      [setup("redis", { jobs: [{ dedupeKey: `backup:${APP}`, completedAt: null, failedAt: null, kind: "backup" }] }), /A backup of cache is running/],
      // An older row named into Dockify's own dk- names would answer for a route target (dk-route-<id>).
      [setup("redis", { app: { name: "dk-route-0f0f0f0f" } }), /starts with dk-, which Dockify keeps for its own containers and routes/],
    ] as const) {
      const e = await failure(deployManagedService(s.deps, APP));
      if (typeof want === "string") expect(e.message).toBe(want);
      else expect(e.message).toMatch(want);
      expect(isPermanentError(e)).toBe(true);
      expect(s.log).toEqual([]);
    }
  });

  it("a tag the registry does not have fails permanently before anything running is stopped", async () => {
    const s = setup("redis");
    s.addLegacy("redis", {});
    s.app.image = "redis:9.9-alpine";
    const e = await failure(deployManagedService(s.deps, APP));
    expect(e).toBeInstanceOf(ImageResolveError);
    expect(isPermanentError(e)).toBe(true);
    expect(s.containers.get(`dk-${APP}`)!.running).toBe(true);
    expect(s.log.some((l) => l.startsWith("stop:"))).toBe(false);
  });

  it("a rename the socket proxy refuses leaves the old container running under its own name", async () => {
    const s = setup("redis");
    s.addLegacy("redis", { "dump.rdb": "x" });
    s.docker.rename = async () => {
      throw Object.assign(new Error("403 Forbidden"), { status: 403 });
    };
    const e = await failure(deployManagedService(s.deps, APP));
    expect(e.message).toBe("403 Forbidden. Rolled back: the previous container runs again.");
    expect(e.rolledBack).toBe(true);
    expect(s.containers.get(`dk-${APP}`)).toMatchObject({ running: true });
    expect(s.containers.get(`dk-${APP}`)!.labels["dockify.role"]).toBe("app");
  });

  it("a cancel before the swap leaves the running container alone", async () => {
    const s = setup("redis");
    s.addLegacy("redis", {});
    s.deps.checkpoint = () => {
      throw new Error("cancelled");
    };
    await expect(deployManagedService(s.deps, APP)).rejects.toThrow("cancelled");
    expect(s.containers.get(`dk-${APP}`)!.running).toBe(true);
    expect(s.log.some((l) => l.startsWith("stop:") || l.startsWith("rename:"))).toBe(false);
  });

  it("a rollback runs the target's image once and leaves the pin alone", async () => {
    const s = setup("redis", { app: { pinnedImage: `redis:7.4-alpine@${DIGEST}` } });
    s.images.set("sha256:" + "9".repeat(64), { id: "sha256:" + "9".repeat(64), repoDigests: [] });
    const out = await deployManagedService(s.deps, APP, { imageId: "sha256:" + "9".repeat(64) });
    expect(out.imageId).toBe("sha256:" + "9".repeat(64));
    expect(out.pin).toBeNull();
    expect(s.app.pinnedImage).toBe(`redis:7.4-alpine@${DIGEST}`);
    expect(s.log.some((l) => l.startsWith("pull:"))).toBe(false);
  });
});
