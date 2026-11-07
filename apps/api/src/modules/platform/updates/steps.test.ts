import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { VerifiedFeed } from "./release.ts";
import { release } from "./test-fixtures.ts";
import { run, RESTORE_SCRIPT, checkComposeMatchesRelease, checkInstallTree, dockerSteps, dumpPath, installPaths, loadStepsConfig, parseReleaseEnv, renderReleaseEnv, sha256Hex, type ControlProbe, type GuardFs, type StepsConfig } from "./steps.ts";

const DIR = "/opt/dockify";
const P = installPaths(DIR);
const COMPOSE = Buffer.from("services: {}\n");
const IMAGES = { control: "r/control@sha256:" + "1".repeat(64), web: "r/web@sha256:" + "2".repeat(64) };

interface Entry { uid: number; mode: number; link?: boolean; body?: Buffer }

/** A fake host tree laid out the way install.sh lays it out. */
function tree(over: Partial<Record<string, Partial<Entry>>> = {}): GuardFs {
  const base: Record<string, Entry> = {
    [P.dir]: { uid: 0, mode: 0o40750 },
    [P.compose]: { uid: 0, mode: 0o100640, body: COMPOSE },
    [P.env]: { uid: 0, mode: 0o100640, body: Buffer.from(`DOCKIFY_DIR=${DIR}\nDOCKIFY_COMPOSE_SHA256=${sha256Hex(COMPOSE)}\n`) },
    [P.releaseEnv]: { uid: 1000, mode: 0o100600, body: Buffer.from(renderReleaseEnv(IMAGES)) },
  };
  for (const [k, v] of Object.entries(over)) base[k] = { ...base[k]!, ...v };
  const get = (p: string) => {
    const e = base[p];
    if (!e) throw new Error(`ENOENT ${p}`);
    return e;
  };
  return {
    lstat: async (p) => { const e = get(p); return { uid: e.uid, mode: e.mode, isSymbolicLink: () => !!e.link }; },
    readFile: async (p) => get(p).body ?? Buffer.alloc(0),
  };
}

describe("checkInstallTree (updater refuses a tree a non-root user can change)", () => {
  it("accepts the installer's layout and returns the compose hash", async () => {
    await expect(checkInstallTree(DIR, tree())).resolves.toBe(sha256Hex(COMPOSE));
  });

  it("refuses a compose file, .env or folder owned by uid 1000", async () => {
    for (const p of [P.compose, P.env, P.dir]) {
      await expect(checkInstallTree(DIR, tree({ [p]: { uid: 1000 } }))).rejects.toThrow(/must be owned by root/);
    }
  });

  it("refuses group or world writable entries", async () => {
    await expect(checkInstallTree(DIR, tree({ [P.compose]: { mode: 0o100660 } }))).rejects.toThrow(/writable by group or others/);
    await expect(checkInstallTree(DIR, tree({ [P.env]: { mode: 0o100642 } }))).rejects.toThrow(/writable by group or others/);
    await expect(checkInstallTree(DIR, tree({ [P.dir]: { mode: 0o40770 } }))).rejects.toThrow(/writable by group or others/);
  });

  it("refuses symlinks", async () => {
    await expect(checkInstallTree(DIR, tree({ [P.compose]: { link: true } }))).rejects.toThrow(/symlink/);
    await expect(checkInstallTree(DIR, tree({ [P.releaseEnv]: { link: true } }))).rejects.toThrow(/symlink/);
  });

  it("refuses a compose file that no longer matches the hash pinned in .env", async () => {
    const evil = Buffer.from("services: { pwn: { image: alpine, privileged: true, volumes: ['/:/host'] } }\n");
    await expect(checkInstallTree(DIR, tree({ [P.compose]: { body: evil } }))).rejects.toThrow(/does not match the hash pinned/);
  });

  it("refuses an .env without the pin", async () => {
    await expect(checkInstallTree(DIR, tree({ [P.env]: { body: Buffer.from("DOCKIFY_DIR=/opt/dockify\n") } }))).rejects.toThrow(/does not pin/);
  });

  it("refuses a release.env that overrides other variables", async () => {
    const body = Buffer.from(renderReleaseEnv(IMAGES) + "DOCKIFY_DIR=/\n");
    await expect(checkInstallTree(DIR, tree({ [P.releaseEnv]: { body } }))).rejects.toThrow(/may only pin/);
  });
});

