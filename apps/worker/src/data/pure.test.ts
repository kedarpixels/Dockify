import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterAll, describe, expect, it } from "vitest";
import { assertSafeSpec } from "@dockify/engine";
import { CronError, nextRun, parseCron } from "./cron.ts";
import { parseRestoreCheck, pgDumpCommand, psqlCommand, redisDumpCommand, redisSwapCommand, REPLACE_SCHEMAS_SQL, RESTORE_COMMIT, RESTORE_PREAMBLE, RestoreFramer, TERMINATE_OTHERS_SQL } from "./dump.ts";
import { backupKeyFingerprint, CHUNK_BYTES, DecryptStream, EncryptStream, EnvelopeError, peekFingerprint } from "./envelope.ts";
import { encodeCommand, parseReply, RespError } from "./resp.ts";
import { failedRowsToDelete, isRetentionDecrease, selectExpired, type RetentionCandidate } from "./retention.ts";
import { connectionUrl, generateCredentials, provisionService, redisConfig, serviceSpec, STORAGE_UNAVAILABLE, type ServiceApp } from "./services.ts";
import type { DockerPort } from "./docker-port.ts";
import { toState } from "./engine-port.ts";
import { isPermanentError } from "../errors.ts";
import { guardReadOnlySql, maskSql, quoteQualified, SqlGuardError } from "./sql-guard.ts";
import { assertKey, backupObjectKey, LocalStore, S3Store, signRequest, StoreError } from "./store.ts";
import { TarGuard, TarGuardError } from "./tar-guard.ts";

const collect = async (r: Readable): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const c of r) parts.push(c as Buffer);
  return Buffer.concat(parts);
};

// --------------------------------------------------------------------------------------- cron

