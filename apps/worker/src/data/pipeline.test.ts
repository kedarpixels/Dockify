import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db, SecretVault } from "@dockify/db";
import { openBackupKeyEscrow, sealBackupKeyEscrow } from "@dockify/crypto";
import { assertSafeSpec, type ContainerSpec } from "@dockify/engine";
import { listTables, runQuery, scanKeys, tableRows, type PgSession } from "./browser.ts";
import type { DataDeps } from "./context.ts";
import type { ContainerState, DockerPort, ExecHandle } from "./docker-port.ts";
import { backupKeyFingerprint, DecryptStream } from "./envelope.ts";
import { escrowObjectKey } from "./key-escrow.ts";
import { dataJobHandlers } from "./handlers.ts";
import { runBackup, runRestore, runRestoreTest } from "./pipeline.ts";
import type { RedisConn, RespValue } from "./resp.ts";
import { applyRetention, recoverQuiesced } from "./scheduler.ts";
import { settleAbandonedUpgrades } from "./upgrade.ts";
import { LocalStore, S3Store, signRequest, type S3Config } from "./store.ts";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// --------------------------------------------------------------------------------- fakes

type Row = Record<string, any>;

function fakeDb(seed: { apps: Row[]; backups?: Row[]; jobs?: Row[] }) {
  const apps = new Map(seed.apps.map((a) => [a.id, a]));
  const backups = new Map((seed.backups ?? []).map((b) => [b.id, b]));
  const jobs = new Map((seed.jobs ?? []).map((j) => [j.id, j]));
  const log: string[] = [];
  const activity: Row[] = [];
  const schedules: Row[] = [];
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && "in" in v) return (v.in as unknown[]).includes(row[k]);
      if (v && typeof v === "object" && "not" in v) return row[k] !== v.not;
      if (v && typeof v === "object" && "lt" in v) return row[k] && row[k] < v.lt;
      if (v && typeof v === "object" && "gt" in v) return row[k] && row[k] > v.gt;
      return row[k] === v;
    });
  const db = {
    app: {
      findUnique: async ({ where }: Row) => apps.get(where.id) ?? null,
      findMany: async ({ where }: Row) => [...apps.values()].filter((a) => matches(a, where)),
      update: async ({ where, data }: Row) => Object.assign(apps.get(where.id)!, data),
    },
    backupSchedule: {
      updateMany: async ({ where, data }: Row) => {
        schedules.push({ appId: where.appId, tier: where.tier, ...data });
        return { count: 1 };
      },
    },
    backup: {
      findUnique: async ({ where }: Row) => backups.get(where.id) ?? null,
      findMany: async ({ where }: Row) => [...backups.values()].filter((b) => where.id.in.includes(b.id) && b.sourceAppId === where.sourceAppId),
      update: async ({ where, data }: Row) => Object.assign(backups.get(where.id)!, data),
      updateMany: async ({ where, data }: Row) => {
        const b = backups.get(where.id);
        if (!b || !Object.entries(where).every(([k, v]) => k === "id" || b[k] === v)) return { count: 0 };
        Object.assign(b, data);
        return { count: 1 };
      },
      create: async ({ data }: Row) => {
        const row = { id: randomUUID(), createdAt: new Date(), status: "running", objectKey: null, sha256: null, expiredAt: null, ...data };
        backups.set(row.id, row);
        log.push(`backup.create:${data.trigger}`);
        return row;
      },
    },
    job: {
      update: async ({ where, data }: Row) => {
        log.push(`job.update:${JSON.stringify(data.payload?.quiesced ?? data)}`);
        return Object.assign(jobs.get(where.id) ?? {}, data);
      },
      findMany: async ({ where }: Row) => [...jobs.values()].filter((j) => j.kind === where.kind),
    },
    activityLog: { create: async ({ data }: Row) => activity.push(data) },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  return { db: db as unknown as Db, apps, backups, jobs, log, activity, schedules };
}

interface ExecPlan {
  stdout?: string | Buffer;
  exitCode?: number;
  onStdin?: (data: string) => void;
}

/** What the fake registry serves for a tag: the digest a pull resolves it to. */
const TAG_DIGEST = `sha256:${"d".repeat(64)}`;
const IMAGE_ID = `sha256:${"e".repeat(64)}`;