describe("parseReleaseEnv is strict", () => {
  it("rejects extra keys, tags, duplicates and interpolation", () => {
    const ok = renderReleaseEnv(IMAGES);
    expect(parseReleaseEnv(ok)).toEqual(IMAGES);
    expect(() => parseReleaseEnv(ok + "COMPOSE_PROFILES=evil\n")).toThrow();
    expect(() => parseReleaseEnv(`DOCKIFY_CONTROL_IMAGE=r/control:latest\nDOCKIFY_WEB_IMAGE=${IMAGES.web}\n`)).toThrow();
    expect(() => parseReleaseEnv(ok + `DOCKIFY_WEB_IMAGE=${IMAGES.web}\n`)).toThrow();
    expect(() => parseReleaseEnv(`DOCKIFY_CONTROL_IMAGE=\${X}@sha256:${"1".repeat(64)}\nDOCKIFY_WEB_IMAGE=${IMAGES.web}\n`)).toThrow();
  });
});

describe("compose hash against the signed manifest", () => {
  it("refuses a release whose composeSha256 differs from the file on disk", () => {
    expect(() => checkComposeMatchesRelease("a".repeat(64), { composeSha256: "b".repeat(64) })).toThrow(/different docker-compose.yml/);
    expect(() => checkComposeMatchesRelease("a".repeat(64), { composeSha256: "a".repeat(64) })).not.toThrow();
    expect(() => checkComposeMatchesRelease("a".repeat(64), {})).not.toThrow();
  });

  it("resolve() checks the tree before fetching, then the feed hash, then the release's compose hash", async () => {
    const feed = (composeSha256?: string): VerifiedFeed => ({
      schema: 2, channel: "stable", generatedAt: "2026-10-01T00:00:00Z", sha256: "m".repeat(64),
      releases: [release("1.2.3", composeSha256 ? { composeSha256 } : {})],
    });
    let fetched = 0;
    const tampered = dockerSteps(CFG, { ...DEPS, fs: tree({ [P.compose]: { uid: 1000 } }), fetchFeed: async () => { fetched++; return feed(); } });
    await expect(tampered.resolve("1.2.3", "m".repeat(64))).rejects.toThrow(/owned by root/);
    expect(fetched).toBe(0);

    const changed = dockerSteps(CFG, { ...DEPS, fs: tree(), fetchFeed: async () => feed() });
    await expect(changed.resolve("1.2.3", "x".repeat(64))).rejects.toThrow(/changed since this update was approved/);

    const drift = dockerSteps(CFG, { ...DEPS, fs: tree(), fetchFeed: async () => feed("f".repeat(64)) });
    await expect(drift.resolve("1.2.3", "m".repeat(64))).rejects.toThrow(/different docker-compose.yml/);

    const good = dockerSteps(CFG, { ...DEPS, fs: tree(), fetchFeed: async () => feed(sha256Hex(COMPOSE)), arch: "arm64" });
    await expect(good.resolve("1.2.3", "m".repeat(64))).resolves.toEqual({ control: release("1.2.3").images.control.arm64, web: release("1.2.3").images.web.arm64 });
    await expect(good.resolve("9.9.9", "m".repeat(64))).rejects.toThrow(/no longer lists/);

    // A row that names an OLDER signed version is refused as a downgrade, measured against the
    // running image's version, not the row's own fromVersion.
    const older = dockerSteps({ ...CFG, currentVersion: "2.0.0" }, { ...DEPS, fs: tree(), fetchFeed: async () => feed(sha256Hex(COMPOSE)), arch: "arm64" });
    await expect(older.resolve("1.2.3", "m".repeat(64))).rejects.toThrow(/downgrade/);

    const unconfigured = dockerSteps({ ...CFG, feedUrl: "" }, { ...DEPS, fs: tree() });
    await expect(unconfigured.resolve("1.2.3", "m".repeat(64))).rejects.toThrow(/not configured/);
  });
});