describe("cron", () => {
  const at = (s: string) => new Date(s);
  it("finds the next daily run in UTC", () => {
    expect(nextRun("30 3 * * *", "UTC", at("2026-10-30T02:00:00Z")).toISOString()).toBe("2026-10-30T03:30:00.000Z");
    expect(nextRun("30 3 * * *", "UTC", at("2026-10-30T03:30:00Z")).toISOString()).toBe("2026-10-31T03:30:00.000Z");
  });
  it("handles steps, lists and ranges", () => {
    expect(nextRun("*/15 * * * *", "UTC", at("2026-10-30T10:07:00Z")).toISOString()).toBe("2026-10-30T10:15:00.000Z");
    expect(nextRun("0 9-17/4 * * 1-5", "UTC", at("2026-10-30T14:00:00Z")).toISOString()).toBe("2026-10-30T17:00:00.000Z");
    expect(nextRun("0 9-17/4 * * 1-5", "UTC", at("2026-10-30T17:00:00Z")).toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(nextRun("0 0 1,15 * *", "UTC", at("2026-10-16T00:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
  it("treats 7 as Sunday and ORs the two day fields", () => {
    expect(nextRun("0 4 * * 7", "UTC", at("2026-10-30T00:00:00Z")).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(nextRun("0 0 13 * 5", "UTC", at("2026-10-31T00:00:00Z")).toISOString()).toBe("2026-11-06T00:00:00.000Z");
  });
  it("evaluates wall time in the schedule's zone", () => {
    expect(nextRun("0 2 * * *", "Europe/Istanbul", at("2026-10-30T00:00:00Z")).toISOString()).toBe("2026-10-30T23:00:00.000Z");
    expect(nextRun("0 9 * * *", "Asia/Kolkata", at("2026-10-30T00:00:00Z")).toISOString()).toBe("2026-10-30T03:30:00.000Z");
  });
  it("fires a time repeated by a DST fall back only once", () => {
    // Europe/Berlin falls back on 2026-10-25 at 03:00 to 02:00.
    const first = nextRun("30 2 * * *", "Europe/Berlin", at("2026-10-25T00:00:00Z"));
    expect(first.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(nextRun("30 2 * * *", "Europe/Berlin", first).toISOString()).toBe("2026-10-26T01:30:00.000Z");
  });
  it("refuses bad expressions and zones", () => {
    expect(() => parseCron("* * * *")).toThrow(CronError);
    expect(() => parseCron("61 * * * *")).toThrow(CronError);
    expect(() => parseCron("*/0 * * * *")).toThrow(CronError);
    expect(() => nextRun("0 0 * * *", "Mars/Olympus")).toThrow(CronError);
    expect(() => nextRun("0 0 30 2 *", "UTC")).toThrow(CronError);
  });
});

// ---------------------------------------------------------------------------------- retention

describe("retention", () => {
  const now = new Date("2026-10-30T00:00:00Z");
  const row = (id: string, daysAgo: number, over: Partial<RetentionCandidate> = {}): RetentionCandidate => ({
    id, status: "ready", trigger: "schedule", createdAt: new Date(now.getTime() - daysAgo * 86_400_000), objectKey: `k/${id}`, expiredAt: null, ...over,
  });
  const ids = (rows: RetentionCandidate[]) => rows.map((r) => r.id);
  it("keeps the last N good backups by count, whatever their age", () => {
    const rows = [row("a", 0.5), row("b", 1), row("c", 1.5), row("d", 2), row("e", 30)];
    expect(ids(selectExpired(rows, { keep: 1, keepDays: null }, now))).toEqual(["b", "c", "d", "e"]);
    expect(ids(selectExpired(rows, { keep: 7, keepDays: null }, now))).toEqual([]);
    expect(ids(selectExpired([row("a", 400), row("b", 500)], { keep: 1, keepDays: null }, now))).toEqual(["b"]);
  });
  it("never counts a failed or running run, so a failure never pushes the last good backup out", () => {
    const rows = [row("f1", 0.1, { status: "failed", objectKey: null }), row("r", 0.05, { status: "running", objectKey: null }), row("good", 1), row("older", 2)];
    expect(ids(selectExpired(rows, { keep: 1, keepDays: null }, now))).toEqual(["older"]);
  });
  it("never removes the only good backup of a tier", () => {
    expect(selectExpired([row("only", 90)], { keep: 1, keepDays: null }, now)).toEqual([]);
    // The newest failed its restore test: the newest one that did not stays too.
    const rows = [row("broken", 1, { restoreTestStatus: "failed" }), row("good", 2, { restoreTestStatus: "passed" }), row("old", 3)];
    expect(ids(selectExpired(rows, { keep: 1, keepDays: null }, now))).toEqual(["old"]);
  });
  it("never removes a backup a restore is reading", () => {
    const rows = [row("a", 1), row("b", 2), row("c", 3)];
    expect(ids(selectExpired(rows, { keep: 1, keepDays: null }, now, new Set(["c"])))).toEqual(["b"]);
  });
  it("with keepDays, also keeps every backup from that window: the rule before tiers", () => {
    const rows = [row("a", 1), row("b", 2), row("c", 3), row("d", 20), row("e", 30)];
    expect(ids(selectExpired(rows, { keep: 3, keepDays: 14 }, now))).toEqual(["d", "e"]);
    expect(ids(selectExpired([row("a", 40), row("b", 50), row("c", 60), row("d", 70)], { keep: 3, keepDays: 1 }, now))).toEqual(["d"]);
  });
  it("never expires or counts manual backups, failed rows or rows already expired", () => {
    const rows = [row("m1", 0.1, { trigger: "manual" }), row("a", 1), row("m", 90, { trigger: "manual" }), row("f", 90, { status: "failed", objectKey: null }), row("x", 90, { expiredAt: now })];
    expect(selectExpired(rows, { keep: 1, keepDays: null }, now)).toEqual([]);
  });
  it("counts safety dumps with the schedule's, as automatic backups of the tier", () => {
    const rows = [row("pre", 0.1, { trigger: "pre_update" }), row("s1", 1), row("s2", 2)];
    expect(ids(selectExpired(rows, { keep: 2, keepDays: null }, now))).toEqual(["s2"]);
  });
  it("deletes failed rows after 30 days and flags retention decreases", () => {
    expect(failedRowsToDelete([row("f", 31, { status: "failed" }), row("g", 5, { status: "failed" })], now).map((r) => r.id)).toEqual(["f"]);
    expect(isRetentionDecrease({ keep: 7, keepDays: null, enabled: true }, { keep: 1, keepDays: null, enabled: true })).toBe(true);
    expect(isRetentionDecrease({ keep: 3, keepDays: 14, enabled: true }, { keep: 3, keepDays: null, enabled: true })).toBe(true);
    expect(isRetentionDecrease({ keep: 3, keepDays: 14, enabled: true }, { keep: 3, keepDays: 14, enabled: false })).toBe(true);
    expect(isRetentionDecrease({ keep: 1, keepDays: null, enabled: false }, { keep: 7, keepDays: null, enabled: true })).toBe(false);
  });
});

// ----------------------------------------------------------------------------------- envelope

describe("backup encryption", () => {
  const key = randomBytes(32);
  const id = "11111111-1111-4111-8111-111111111111";
  const encrypt = async (data: Buffer, k = key, backupId = id) => collect(Readable.from([data]).pipe(new EncryptStream(k, backupId)));
  const decrypt = async (blob: Buffer, k: Buffer | Map<string, Buffer> = key, backupId = id) => {
    const out: Buffer[] = [];
    await pipeline(Readable.from([blob]), new DecryptStream(k, backupId), new Writable({ write: (c, _e, cb) => (out.push(c as Buffer), cb()) }));
    return Buffer.concat(out);
  };

  it("round trips empty, small and multi-chunk payloads", async () => {
    for (const size of [0, 10, CHUNK_BYTES, CHUNK_BYTES * 3 + 7]) {
      const data = randomBytes(size);
      const blob = await encrypt(data);
      expect(blob.includes(data.subarray(0, Math.min(32, size))) && size >= 32).toBe(false);
      expect((await decrypt(blob)).equals(data)).toBe(true);
    }
  });
  it("records the key fingerprint in the header", async () => {
    const blob = await encrypt(Buffer.from("hello"));
    expect(peekFingerprint(blob)).toBe(backupKeyFingerprint(key));
  });
  it("detects truncation at a chunk boundary", async () => {
    const data = randomBytes(CHUNK_BYTES * 2 + 100);
    const blob = await encrypt(data);
    const header = 5 + 1 + 16 + 12 + 32 + 16 + 12;
    const cut = blob.subarray(0, header + 4 + CHUNK_BYTES + 16);
    await expect(decrypt(cut)).rejects.toThrow(/final chunk is missing/);
    await expect(decrypt(blob.subarray(0, blob.length - 3))).rejects.toThrow(EnvelopeError);
  });
  it("refuses tampering, another backup id and an unknown key", async () => {
    const blob = await encrypt(randomBytes(1000));
    const bad = Buffer.from(blob);
    bad[bad.length - 30] = bad[bad.length - 30]! ^ 1;
    await expect(decrypt(bad)).rejects.toThrow(/tampered/);
    await expect(decrypt(blob, key, "22222222-2222-4222-8222-222222222222")).rejects.toThrow(/another backup/);
    await expect(decrypt(blob, randomBytes(32))).rejects.toThrow(/not loaded/);
  });
  it("refuses data appended after the final chunk", async () => {
    const blob = await encrypt(Buffer.from("x"));
    const tail = blob.subarray(blob.length - 21);
    await expect(decrypt(Buffer.concat([blob, tail]))).rejects.toThrow(EnvelopeError);
  });
});

// -------------------------------------------------------------------------------------- store

describe("object stores", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("builds per-app keys and refuses path tricks", () => {
    const k = backupObjectKey("dockify/", { sourceAppId: "app1", backupId: "b1", createdAt: new Date("2026-10-30T01:02:03.456Z"), kind: "postgres" });
    expect(k).toBe("dockify/apps/app1/20261030T010203Z-b1.sql.gz.dkbk");
    for (const bad of ["../x", "a/../b", "/abs", "a//b", "a\\b"]) expect(() => assertKey(bad)).toThrow(StoreError);
  });

  it("signs path-style SigV4 requests deterministically", () => {
    const cfg = { endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto", bucket: "backups", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
    const now = new Date("2026-10-30T12:00:00Z");
    const a = signRequest(cfg, "GET", "dockify/apps/x/y.dkbk", "UNSIGNED-PAYLOAD", now);
    const b = signRequest(cfg, "GET", "dockify/apps/x/y.dkbk", "UNSIGNED-PAYLOAD", now);
    expect(a).toEqual(b);
    expect(a.url).toBe("https://acct.r2.cloudflarestorage.com/backups/dockify/apps/x/y.dkbk");
    expect(a.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261030\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(JSON.stringify(a)).not.toContain(cfg.secretAccessKey);
    expect(() => signRequest({ ...cfg, endpoint: "http://minio.local" }, "GET", "k", "x", now)).toThrow(/https/);
  });

  it("guards the endpoint at call time and refuses redirects", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFake = async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(null, { status: 200 }));
    const blocked = new S3Store({ endpoint: "https://s3.example.com", region: "us-east-1", bucket: "b", accessKeyId: "a", secretAccessKey: "s" }, { fetch: fetchFake, guard: async () => { throw new Error("private address"); } });
    await expect(blocked.delete("k")).rejects.toThrow(/private address/);
    expect(calls).toHaveLength(0);
    const ok = new S3Store({ endpoint: "https://s3.example.com", region: "us-east-1", bucket: "b", accessKeyId: "a", secretAccessKey: "s" }, { fetch: fetchFake, guard: async () => {} });
    await ok.delete("k");
    expect(calls[0]!.init.redirect).toBe("error");
    const notFound = new S3Store({ endpoint: "https://s3.example.com", region: "r", bucket: "b", accessKeyId: "a", secretAccessKey: "s" }, { fetch: async () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }), guard: async () => {} });
    await expect(notFound.get("k")).rejects.toThrow(/AccessDenied/);
  });

  it("stores locally under its root only, with atomic writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dk-local-"));
    dirs.push(root);
    const s = new LocalStore(root);
    const body = Buffer.from("ciphertext");
    await s.put("apps/a/b.dkbk", Readable.from([body]), body.length);
    expect((await collect(await s.get("apps/a/b.dkbk"))).toString()).toBe("ciphertext");
    await expect(s.put("apps/a/c.dkbk", Readable.from([body]), 99)).rejects.toThrow(/expected 99/);
    await expect(s.get("apps/a/c.dkbk")).rejects.toThrow(/missing/);
    await s.delete("apps/a/b.dkbk");
    await s.delete("apps/a/b.dkbk");
    expect(await s.probe()).toBeGreaterThanOrEqual(0);
  });
});

// ----------------------------------------------------------------------------------- services

describe("managed services", () => {
  const base: ServiceApp = { id: "0f0f0f0f-0000-4000-8000-000000000001", name: "db", kind: "postgres", environmentId: "0f0f0f0f-0000-4000-8000-0000000000e1", projectId: "p", cpuLimit: 1 };
  const image = `sha256:${"c".repeat(64)}`;
  for (const kind of ["postgres", "redis"] as const) {
    it(`${kind} goes through containerSpec with no published port, and its password is in neither argv nor env`, () => {
      const creds = generateCredentials(kind, "db");
      const spec = serviceSpec({ ...base, kind }, creds, { image });
      assertSafeSpec(spec);
      expect(spec.Image).toBe(image);
      expect(spec.HostConfig.PortBindings).toEqual({});
      expect(spec.HostConfig.PublishAllPorts).toBe(false);
      expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
      expect(spec.HostConfig.NetworkMode).toBe(`dockify-env-${base.environmentId}`);
      expect(spec.HostConfig.Mounts).toEqual([{ Type: "volume", Source: `dockify-data-${base.id}`, Target: kind === "postgres" ? "/var/lib/postgresql/data" : "/data", ReadOnly: false }]);
      expect(spec.NetworkingConfig.EndpointsConfig[spec.HostConfig.NetworkMode]?.Aliases).toEqual(["db"]);
      expect(JSON.stringify(spec)).not.toContain(creds.password);
      expect(spec.Labels["dockify.app"]).toBe(base.id);
      expect(spec.Labels["dockify.role"]).toBe(`service-${kind}`);
    });
  }
  it("Postgres reads its password from a file in its own volume, and keeps its data in pgdata unless told otherwise", () => {
    const spec = serviceSpec(base, generateCredentials("postgres", "db"), { image });
    expect(spec.Env).toEqual(expect.arrayContaining([
      "POSTGRES_USER=dockify", "POSTGRES_DB=db", "PGDATA=/var/lib/postgresql/data/pgdata",
      "POSTGRES_PASSWORD_FILE=/var/lib/postgresql/data/.dockify/postgres-password",
    ]));
    expect(spec.Env.some((e) => e.startsWith("POSTGRES_PASSWORD="))).toBe(false);
    // An adopted volume keeps its cluster at the root.
    expect(serviceSpec(base, generateCredentials("postgres", "db"), { image, pgdata: "/var/lib/postgresql/data" }).Env).toContain("PGDATA=/var/lib/postgresql/data");
  });
  it("Redis runs as its own user on a config file in its volume, healthy only while it demands the password", () => {
    const spec = serviceSpec({ ...base, kind: "redis" }, generateCredentials("redis", "db"), { image });
    expect(spec.User).toBe("redis");
    expect(spec.Cmd).toEqual(["redis-server", "/data/.dockify/redis.conf"]);
    expect(spec.Env).toEqual([]);
    expect(spec.Healthcheck?.Test).toEqual(["CMD-SHELL", "redis-cli ping 2>&1 | grep -q NOAUTH"]);
    expect(() => serviceSpec({ ...base, kind: "redis" }, generateCredentials("redis", "db"), { image, volume: null })).toThrow(/own volume/);
  });
  it("writes a Redis config with the password and snapshots, never the append-only file a restore would be ignored for", () => {
    const conf = redisConfig({ user: "default", password: "Pw_0123456789abcdef" });
    expect(conf.split("\n")).toEqual(expect.arrayContaining(["requirepass Pw_0123456789abcdef", "dir /data", "port 6379", "appendonly no", "save 900 1 300 10 60 10000", "protected-mode yes"]));
  });
  it("generates strong, distinct credentials and urls", () => {
    const a = generateCredentials("postgres", "my-db");
    const b = generateCredentials("postgres", "my-db");
    expect(a.password).not.toBe(b.password);
    expect(a.password.length).toBeGreaterThanOrEqual(32);
    expect(a.database).toBe("my_db");
    expect(connectionUrl("postgres", "my-db", { user: "u", password: "p@ss/w", database: "d" })).toBe("postgresql://u:p%40ss%2Fw@my-db:5432/d");
  });
  it("a restore test container has no volume, sits on the helper network and takes its throwaway password in env", () => {
    const creds = generateCredentials("postgres", "t");
    const spec = serviceSpec(base, creds, { name: "dockify-rt-x", volume: null, network: "dockify-helpers", image });
    expect(spec.HostConfig.Mounts).toEqual([]);
    expect(spec.HostConfig.NetworkMode).toBe("dockify-helpers");
    expect(spec.NetworkingConfig.EndpointsConfig["dockify-helpers"]?.Aliases).toEqual([]);
    expect(spec.Env).toContain(`POSTGRES_PASSWORD=${creds.password}`);
  });
  it("the engine port reports a container's mounts, so the managed deploy can find an anonymous data volume", () => {
    const s = toState({
      Id: "x", State: { Running: false }, Config: { Labels: null }, NetworkSettings: { Networks: {} },
      Mounts: [{ Type: "volume", Name: "f".repeat(64), Destination: "/data" }, { Type: "bind", Destination: "/etc/x" }],
    });
    expect(s.mounts).toEqual([{ type: "volume", name: "f".repeat(64), destination: "/data" }, { type: "bind", name: null, destination: "/etc/x" }]);
  });
  it("never gives a service an alias that starts with dk-, which could answer for a route target", () => {
    for (const name of ["dk-route-0f0f0f0f", "dk-anything"]) {
      let err: unknown;
      try {
        serviceSpec({ ...base, kind: "redis", name }, generateCredentials("redis", "x"), { image });
      } catch (e) {
        err = e;
      }
      expect((err as Error).message, name).toMatch(/starts with dk-, which Dockify keeps for its own containers and routes/);
      expect(isPermanentError(err)).toBe(true);
    }
    // A one-off under its own Dockify name takes no alias at all, so its app name never matters.
    const rt = serviceSpec({ ...base, name: "dk-legacy" }, generateCredentials("postgres", "t"), { name: "dockify-rt-x", volume: null, network: "dockify-helpers", image });
    expect(rt.NetworkingConfig.EndpointsConfig["dockify-helpers"]?.Aliases).toEqual([]);
    // Every alias a service does get is its own name, never a dk- one.
    expect(serviceSpec(base, generateCredentials("postgres", "db"), { image }).NetworkingConfig.EndpointsConfig[`dockify-env-${base.environmentId}`]?.Aliases).toEqual(["db"]);
  });
  it("never provisions Storage, permanently", async () => {
    const docker = {} as DockerPort;
    let err: unknown;
    try {
      await provisionService(docker, { ...base, kind: "s3" }, generateCredentials("s3", "x"), { name: "dockify-rt-x", image, volume: "dk-rt-x" });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toBe(STORAGE_UNAVAILABLE);
    expect(isPermanentError(err)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------- dumps

describe("dump commands and restore framing", () => {
  const c = { user: "dockify", password: "s3cret", database: "app" };
  it("keeps passwords off argv", () => {
    for (const cmd of [pgDumpCommand(c), psqlCommand(c), redisDumpCommand(c)]) {
      expect(cmd.cmd.join(" ")).not.toContain("s3cret");
      expect(Object.values(cmd.env)).toContain("s3cret");
    }
    expect(psqlCommand(c).cmd).not.toContain("--single-transaction");
  });
  it("writes COMMIT only after the source ended cleanly", async () => {
    const out = await collect(Readable.from([Buffer.from("CREATE TABLE t();\n")]).pipe(new RestoreFramer({ replace: true })));
    expect(out.toString()).toBe(`${TERMINATE_OTHERS_SQL}${RESTORE_PREAMBLE}${REPLACE_SCHEMAS_SQL}CREATE TABLE t();\n${RESTORE_COMMIT}`);
  });
  it("empties the database only when replacing, inside the transaction, never the system schemas", async () => {
    const fresh = await collect(Readable.from([Buffer.from("X;\n")]).pipe(new RestoreFramer()));
    expect(fresh.toString()).toBe(`${RESTORE_PREAMBLE}X;\n${RESTORE_COMMIT}`);
    expect(REPLACE_SCHEMAS_SQL).toContain("nspname <> 'information_schema' AND nspname NOT LIKE 'pg\\_%'");
    expect(REPLACE_SCHEMAS_SQL).toContain("CREATE SCHEMA public;");
  });
  it("the Redis swap fails on a refused CONFIG SET or a failed move, and puts saving back", () => {
    const sh = redisSwapCommand(c).cmd[2]!;
    expect(sh).toContain('[ "$(redis-cli CONFIG SET save "")" = OK ]');
    expect(sh).toMatch(/\|\| \{ redis-cli CONFIG SET save "\$prev" >\/dev\/null; exit 1; \}$/);
    expect(sh).not.toContain("SHUTDOWN");
  });
  it("never writes COMMIT when the source fails", async () => {
    const got: string[] = [];
    const failing = new Readable({ read() {} });
    const sink = new Writable({ write: (ch, _e, cb) => (got.push(String(ch)), cb()) });
    const p = pipeline(failing, new RestoreFramer(), sink);
    failing.push("INSERT 1;\n");
    failing.destroy(new Error("download cut"));
    await expect(p).rejects.toThrow(/download cut/);
    expect(got.join("")).not.toContain("COMMIT");
  });
  it("parses the restore check", () => {
    expect(parseRestoreCheck(" 12,3400\n")).toEqual({ tables: 12, rows: 3400 });
    expect(() => parseRestoreCheck("ERROR")).toThrow();
  });
});

// ---------------------------------------------------------------------------------- tar guard

function tarEntry(name: string, type: string, body = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.fill(" ", 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(pad);
  return Buffer.concat([h, pad]);
}
const tarOf = (...entries: Buffer[]) => Buffer.concat([...entries, Buffer.alloc(1024)]);
const guard = async (tar: Buffer) => {
  const g = new TarGuard();
  await pipeline(Readable.from([tar]), g);
  return g.summary;
};

describe("tar guard", () => {
  it("accepts files and directories inside the root", async () => {
    expect(await guard(tarOf(tarEntry("./", "5"), tarEntry("./bucket/", "5"), tarEntry("./bucket/obj", "0", Buffer.from("data"))))).toEqual({ files: 1, dirs: 2, bytes: 4 });
  });
  it("refuses escapes, absolute paths and links", async () => {
    await expect(guard(tarOf(tarEntry("../etc/passwd", "0")))).rejects.toThrow(TarGuardError);
    await expect(guard(tarOf(tarEntry("a/../../x", "0")))).rejects.toThrow(/leaves the volume/);
    await expect(guard(tarOf(tarEntry("/etc/passwd", "0")))).rejects.toThrow(/relative/);
    await expect(guard(tarOf(tarEntry("link", "2")))).rejects.toThrow(/symlink/);
    await expect(guard(tarOf(tarEntry("hard", "1")))).rejects.toThrow(/hard link/);
  });
  it("checks GNU long names too", async () => {
    const long = Buffer.from("../" + "a".repeat(150) + "\0");
    await expect(guard(tarOf(tarEntry("././@LongLink", "L", long), tarEntry("short", "0")))).rejects.toThrow(/leaves the volume/);
  });
  it("refuses a truncated archive", async () => {
    const t = tarEntry("f", "0", Buffer.alloc(2000));
    await expect(guard(t.subarray(0, 1000))).rejects.toThrow(/truncated/);
  });
});

// --------------------------------------------------------------------------------- sql guard

describe("read-only SQL guard", () => {
  it("allows plain queries and marks cursorable ones", () => {
    expect(guardReadOnlySql("SELECT 1;")).toEqual({ text: "SELECT 1", cursor: true });
    // A quoted name in call position is the same function; a column of that name is not a call.
    for (const q of ['SELECT "pg_sleep"(30)', 'SELECT pg_catalog."pg_sleep"(30)', 'SELECT "pg_catalog"."pg_sleep" /* x */ (30)', 'SELECT "PG_SLEEP" (30)', 'SELECT U&"pg\\005fsleep"(1)', 'SELECT u&"x"(1)']) {
      expect(() => guardReadOnlySql(q), q).toThrow(SqlGuardError);
    }
    expect(guardReadOnlySql('SELECT "pg_sleep" FROM t').text).toBe('SELECT "pg_sleep" FROM t');
    expect(guardReadOnlySql(`SELECT '"pg_sleep"(1)', "into", my_fn("a") FROM "select"`).cursor).toBe(true);
    expect(guardReadOnlySql('SELECT "my_fn"(1)').cursor).toBe(true);
    expect(guardReadOnlySql("with x as (select 1) select * from x").cursor).toBe(true);
    expect(guardReadOnlySql("EXPLAIN SELECT 1").cursor).toBe(false);
    expect(guardReadOnlySql("show search_path").cursor).toBe(false);
  });
  it("ignores semicolons and keywords inside strings, comments and quotes", () => {
    expect(() => guardReadOnlySql("SELECT 'a;b', \"we;ird\", $$x;y$$, $t$ ; $t$ -- ; drop\n")).not.toThrow();
    expect(() => guardReadOnlySql("SELECT 'pg_sleep(1)'")).not.toThrow();
    expect(maskSql("a /* b /* c */ d */ e")).toBe("a                   e");
  });
  it("refuses multiple statements and non queries", () => {
    expect(() => guardReadOnlySql("SELECT 1; DROP TABLE x")).toThrow(/One statement/);
    for (const s of ["COMMIT", "SET ROLE postgres", "RESET ROLE", "DELETE FROM t", "COPY t TO PROGRAM 'x'", "DO $$ begin end $$", "BEGIN READ WRITE", "CALL p()"]) {
      expect(() => guardReadOnlySql(s), s).toThrow(SqlGuardError);
    }
  });
  it("refuses server-side functions and SELECT INTO", () => {
    expect(() => guardReadOnlySql("select set_config('role','postgres',true)")).toThrow(/set_config/);
    expect(() => guardReadOnlySql("SELECT pg_terminate_backend(123)")).toThrow(/pg_terminate_backend/);
    expect(() => guardReadOnlySql("select PG_READ_FILE ('/etc/passwd')")).toThrow(SqlGuardError);
    expect(() => guardReadOnlySql("SELECT * INTO t2 FROM t")).toThrow(/SELECT INTO/);
  });
  it("refuses unterminated literals", () => {
    expect(() => guardReadOnlySql("SELECT 'oops")).toThrow(/Unterminated/);
  });
  it("quotes qualified names", () => {
    expect(quoteQualified("public.Users").sql).toBe('"public"."Users"');
  });
});

// --------------------------------------------------------------------------------------- resp

describe("RESP", () => {
  it("encodes commands as bulk arrays", () => {
    expect(encodeCommand(["SCAN", "0"]).toString()).toBe("*2\r\n$4\r\nSCAN\r\n$1\r\n0\r\n");
  });
  it("parses every reply type and waits for complete frames", () => {
    expect(parseReply(Buffer.from("+OK\r\n"))?.value).toBe("OK");
    expect(parseReply(Buffer.from(":42\r\n"))?.value).toBe(42);
    expect(parseReply(Buffer.from("$-1\r\n"))?.value).toBe(null);
    expect(parseReply(Buffer.from("-NOAUTH x\r\n"))?.value).toBeInstanceOf(RespError);
    expect(parseReply(Buffer.from("*2\r\n$1\r\n0\r\n*1\r\n$3\r\nkey\r\n"))?.value).toEqual(["0", ["key"]]);
    expect(parseReply(Buffer.from("$5\r\nab"))).toBeNull();
    expect(() => parseReply(Buffer.from("$999999999\r\n"))).toThrow(/too large/);
  });
});