function fakeDocker(plan: (cmd: string[], id: string) => ExecPlan, log: string[]) {
  const containers = new Map<string, ContainerState & { spec?: ContainerSpec }>();
  const images = new Map<string, { id: string; repoDigests: string[] }>();
  /** Every create body, kept after the container is removed. */
  const specs = new Map<string, ContainerSpec>();
  const handle = (p: ExecPlan, stdin: boolean): ExecHandle => {
    const stdout = new PassThrough();
    let input = "";
    let resolveDone!: (r: { exitCode: number; stderr: string }) => void;
    const done = new Promise<{ exitCode: number; stderr: string }>((r) => (resolveDone = r));
    const finish = () => resolveDone({ exitCode: p.exitCode ?? 0, stderr: "" });
    let sink: Writable | null = null;
    if (stdin) {
      sink = new Writable({ write: (c, _e, cb) => ((input += String(c)), cb()), final: (cb) => (p.onStdin?.(input), stdout.end(), finish(), cb()) });
      sink.on("close", () => (sink!.writableFinished ? null : (p.onStdin?.(`ABORTED:${input}`), finish())));
    } else {
      setImmediate(() => {
        stdout.end(p.stdout ?? "");
        finish();
      });
    }
    return { stdout, stdin: sink, done, kill: async () => {} };
  };
  const docker: DockerPort = {
    cpuCores: 4,
    ensureNetwork: async () => {},
    ensureVolume: async (name) => void log.push(`ensureVolume:${name}`),
    removeVolume: async (name) => void log.push(`removeVolume:${name}`),
    createContainer: async (name, spec) => {
      assertSafeSpec(spec);
      log.push(`create:${name}`);
      specs.set(name, spec);
      containers.set(name, { id: name, running: false, health: spec.Healthcheck ? "healthy" : "none", labels: spec.Labels, addresses: {}, spec });
      return name;
    },
    start: async (id) => {
      log.push(`start:${id}`);
      const c = containers.get(id);
      if (c) c.running = true;
    },
    stop: async (id) => {
      log.push(`stop:${id}`);
      const c = containers.get(id);
      if (c) c.running = false;
    },
    remove: async (id) => {
      log.push(`remove:${id}`);
      containers.delete(id);
    },
    inspect: async (id) => containers.get(id) ?? null,
    exec: async (id, o) => {
      log.push(`exec:${id}:${o.cmd[0]}`);
      return handle(plan(o.cmd, id), !!o.stdin);
    },
    attach: async (id, o) => handle(plan(containers.get(id)?.spec?.Cmd ?? [], id), !!o.stdin),
    list: async (labels) =>
      [...containers.entries()]
        .filter(([, c]) => Object.entries(labels).every(([k, v]) => c.labels[k] === v))
        .map(([name, c]) => ({ id: name, names: [name], running: c.running, labels: c.labels })),
    rename: async (name, next) => {
      const c = containers.get(name)!;
      containers.delete(name);
      containers.set(next, { ...c, id: next });
      log.push(`rename:${name}:${next}`);
    },
    inspectImage: async (ref) => images.get(ref) ?? null,
    pullImage: async (ref) => {
      log.push(`pull:${ref}`);
      const repo = ref.split("@")[0]!.replace(/:[^/]*$/, "");
      const img = { id: IMAGE_ID, repoDigests: [`${repo}@${TAG_DIGEST}`] };
      images.set(ref, img);
      images.set(`${repo}@${TAG_DIGEST}`, img);
    },
  };
  const addRunning = (appId: string, extra: Partial<ContainerState> = {}) =>
    containers.set(`dk-${appId}`, { id: `dk-${appId}`, running: true, health: "healthy", labels: { "dockify.app": appId, "dockify.managed": "true" }, addresses: {}, ...extra });
  return { docker, containers, addRunning, specs, images };
}

// --------------------------------------------------------------------------------- setup

const ENV = randomUUID();
const DB_APP = randomUUID();
const WEB_APP = randomUUID();
const creds = { user: "dockify", password: "pw-not-on-argv", database: "app" };
const key = randomBytes(32);
const master = { active: "masterfp", keys: new Map([["masterfp", randomBytes(32)]]) };
const BACKUP_KEY_ROW = randomUUID();
/** What the worker sees: no keyring, only the api's answers. The escrow text is sealed by the api's key. */
const vault: SecretVault = {
  open: async () => { throw new Error("the pipeline must not open secrets through the vault in these tests"); },
  seal: async () => { throw new Error("the pipeline must not seal secrets through the vault in these tests"); },
  escrow: async (_tx, id) => {
    if (id !== BACKUP_KEY_ROW) throw new Error("wrong row");
    return sealBackupKeyEscrow(master, key);
  },
};
let dir: string;

function setup(planOver?: (cmd: string[], id: string) => ExecPlan | undefined) {
  const f = fakeDb({
    apps: [
      { id: DB_APP, name: "db", kind: "postgres", environmentId: ENV, environment: { projectId: "p1" }, desiredState: "running", image: null },
      { id: WEB_APP, name: "web", kind: "backend", environmentId: ENV, environment: { projectId: "p1" }, desiredState: "running" },
    ],
    jobs: [{ id: "job-1", kind: "restore", payload: {} }],
  });
  const restored: string[] = [];
  const d = fakeDocker((cmd, id) => {
    const o = planOver?.(cmd, id);
    if (o) return o;
    if (cmd[0] === "pg_dump") return { stdout: "CREATE TABLE t (id int);\nCOPY t FROM stdin;\n1\n\\.\n" };
    if (cmd[0] === "psql" && cmd.includes("-c")) return { stdout: "1,1\n" };
    if (cmd[0] === "psql") return { onStdin: (s) => restored.push(s) };
    return {};
  }, f.log);
  d.addRunning(DB_APP);
  d.addRunning(WEB_APP);
  const store = new LocalStore(join(dir, "store"));
  const deps: DataDeps = {
    db: f.db,
    vault,
    docker: d.docker,
    tmpDir: join(dir, "tmp"),
    backupKeys: async () => ({ secretId: BACKUP_KEY_ROW, active: key, fingerprint: backupKeyFingerprint(key), all: new Map([[backupKeyFingerprint(key), key]]) }),
    storeFor: async () => ({ store, prefix: "dockify/", destinationId: null, type: "local" }),
    credentials: async () => creds,
  };
  return { ...f, ...d, deps, restored, store };
}