const CFG: StepsConfig = { composeDir: DIR, backupDir: "/b", readyzUrl: "http://api/readyz", healthTimeoutS: 1, feedUrl: "https://f", publicKey: "k", minFreeBytes: 1024, currentVersion: "1.0.0" };
const probe = (over: Partial<ControlProbe> = {}): ControlProbe => ({
  databaseOk: async () => true, databaseBytes: async () => 1000, busy: async () => null, workerSeenAt: async () => new Date(), ...over,
});
const DEPS = { probe: probe(), channel: async () => "stable" as const, sleep: async () => undefined };

describe("a forged row cannot pin an older signed release", () => {
  const feed = async (): Promise<VerifiedFeed> => ({ schema: 2, channel: "stable", generatedAt: "2026-10-01T00:00:00Z", sha256: "m".repeat(64), releases: [release("1.2.3")] });
  const images = { control: release("1.2.3").images.control.arm64, web: release("1.2.3").images.web.arm64 };
  const ran: string[][] = [];
  const exec = (async (_cmd: string, args: string[]) => {
    ran.push(args);
    return args[0] === "image" ? JSON.stringify([args.at(-1)]) : "";
  }) as never;

  it("a row that starts past the pull step meets the downgrade rule: the feed vouches only for a newer release", async () => {
    ran.length = 0;
    const older = dockerSteps({ ...CFG, currentVersion: "2.0.0" }, { ...DEPS, fs: tree(), fetchFeed: feed, arch: "arm64", run: exec });
    await expect(older.pull(images)).rejects.toThrow(/neither pinned on this server nor in the signed release feed/);
    expect(ran).toEqual([]);
  });

  it("a newer release in the feed still pulls", async () => {
    ran.length = 0;
    const newer = dockerSteps({ ...CFG, currentVersion: "1.0.0" }, { ...DEPS, fs: tree(), fetchFeed: feed, arch: "arm64", run: exec });
    await expect(newer.pull(images)).resolves.toBeUndefined();
    expect(ran.length).toBeGreaterThan(0);
  });

  it("what is pinned here still runs, whatever its version: a real rollback is release.env.prev", async () => {
    const pinned = dockerSteps({ ...CFG, currentVersion: "2.0.0" }, { ...DEPS, fs: tree(), fetchFeed: feed, arch: "arm64", run: exec });
    await expect(pinned.pull(IMAGES)).resolves.toBeUndefined();
  });

  it("the version it measures from is the image's own, which compose does not set", () => {
    expect(loadStepsConfig({ DOCKIFY_VERSION: "1.0.0", DOCKIFY_IMAGE_VERSION: "2.0.0" }, null).currentVersion).toBe("2.0.0");
    expect(loadStepsConfig({ DOCKIFY_VERSION: "1.0.0" }, null).currentVersion).toBe("1.0.0");
  });
});

describe("preflight", () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), "dk-pre-"));
  it("waits while a deploy or restore runs, or while the database does not answer", async () => {
    const b = dir();
    const busy = dockerSteps({ ...CFG, backupDir: b }, { ...DEPS, fs: tree(), probe: probe({ busy: async () => "a restore" }) });
    await expect(busy.preflight()).resolves.toEqual({ ok: false, wait: true, reason: "a restore is in flight" });
    const down = dockerSteps({ ...CFG, backupDir: b }, { ...DEPS, fs: tree(), probe: probe({ databaseOk: async () => { throw new Error("ECONNREFUSED"); } }) });
    await expect(down.preflight()).resolves.toMatchObject({ ok: false, wait: true });
    rmSync(b, { recursive: true, force: true });
  });

  it("refuses without waiting when the disk cannot hold the dump and the images", async () => {
    const b = dir();
    const tight = dockerSteps({ ...CFG, backupDir: b }, { ...DEPS, fs: tree(), freeBytes: async () => 2000 });
    await expect(tight.preflight()).resolves.toMatchObject({ ok: false, wait: false, reason: expect.stringMatching(/not enough free disk/) });
    const roomy = dockerSteps({ ...CFG, backupDir: b }, { ...DEPS, fs: tree(), freeBytes: async () => 10 ** 9 });
    await expect(roomy.preflight()).resolves.toEqual({ ok: true });
    rmSync(b, { recursive: true, force: true });
  });
});

describe("pull and restore verify what they touch", () => {
  it("refuses a pulled image that does not carry the signed digest", async () => {
    const want = IMAGES.control.slice(IMAGES.control.indexOf("@") + 1);
    const ran: string[][] = [];
    const steps = (digests: string[]) => dockerSteps(CFG, { ...DEPS, fs: tree(), run: async (_c, args) => (ran.push(args), args[0] === "image" ? JSON.stringify(digests) : "") });
    await expect(steps([`r/control@${want}`, `r/web@${IMAGES.web.slice(IMAGES.web.indexOf("@") + 1)}`]).pull(IMAGES)).resolves.toBeUndefined();
    await expect(steps(["r/control@sha256:" + "9".repeat(64)]).pull(IMAGES)).rejects.toThrow(/does not carry/);
    expect(ran[0]).toEqual(["pull", "--quiet", IMAGES.control]);
  });

  it("refuses to restore a dump whose sha256 differs from the one recorded", async () => {
    const b = mkdtempSync(path.join(tmpdir(), "dk-dump-"));
    mkdirSync(path.join(b, "control"));
    const id = "11111111-1111-4111-8111-111111111111";
    writeFileSync(dumpPath(b, id), "PGDMP not really");
    const ran: string[][] = [];
    const steps = dockerSteps({ ...CFG, backupDir: b }, { ...DEPS, fs: tree(), run: async (_c, args) => (ran.push(args), "") });
    await expect(steps.restoreDump({ id, sha256: "0".repeat(64) })).rejects.toThrow(/does not match its recorded sha256/);
    expect(ran).toHaveLength(0);
    await steps.restoreDump({ id, sha256: sha256Hex(Buffer.from("PGDMP not really")) });
    // The impostor check comes first, then the exec into the real service.
    expect(ran[0]?.[0]).toBe("ps");
    expect(ran[1]).toContain("postgres");
    // As the image's own user, and exec's flag sits before the service's name.
    const exec = ran[1]!.slice(ran[1]!.indexOf("exec"));
    expect(exec.slice(0, 7)).toEqual(["exec", "-T", "-u", "postgres", "postgres", "sh", "-c"]);
    rmSync(b, { recursive: true, force: true });
  });

  it("dumps and lists a dump as the postgres user, never as root in the container", async () => {
    const b = mkdtempSync(path.join(tmpdir(), "dk-dump-"));
    const ran: string[][] = [];
    const steps = dockerSteps({ ...CFG, backupDir: b }, {
      ...DEPS, fs: tree(),
      run: async (_c, args, opts) => {
        ran.push(args);
        if (opts?.stdoutFile) writeFileSync(opts.stdoutFile, "PGDMP".padEnd(100, "x"));
        return "";
      },
    });
    await steps.dump("1.0.0");
    const execs = ran.filter((a) => a.includes("exec")).map((a) => a.slice(a.indexOf("exec")));
    expect(execs.map((a) => a.slice(0, 6))).toEqual([
      ["exec", "-T", "-u", "postgres", "postgres", "pg_dump"],
      ["exec", "-T", "-u", "postgres", "postgres", "pg_restore"],
    ]);
    rmSync(b, { recursive: true, force: true });
  });

  it("swaps one service at a time and waits for that service's own health signal", async () => {
    const ran: string[][] = [];
    let beat = new Date(0);
    const steps = dockerSteps(CFG, {
      ...DEPS, fs: tree(),
      run: async (_c, args) => {
        ran.push(args);
        if (args.includes("up") && args.at(-1) === "worker") beat = new Date();
        return args[0] === "compose" && args.includes("ps") ? JSON.stringify({ State: "running", Health: "healthy" }) : "";
      },
      getStatus: async () => 200,
      probe: probe({ workerSeenAt: async () => beat }),
    });
    const since = new Date(Date.now() - 1000);
    for (const s of ["api", "worker", "web"] as const) await steps.swap(s, since);
    const ups = ran.filter((a) => a.includes("up")).map((a) => a.at(-1));
    // The agent runs the worker's image, so it moves with the worker, just ahead of it.
    expect(ups).toEqual(["api", "agent", "worker", "web"]);
    expect(ran.find((a) => a.includes("up"))).toEqual(expect.arrayContaining(["--no-deps", "--wait"]));
    await expect(steps.healthy(since)).resolves.toBeNull();
    const stale = dockerSteps(CFG, { ...DEPS, fs: tree(), run: async () => "", getStatus: async () => 200, probe: probe({ workerSeenAt: async () => new Date(0) }) });
    await expect(stale.healthy(since)).resolves.toMatch(/heartbeat/);
  });
});