async function backedUp(s: ReturnType<typeof setup>) {
  const b = await s.db.backup.create({ data: { appId: DB_APP, sourceAppId: DB_APP, appSnapshot: { environmentId: ENV }, kind: "postgres", trigger: "manual", destinationId: null } });
  await runBackup(s.deps, b.id);
  return s.backups.get(b.id)!;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dk-pipe-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------------- tests

/**
 * A fake S3 server over real HTTP: path-style PUT, GET and DELETE on one bucket, each checked against
 * the SigV4 signature the access key's secret gives, as a bucket would. Nothing leaves this machine:
 * the store's https endpoint is routed to this local port.
 */
async function fakeS3(cfg: S3Config) {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const prefix = `/${cfg.bucket}/`;
      const key = decodeURIComponent(url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "");
      const stamp = String(req.headers["x-amz-date"] ?? "");
      const at = new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
      const want = signRequest(cfg, req.method ?? "GET", key, String(req.headers["x-amz-content-sha256"] ?? ""), at).headers.authorization;
      calls.push(`${req.method} ${key}`);
      if (!key || req.headers.authorization !== want) {
        res.statusCode = 403;
        return res.end("<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match</Message></Error>");
      }
      if (req.method === "PUT") {
        objects.set(key, Buffer.concat(chunks));
        return res.end();
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        res.statusCode = 204;
        return res.end();
      }
      const body = objects.get(key);
      if (!body) {
        res.statusCode = 404;
        return res.end("<Error><Code>NoSuchKey</Code></Error>");
      }
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  /** A store that signs with these credentials, its https endpoint routed to the fake. */
  const storeWith = (c: S3Config) =>
    new S3Store(c, { guard: async () => {}, fetch: (url, init) => fetch(url.replace(new URL(c.endpoint).origin, `http://127.0.0.1:${port}`), init) });
  return { store: storeWith(cfg), storeWith, objects, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("two tiers against a fake S3 server", () => {
  const cfg: S3Config = { endpoint: "https://s3.fake-b2.test", region: "us-west-004", bucket: "dk-backups", accessKeyId: "fake-key-id", secretAccessKey: "fake-secret" };

  it("stores the offsite copy in the bucket, prunes it by count, deletes the remote object, and restores from it", async () => {
    const s = setup();
    const s3 = await fakeS3(cfg);
    try {
      const here = s.store;
      s.deps.storeFor = async (id) =>
        id === "b2" ? { store: s3.store, prefix: "dockify/", destinationId: "b2", type: "s3" } : { store: here, prefix: "dockify/", destinationId: "here", type: "local" };
      // Two runs a day apart, each one dump to both tiers.
      const runOnce = async (hoursAgo: number) => {
        const mk = (destinationId: string) =>
          s.db.backup.create({ data: { appId: DB_APP, sourceAppId: DB_APP, appSnapshot: { environmentId: ENV }, kind: "postgres", trigger: "schedule", destinationId, createdAt: new Date(Date.now() - hoursAgo * 3_600_000) } });
        const local = await mk("here");
        const remote = await mk("b2");
        await runBackup(s.deps, local.id, true, [remote.id]);
        return { local: s.backups.get(local.id)!, remote: s.backups.get(remote.id)! };
      };
      const old = await runOnce(24);
      const fresh = await runOnce(1);
      expect([old.remote.status, fresh.remote.status]).toEqual(["ready", "ready"]);
      expect(s3.objects.has(old.remote.objectKey)).toBe(true);
      expect(s3.objects.has(fresh.remote.objectKey)).toBe(true);
      // The key escrow travels with the dumps.
      expect([...s3.objects.keys()].some((k) => k.startsWith("dockify/keys/"))).toBe(true);
      expect(Number(fresh.remote.sizeBytes)).toBe(s3.objects.get(fresh.remote.objectKey)!.length);

      // Keep 1 on this server and 1 offsite: the older copy of each tier goes, the remote object with it.
      const tiers = [
        { tier: "local", enabled: true, cron: "0 */12 * * *", timezone: "UTC", keep: 1, keepDays: null, destinationId: null, lastRunAt: null },
        { tier: "offsite", enabled: true, cron: "0 3 * * *", timezone: "UTC", keep: 1, keepDays: null, destinationId: "b2", lastRunAt: null },
      ];
      const rows = (): Row[] => [...s.backups.values()].map((b: Row) => ({ ...b, destination: { type: b.destinationId === "b2" ? "s3" : "local" } }));
      const rdb = {
        app: { findMany: async () => [{ id: DB_APP, backupSchedules: tiers }] },
        job: { findMany: async () => [] },
        backup: {
          findMany: async ({ where }: Row) => (where.appId ? rows().filter((b) => b.appId === where.appId) : []),
          update: async ({ where, data }: Row) => Object.assign(s.backups.get(where.id)!, data),
          deleteMany: async () => ({ count: 0 }),
        },
      } as unknown as Db;
      expect(await applyRetention({ ...s.deps, db: rdb }, new Date())).toEqual({ expired: 2, deleted: 0 });
      expect(s3.objects.has(old.remote.objectKey)).toBe(false);
      expect(s3.calls).toContain(`DELETE ${old.remote.objectKey}`);
      expect(s3.objects.has(fresh.remote.objectKey)).toBe(true);
      await expect(readFile(join(dir, "store", old.local.objectKey))).rejects.toThrow();
      expect(s.backups.get(old.remote.id)!.expiredAt).toBeInstanceOf(Date);
      expect(s.backups.get(fresh.remote.id)!.expiredAt ?? null).toBeNull();

      // A restore reads the offsite copy back over HTTP, verifies it and replays it.
      await runRestore(s.deps, "job-1", { backupId: fresh.remote.id, mode: "replace", targetAppId: DB_APP });
      expect(s3.calls).toContain(`GET ${fresh.remote.objectKey}`);
      expect(s.restored.join("")).toContain("CREATE TABLE t");
      // The expired one is refused before anything is touched.
      await expect(runRestore(s.deps, "job-1", { backupId: old.remote.id, mode: "replace", targetAppId: DB_APP })).rejects.toThrow(/expired/);
    } finally {
      await s3.close();
    }
  });

  it("a wrong secret is refused by the bucket, and fails only the offsite copy", async () => {
    const s = setup();
    const s3 = await fakeS3(cfg);
    try {
      const bad = s3.storeWith({ ...cfg, secretAccessKey: "not-the-secret" });
      const here = s.store;
      s.deps.storeFor = async (id) =>
        id === "b2" ? { store: bad, prefix: "dockify/", destinationId: "b2", type: "s3" } : { store: here, prefix: "dockify/", destinationId: "here", type: "local" };
      const mk = (destinationId: string) => s.db.backup.create({ data: { appId: DB_APP, sourceAppId: DB_APP, appSnapshot: { environmentId: ENV }, kind: "postgres", trigger: "schedule", destinationId } });
      const local = await mk("here");
      const remote = await mk("b2");
      await expect(runBackup(s.deps, local.id, true, [remote.id])).rejects.toThrow(/SignatureDoesNotMatch/);
      expect(s.backups.get(local.id)!.status).toBe("ready");
      expect(s.backups.get(remote.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/SignatureDoesNotMatch/) });
      expect(s3.objects.size).toBe(0);
    } finally {
      await s3.close();
    }
  });
});

describe("backup pipeline", () => {
  it("dumps, encrypts and records size, checksum and key fingerprint", async () => {
    const s = setup();
    const b = await backedUp(s);
    expect(b.status).toBe("ready");
    expect(b.objectKey).toMatch(new RegExp(`^dockify/apps/${DB_APP}/\\d{8}T\\d{6}Z-${b.id}\\.sql\\.gz\\.dkbk$`));
    expect(b.keyFingerprint).toBe(backupKeyFingerprint(key));
    expect(b.encrypted).toBe(true);
    const blob = await readFile(join(dir, "store", b.objectKey));
    expect(Number(b.sizeBytes)).toBe(blob.length);
    expect(blob.includes(Buffer.from("CREATE TABLE"))).toBe(false);
    // Only a scheduled run moves its tier's clock.
    expect(s.schedules).toEqual([]);
  });

  /** Two copies of one run: this server's disk and an offsite bucket, each its own store. */
  const twoTiers = async (s: ReturnType<typeof setup>, offsite: LocalStore | { put: () => Promise<never> }) => {
    const here = s.store;
    s.deps.storeFor = async (id) =>
      id === "b2" ? { store: offsite as LocalStore, prefix: "dockify/", destinationId: "b2", type: "s3" } : { store: here, prefix: "dockify/", destinationId: "here", type: "local" };
    const mk = (destinationId: string) => s.db.backup.create({ data: { appId: DB_APP, sourceAppId: DB_APP, appSnapshot: { environmentId: ENV }, kind: "postgres", trigger: "schedule", destinationId } });
    const local = await mk("here");
    const remote = await mk("b2");
    return { local, remote };
  };

  it("takes one dump for both tiers and stores a copy, sealed to its own row, in each", async () => {
    const s = setup();
    const bucket = new LocalStore(join(dir, "bucket"));
    const { local, remote } = await twoTiers(s, bucket);
    await runBackup(s.deps, local.id, true, [remote.id]);
    expect(s.log.filter((l) => l.endsWith(":pg_dump"))).toHaveLength(1);
    const a = s.backups.get(local.id)!;
    const b = s.backups.get(remote.id)!;
    expect([a.status, b.status]).toEqual(["ready", "ready"]);
    expect(a.sha256).not.toBe(b.sha256);
    // Each decrypts with its own id only, to the same dump.
    for (const [row, store] of [[a, s.store], [b, bucket]] as const) {
      const out: Buffer[] = [];
      await pipeline(await store.get(row.objectKey), new DecryptStream(new Map([[backupKeyFingerprint(key), key]]), row.id), createGunzip(), new Writable({ write: (c, _e, cb) => (out.push(c), cb()) }));
      expect(Buffer.concat(out).toString()).toContain("CREATE TABLE t");
    }
    expect(s.schedules.map((x) => x.tier)).toEqual(["local", "offsite"]);
  });

  it("a bucket that fails fails only its own copy: the local one is ready, and the run says why", async () => {
    const s = setup();
    const { local, remote } = await twoTiers(s, { put: async () => { throw new Error("SlowDown: please reduce your request rate"); } });
    await expect(runBackup(s.deps, local.id, true, [remote.id])).rejects.toThrow(/SlowDown/);
    expect(s.backups.get(local.id)!.status).toBe("ready");
    expect(s.backups.get(remote.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/SlowDown/) });
    expect(s.schedules.map((x) => x.tier)).toEqual(["local"]);
  });

  it("a retry dumps again only for the copy still running", async () => {
    const s = setup();
    let down = true;
    const bucket = new LocalStore(join(dir, "bucket"));
    const flaky = { put: async (...a: Parameters<LocalStore["put"]>) => (down ? Promise.reject(new Error("timeout")) : bucket.put(...a)) };
    const { local, remote } = await twoTiers(s, flaky as never);
    await expect(runBackup(s.deps, local.id, false, [remote.id])).rejects.toThrow(/timeout/);
    const firstLocal = s.backups.get(local.id)!.objectKey;
    expect(s.backups.get(remote.id)).toMatchObject({ status: "running", error: "timeout" });
    down = false;
    await runBackup(s.deps, local.id, true, [remote.id]);
    expect(s.backups.get(remote.id)!.status).toBe("ready");
    expect(s.backups.get(local.id)!.objectKey).toBe(firstLocal);
    expect(s.log.filter((l) => l.endsWith(":pg_dump"))).toHaveLength(2);
  });

  it("restores the offsite copy like any other backup", async () => {
    const s = setup();
    const bucket = new LocalStore(join(dir, "bucket"));
    const { local, remote } = await twoTiers(s, bucket);
    await runBackup(s.deps, local.id, true, [remote.id]);
    await runRestore(s.deps, "job-1", { backupId: remote.id, mode: "replace", targetAppId: DB_APP });
    expect(s.restored.join("")).toContain("CREATE TABLE t");
  });

  it("escrows the backup key, sealed by the api under the master key, beside the dumps", async () => {
    const s = setup();
    await backedUp(s);
    const text = await readFile(join(dir, "store", escrowObjectKey("dockify/", backupKeyFingerprint(key))), "utf8");
    expect(text).not.toContain(key.toString("base64"));
    // A fresh install holding only the master key recovers the exact backup key.
    const fresh = { active: master.active, keys: new Map(master.keys) };
    expect(openBackupKeyEscrow(fresh, text).key.equals(key)).toBe(true);
    // Without the master key the file is useless.
    expect(() => openBackupKeyEscrow({ active: "masterfp", keys: new Map([["masterfp", randomBytes(32)]]) }, text)).toThrow();
  });

  it("marks the row failed on the last attempt only", async () => {
    const s = setup((cmd) => (cmd[0] === "pg_dump" ? { stdout: "", exitCode: 1 } : undefined));
    const b = await s.db.backup.create({ data: { appId: DB_APP, sourceAppId: DB_APP, appSnapshot: {}, kind: "postgres", trigger: "schedule" } });
    await expect(runBackup(s.deps, b.id, false)).rejects.toThrow(/pg_dump exited with code 1/);
    expect(s.backups.get(b.id)!.status).toBe("running");
    expect(s.backups.get(b.id)!.error).toMatch(/pg_dump exited with code 1/);
    await expect(runBackup(s.deps, b.id, true)).rejects.toThrow();
    expect(s.backups.get(b.id)!.status).toBe("failed");
  });

  it("fails the row with the reason when the scratch folder cannot be made", async () => {
    const s = setup();
    // A file where the folder should be: mkdir fails the way EACCES did on the box, before any dump.
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "x");
    s.deps.tmpDir = join(blocker, "tmp");
    const b = await s.db.backup.create({ data: { appId: DB_APP, sourceAppId: DB_APP, appSnapshot: {}, kind: "postgres", trigger: "manual" } });
    await expect(runBackup(s.deps, b.id, true)).rejects.toThrow();
    const row = s.backups.get(b.id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/ENOTDIR|EEXIST|not a directory/i);
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it("fails the row at once on an error a retry cannot fix, whatever its class", async () => {
    const s = setup();
    s.deps.credentials = async () => {
      throw Object.assign(new Error("The stored credentials of db are damaged and cannot be read"), { permanent: true });
    };
    const b = await s.db.backup.create({ data: { appId: DB_APP, sourceAppId: DB_APP, appSnapshot: {}, kind: "postgres", trigger: "manual" } });
    await expect(runBackup(s.deps, b.id, false)).rejects.toThrow(/damaged/);
    expect(s.backups.get(b.id)).toMatchObject({ status: "failed", error: "The stored credentials of db are damaged and cannot be read" });
  });

  it("the job handler fails a row its pipeline never reached, on the last attempt", async () => {
    const s = setup();
    const b = await s.db.backup.create({ data: { appId: DB_APP, sourceAppId: DB_APP, appSnapshot: {}, kind: "postgres", trigger: "manual" } });
    const read = s.db.backup.findUnique;
    s.db.backup.findUnique = (async () => {
      throw new Error("connection reset while reading the backup row");
    }) as never;
    const handlers = dataJobHandlers(s.deps);
    const job = { id: "j1", kind: "backup" as const, lane: "data" as const, payload: { backupId: b.id }, attempts: 1, maxAttempts: 2 };
    await expect(handlers.backup!(job, new AbortController().signal)).rejects.toThrow(/connection reset/);
    expect(s.backups.get(b.id)!.status).toBe("running");
    await expect(handlers.backup!({ ...job, attempts: 2 }, new AbortController().signal)).rejects.toThrow(/connection reset/);
    expect(s.backups.get(b.id)).toMatchObject({ status: "failed", error: "connection reset while reading the backup row" });
    s.db.backup.findUnique = read;
  });
});

describe("control-plane dump offsite copy", () => {
  const ID = "11111111-1111-4111-8111-111111111111";
  const seed = async (s: ReturnType<typeof setup>, sha: string) => {
    const file = join(dir, "control", `pre-update-${ID}.dump`);
    await import("node:fs/promises").then((m) => m.mkdir(join(dir, "control"), { recursive: true }));
    await writeFile(file, "PGDMP control plane");
    s.deps.controlDumpPath = (id) => join(dir, "control", `pre-update-${id}.dump`);
    s.backups.set(ID, { id: ID, appId: null, sourceAppId: "00000000-0000-0000-0000-000000000000", appSnapshot: { dumpSha256: sha }, kind: "control_plane", trigger: "pre_update", status: "running", destinationId: null, createdAt: new Date(), objectKey: null, sha256: null, expiredAt: null });
  };

  it("checks the updater's sha256, encrypts and uploads it, and never restores it into an app", async () => {
    const s = setup();
    const { createHash } = await import("node:crypto");
    await seed(s, createHash("sha256").update("PGDMP control plane").digest("hex"));
    await runBackup(s.deps, ID);
    const row = s.backups.get(ID)!;
    expect(row.status).toBe("ready");
    expect(row.objectKey).toMatch(/^dockify\//);
    expect(row.encrypted).toBe(true);
    // The uploaded object is ciphertext, not the dump.
    const stored = await readFile(join(dir, "store", row.objectKey));
    expect(stored.includes(Buffer.from("PGDMP"))).toBe(false);
    await expect(runRestore(s.deps, "job-1", { backupId: ID, mode: "new", name: "x" } as never)).rejects.toThrow();
  });

  it("refuses a dump that does not match the recorded checksum", async () => {
    const s = setup();
    await seed(s, "0".repeat(64));
    await expect(runBackup(s.deps, ID)).rejects.toThrow(/does not match the checksum/);
    expect(s.backups.get(ID)!.status).toBe("failed");
  });
});

describe("restore", () => {
  it("replace in place: pre-restore dump, quiesce recorded before any stop, one framed transaction, apps resumed", async () => {
    const s = setup();
    const b = await backedUp(s);
    s.log.length = 0;
    await runRestore(s.deps, "job-1", { backupId: b.id, mode: "replace", targetAppId: DB_APP });

    const preIdx = s.log.findIndex((l) => l === "backup.create:pre_restore");
    const recordIdx = s.log.findIndex((l) => l.startsWith("job.update:") && l.includes(WEB_APP));
    const stopIdx = s.log.indexOf(`stop:dk-${WEB_APP}`);
    expect(preIdx).toBeGreaterThanOrEqual(0);
    expect(recordIdx).toBeGreaterThan(preIdx);
    expect(stopIdx).toBeGreaterThan(recordIdx);
    expect(s.log.lastIndexOf(`start:dk-${WEB_APP}`)).toBeGreaterThan(stopIdx);

    const sql = s.restored.at(-1)!;
    expect(sql.startsWith("SELECT pg_terminate_backend")).toBe(true);
    expect(sql).toContain("BEGIN;\nDO $dockify$");
    expect(sql).toContain("GRANT USAGE ON SCHEMA public TO PUBLIC;\nCREATE TABLE t (id int);");
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(s.jobs.get("job-1")!.payload.resumedAt).toBeTruthy();
    expect(s.activity.at(-1)!.failed).toBe(false);
  });

  const redisWorld = async (over: (cmd: string[]) => ExecPlan | undefined = () => undefined) => {
    const s = setup((cmd) => over(cmd) ?? (cmd[0] === "redis-cli" && cmd[1] === "--rdb" ? { stdout: "REDIS0011xx" } : cmd[0] === "redis-cli" && cmd.at(-1) === "ping" ? { stdout: cmd.includes("--no-auth-warning") ? "PONG\n" : "NOAUTH\n" } : undefined));
    s.apps.get(DB_APP)!.kind = "redis";
    const row = await s.db.backup.create({ data: { appId: DB_APP, sourceAppId: DB_APP, appSnapshot: { environmentId: ENV }, kind: "redis", trigger: "manual", destinationId: null } });
    await runBackup(s.deps, row.id);
    s.log.length = 0;
    return { s, b: s.backups.get(row.id)! };
  };

  it("a Redis restore swaps, shuts down, starts, and proves the service before reporting success", async () => {
    const fresh = await redisWorld();
    await runRestore(fresh.s.deps, "job-1", { backupId: fresh.b.id, mode: "replace", targetAppId: DB_APP });
    const l = fresh.s.log;
    const at = (x: string) => l.indexOf(x);
    expect(at(`stop:dk-${DB_APP}`)).toBeGreaterThan(-1);
    expect(at(`start:dk-${DB_APP}`)).toBeGreaterThan(at(`stop:dk-${DB_APP}`));
    expect(l.filter((x) => x === `exec:dk-${DB_APP}:redis-cli`).length).toBeGreaterThanOrEqual(3);
    expect(fresh.s.containers.get(`dk-${DB_APP}`)!.running).toBe(true);
    expect(fresh.s.activity.at(-1)).toMatchObject({ failed: false, verb: "restored a backup over" });
  });

  it("a failed swap fails the restore and leaves Redis running on what it had", async () => {
    const { s, b } = await redisWorld((cmd) => (cmd[0] === "sh" && cmd[2]?.includes("CONFIG SET") ? { exitCode: 1 } : undefined));
    await expect(runRestore(s.deps, "job-1", { backupId: b.id, mode: "replace", targetAppId: DB_APP })).rejects.toThrow(/swapping the snapshot in exited with code 1/);
    expect(s.containers.get(`dk-${DB_APP}`)!.running).toBe(true);
    expect(s.log).not.toContain(`stop:dk-${DB_APP}`);
    expect(s.activity.at(-1)).toMatchObject({ failed: true, verb: "failed to restore a backup into" });
  });

  it("a Redis that does not come back on the snapshot fails the restore, however clean the swap", async () => {
    const { s, b } = await redisWorld();
    const start = s.docker.start;
    s.docker.start = async (id) => {
      await start(id);
      if (id === `dk-${DB_APP}`) s.containers.get(id)!.health = "unhealthy";
    };
    await expect(runRestore(s.deps, "job-1", { backupId: b.id, mode: "replace", targetAppId: DB_APP })).rejects.toThrow(/did not come back on the restored snapshot.*just before this restore/);
    expect(s.activity.at(-1)).toMatchObject({ failed: true });
  });

  it("an app that will not start after a restore is reported, and recovery tries it again", async () => {
    const s = setup();
    const b = await backedUp(s);
    const start = s.docker.start;
    let refuse = true;
    s.docker.start = async (id) => {
      if (refuse && id === `dk-${WEB_APP}`) throw new Error("no space left on device");
      await start(id);
    };
    await runRestore(s.deps, "job-1", { backupId: b.id, mode: "replace", targetAppId: DB_APP });
    const job = s.jobs.get("job-1")!;
    expect(job.payload.resumedAt).toBeUndefined();
    expect(job.payload.quiesced).toEqual([WEB_APP]);
    expect(s.activity.at(-1)).toMatchObject({ failed: true, verb: "could not start every app again after restoring a backup over" });
    refuse = false;
    Object.assign(job, { completedAt: new Date(), attempts: 1, maxAttempts: 1 });
    s.deps.db.job.findMany = (async () => [job]) as never;
    expect(await recoverQuiesced(s.deps, new Date(), "s1")).toBe(1);
    expect(s.containers.get(`dk-${WEB_APP}`)!.running).toBe(true);
    expect(job.payload.resumedAt).toBeTruthy();
  });

  it("refuses a tampered backup before stopping anything or touching the database", async () => {
    const s = setup();
    const b = await backedUp(s);
    const p = join(dir, "store", b.objectKey);
    const blob = await readFile(p);
    blob[blob.length - 20] = blob[blob.length - 20]! ^ 0xff;
    await writeFile(p, blob);
    s.log.length = 0;
    s.restored.length = 0;
    await expect(runRestore(s.deps, "job-1", { backupId: b.id, mode: "replace", targetAppId: DB_APP })).rejects.toThrow(/checksum/);
    expect(s.log.some((l) => l.startsWith("stop:") || l.startsWith("exec:"))).toBe(false);
    expect(s.restored).toEqual([]);
  });

  it("a version change whose worker died reads failed, can be retried, and one still running is left alone", async () => {
    const state: Record<string, Record<string, unknown>> = { dead: { phase: "switching", targetId: "t" }, live: { phase: "copying" }, none: { phase: "upgrading" }, ok: { phase: "switched" } };
    const lastJob: Record<string, object> = {
      "service-upgrade:dead": { payload: { action: "switch" }, lastError: "The worker stopped before this job finished", completedAt: null, failedAt: new Date() },
      "service-upgrade:live": { payload: { action: "prepare" }, lastError: null, completedAt: null, failedAt: null },
    };
    const db = {
      app: {
        findMany: async () => ["dead", "live", "none"].map((id) => ({ id, name: id })),
        findUnique: async ({ where }: { where: { id: string } }) => ({ serviceUpgrade: state[where.id] }),
        update: async ({ where, data }: { where: { id: string }; data: { serviceUpgrade: Record<string, unknown> } }) => void (state[where.id] = data.serviceUpgrade),
      },
      job: { findMany: async ({ where }: { where: { dedupeKey: string } }) => (lastJob[where.dedupeKey] ? [lastJob[where.dedupeKey]] : []) },
      activityLog: { create: async () => ({}) },
    };
    expect(await settleAbandonedUpgrades({ db } as never)).toBe(2);
    expect(state.dead).toMatchObject({ phase: "failed", failedAt: "switch", error: "The worker stopped before this job finished", targetId: "t" });
    expect(state.live!.phase).toBe("copying");
    expect(state.none).toMatchObject({ phase: "failed", error: "The worker stopped before this finished." });
    expect(state.ok!.phase).toBe("switched");
  });

  it("recovery restarts apps a crashed restore left stopped", async () => {
    const s = setup();
    await s.docker.stop(`dk-${WEB_APP}`, 1);
    s.jobs.set("job-2", { id: "job-2", kind: "restore", attempts: 1, maxAttempts: 1, failedAt: null, completedAt: null, lockedUntil: new Date(0), payload: { backupId: randomUUID(), mode: "replace", targetAppId: DB_APP, quiesced: [WEB_APP] } });
    s.deps.db.job.findMany = (async () => [s.jobs.get("job-2")]) as never;
    expect(await recoverQuiesced(s.deps, new Date(), "s1")).toBe(1);
    expect(s.containers.get(`dk-${WEB_APP}`)!.running).toBe(true);
    expect(s.jobs.get("job-2")!.failedAt).toBeInstanceOf(Date);
  });
});

describe("restore test", () => {
  it("replays into a throwaway database, counts, records and removes it", async () => {
    const s = setup();
    const b = await backedUp(s);
    s.log.length = 0;
    const out = await runRestoreTest(s.deps, b.id);
    expect(out).toEqual({ status: "passed", tables: 1, rows: 1, error: null });
    expect(s.log).toContain(`create:dockify-rt-${b.id}`);
    expect(s.log).toContain(`remove:dockify-rt-${b.id}`);
    expect(s.containers.has(`dockify-rt-${b.id}`)).toBe(false);
    // The decrypted copy is on a named, labelled volume, gone with the test.
    expect(s.log).toContain(`ensureVolume:dk-rt-${b.id}`);
    expect(s.log).toContain(`removeVolume:dk-rt-${b.id}`);
    expect(s.log.lastIndexOf(`removeVolume:dk-rt-${b.id}`)).toBeGreaterThan(s.log.lastIndexOf(`remove:dockify-rt-${b.id}`));
    expect(s.log.lastIndexOf(`remove:dockify-rt-${b.id}`)).toBeGreaterThan(s.log.indexOf(`create:dockify-rt-${b.id}`));
    const row = s.backups.get(b.id)!;
    expect(row.restoreTestStatus).toBe("passed");
    expect(row.restoreTestTables).toBe(1);
    // The scratch server runs the image the tag resolved to, by its local id, on the internal helper network.
    const spec = s.specs.get(`dockify-rt-${b.id}`)!;
    expect(spec.Image).toBe(IMAGE_ID);
    expect(spec.HostConfig.NetworkMode).toBe("dockify-helpers");
    expect(spec.HostConfig.Mounts).toEqual([{ Type: "volume", Source: `dk-rt-${b.id}`, Target: "/var/lib/postgresql/data", ReadOnly: false }]);
    expect(spec.Labels).toMatchObject({ "dockify.role": "restore-test" });
    // A throwaway password, with no file in its volume to read one from.
    expect(spec.Env.some((e) => e.startsWith("POSTGRES_PASSWORD="))).toBe(true);
    expect(s.log).toContain("pull:postgres:17-alpine");
  });

  it("removes the decrypted copy when the replay fails too", async () => {
    const s = setup((cmd) => (cmd[0] === "psql" && !cmd.includes("-c") ? { exitCode: 3 } : undefined));
    const b = await backedUp(s);
    s.log.length = 0;
    const out = await runRestoreTest(s.deps, b.id);
    expect(out.status).toBe("failed");
    expect(s.containers.has(`dockify-rt-${b.id}`)).toBe(false);
    expect(s.log).toContain(`removeVolume:dk-rt-${b.id}`);
  });

  it("removes the copy when the scratch server never came up, and starts over from a clean volume", async () => {
    const s = setup();
    const b = await backedUp(s);
    s.log.length = 0;
    const start = s.docker.start;
    s.docker.start = async (id) => {
      if (id === `dockify-rt-${b.id}`) throw new Error("no room");
      return start(id);
    };
    const out = await runRestoreTest(s.deps, b.id);
    expect(out).toMatchObject({ status: "failed", error: "no room" });
    expect(s.containers.has(`dockify-rt-${b.id}`)).toBe(false);
    // Once before it starts (what an earlier run left) and once after.
    expect(s.log.filter((l) => l === `removeVolume:dk-rt-${b.id}`)).toHaveLength(2);
  });

  it("runs the source service's pinned digest, without pulling its tag again", async () => {
    const s = setup();
    const pin = `postgres:16-alpine@${TAG_DIGEST}`;
    Object.assign(s.apps.get(DB_APP)!, { image: "postgres:16-alpine", pinnedImage: pin });
    s.images.set(`postgres@${TAG_DIGEST}`, { id: IMAGE_ID, repoDigests: [`postgres@${TAG_DIGEST}`] });
    const b = await backedUp(s);
    s.log.length = 0;
    expect((await runRestoreTest(s.deps, b.id)).status).toBe("passed");
    expect(s.log.some((l) => l.startsWith("pull:"))).toBe(false);
    expect(s.specs.get(`dockify-rt-${b.id}`)!.Image).toBe(IMAGE_ID);
  });

  it("a restore test job that fails before it can record anything still settles the row", async () => {
    const s = setup();
    const b = await backedUp(s);
    s.backups.get(b.id)!.restoreTestStatus = "running";
    s.db.backup.findUnique = (async () => {
      throw new Error("the database went away");
    }) as never;
    const job = { id: "j2", kind: "restore_test" as const, lane: "data" as const, payload: { backupId: b.id }, attempts: 1, maxAttempts: 1 };
    await expect(dataJobHandlers(s.deps).restore_test!(job, new AbortController().signal)).rejects.toThrow(/went away/);
    expect(s.backups.get(b.id)).toMatchObject({ restoreTestStatus: "failed", restoreTestError: "the database went away" });
  });

  it("records a failure with the reason", async () => {
    const s = setup();
    const b = await backedUp(s);
    await rm(join(dir, "store", b.objectKey));
    const out = await runRestoreTest(s.deps, b.id);
    expect(out.status).toBe("failed");
    expect(s.backups.get(b.id)!.restoreTestError).toMatch(/missing/);
  });
});

// ---------------------------------------------------------------------------------- browser

function fakePg(answers: (text: string, values?: unknown[]) => { fields?: Array<{ name: string; dataTypeID: number }>; rows?: unknown[][] }) {
  const seen: string[] = [];
  const pg: PgSession = {
    query: async (text, values) => {
      seen.push(text);
      const a = answers(text, values);
      return { fields: a.fields ?? [], rows: a.rows ?? [] };
    },
    close: async () => {},
  };
  return { pg, seen };
}

describe("postgres browser", () => {
  it("runs every call read-only, as the browser role, and rolls back", async () => {
    const { pg, seen } = fakePg((t) => (t.startsWith("SELECT current_database") ? { rows: [["app"]] } : { rows: [["public", "users", "10", "8192"]] }));
    const out = await listTables(pg);
    expect(out).toEqual({ database: "app", tables: [{ schema: "public", name: "users", rows: 10, sizeBytes: 8192 }] });
    expect(seen.indexOf("BEGIN TRANSACTION READ ONLY")).toBeGreaterThan(0);
    expect(seen).toContain("SET LOCAL statement_timeout = 15000");
    expect(seen).toContain("SET LOCAL ROLE dockify_browser");
    expect(seen.at(-1)).toBe("ROLLBACK");
  });

  it("caps rows through a cursor and reports truncation", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => [String(i), "t"]);
    const { pg, seen } = fakePg((t) => {
      if (t.startsWith("FETCH")) return { fields: [{ name: "id", dataTypeID: 23 }, { name: "ok", dataTypeID: 16 }], rows: many };
      if (t.startsWith("SELECT oid::int")) return { rows: [[23, "integer"], [16, "boolean"]] };
      return {};
    });
    const r = await runQuery(pg, "select id, ok from t");
    expect(seen.some((s) => s.startsWith("DECLARE dockify_browse NO SCROLL CURSOR FOR select id, ok from t"))).toBe(true);
    expect(r.rows).toHaveLength(1000);
    expect(r.rows[0]).toEqual([0, true]);
    expect(r.truncated).toBe(true);
    expect(r.columns).toEqual([{ name: "id", type: "integer" }, { name: "ok", type: "boolean" }]);
    expect(seen.at(-1)).toBe("ROLLBACK");
  });

  it("refuses writes before connecting a transaction", async () => {
    const { pg, seen } = fakePg(() => ({}));
    await expect(runQuery(pg, "DELETE FROM users")).rejects.toThrow(/read-only/);
    expect(seen).toEqual([]);
  });

  it("reads table rows with columns and an exact count for small tables", async () => {
    const { pg } = fakePg((t) => {
      if (t.startsWith("SELECT a.attname")) return { rows: [["id", "integer", false, true, "3"], ["name", "text", true, false, "3"]] };
      if (t.startsWith('SELECT * FROM "public"."users" LIMIT 50')) return { fields: [{ name: "id", dataTypeID: 23 }, { name: "name", dataTypeID: 25 }], rows: [["1", "a"]] };
      if (t.startsWith("SELECT count(*)")) return { rows: [["3"]] };
      return {};
    });
    const r = await tableRows(pg, "public.users");
    expect(r.columns[0]).toEqual({ name: "id", type: "integer", nullable: false, primary: true });
    expect(r.rows).toEqual([[1, "a"]]);
    expect(r.total).toBe(3);
  });
});

describe("redis browser", () => {
  it("scans with SCAN (never KEYS) and reports type, ttl and size", async () => {
    const sent: string[][] = [];
    const conn: RedisConn = {
      command: async (args) => {
        sent.push([...args]);
        const replies: Record<string, RespValue> = { SCAN: ["0", ["a", "b"]], DBSIZE: 2 };
        if (args[0] === "TYPE") return args[1] === "a" ? "string" : "hash";
        if (args[0] === "PTTL") return args[1] === "a" ? 1500 : -1;
        if (args[0] === "MEMORY") return 64;
        return replies[args[0]!] ?? null;
      },
      close: () => {},
    };
    const r = await scanKeys(conn, "*", 10);
    expect(r).toEqual({ keys: [{ key: "a", type: "string", ttlSeconds: 2, sizeBytes: 64 }, { key: "b", type: "hash", ttlSeconds: null, sizeBytes: 64 }], total: 2, truncated: false });
    expect(sent.some((c) => c[0] === "KEYS")).toBe(false);
  });
});