describe("run, with a reader that stops early", () => {
  const big = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dk-run-"));
    const file = path.join(dir, "dump");
    await writeFile(file, Buffer.alloc(8 * 1024 * 1024, 1));
    return file;
  };
  const node = process.execPath;

  it("is not a crash: the exit code decides (a pg_restore --list of a dump larger than the pipe)", async () => {
    await expect(run(node, ["-e", "process.stdin.once('data',()=>process.exit(0))"], { stdinFile: await big() })).resolves.toBe("");
  });
  it("still fails when the reader failed", async () => {
    await expect(run(node, ["-e", "process.stdin.once('data',()=>process.exit(3))"], { stdinFile: await big() })).rejects.toThrow(/exited 3/);
  });
  it("still fails when the file cannot be read", async () => {
    await expect(run(node, ["-e", "process.stdin.resume()"], { stdinFile: path.join(tmpdir(), "dk-no-such-file") })).rejects.toThrow(/ENOENT/);
  });
});

describe("run", () => {
  it("a hung command is ended and reported as timed out", async () => {
    await expect(run(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 300 })).rejects.toThrow(/timed out after 0 s/);
  });
});

describe("RESTORE_SCRIPT", () => {
  it("does not depend on a fixed file: a root-owned leftover at the old name cannot block a restore as postgres", () => {
    expect(RESTORE_SCRIPT).toContain("f=$(mktemp /tmp/dockify-restore.XXXXXX)");
    expect(RESTORE_SCRIPT).not.toContain("f=/tmp/dockify-restore.dump");
    expect(RESTORE_SCRIPT.trim().endsWith('rm -f "$f"')).toBe(true);
  });
  it("settles the update jobs in the restored dump as its last statement, so a rollback cannot be undone by its own update", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dk-restore-"));
    const seen = path.join(dir, "sql");
    await writeFile(path.join(dir, "pg_restore"), "#!/bin/sh\necho 'THE DUMP;'\n", { mode: 0o755 });
    await writeFile(path.join(dir, "psql"), `#!/bin/sh\ncat > '${seen.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)}'\n`, { mode: 0o755 });
    const bash = process.env.DOCKIFY_TEST_BASH ?? (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");
    const fakes = dir.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);
    await run(bash, ["-c", `export PATH='${fakes}':"$PATH"; ${RESTORE_SCRIPT}`], { stdinFile: await (async () => { const f = path.join(dir, "in"); await writeFile(f, "x"); return f; })() });
    const lines = (await readFile(seen, "utf8")).trim().split("\n");
    expect(lines[0]).toContain("DROP SCHEMA");
    expect(lines[1]).toBe("THE DUMP;");
    expect(lines[2]).toBe(`UPDATE public.jobs SET "completedAt" = now(), "lockedUntil" = NULL WHERE lane::text = $$update$$ AND "completedAt" IS NULL AND "failedAt" IS NULL;`);
  });
});
