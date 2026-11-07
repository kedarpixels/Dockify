/**
 * Regressions from a security review: the updater's
 * trust in database rows, tenant containers posing as Compose services, the login ceiling, the
 * installer's checkout path, the watchdog, service names, and a misleading validation error.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { backups, projects, resources } from "@dockify/contracts";
import { hash as argonHash } from "@node-rs/argon2";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { requestLogFields, type Ctx } from "./app.ts";
import { HttpError, zodFields } from "./errors.ts";
import { composeToSpecs } from "./modules/projects/compose.ts";
import { secondFor } from "./modules/integrations/webhooks.ts";
import type { VerifiedFeed } from "./modules/platform/updates/release.ts";
import { runUpdate, plannedSteps, type Journal, type UpdateRecorder, type UpdateSteps } from "./modules/platform/updates/runner.ts";
import { dockerSteps, installPaths, renderReleaseEnv, sha256Hex, type ControlProbe, type GuardFs, type Runner, type StepsConfig } from "./modules/platform/updates/steps.ts";
import { release } from "./modules/platform/updates/test-fixtures.ts";
import { COOLDOWN_MS, decide, dockerWatchdog, GRACE_MS, parseComposePs } from "./modules/platform/updates/watchdog.ts";
import { LOGIN_RESET_TRUST_MS, LoginGuard, RateLimits } from "./ratelimit.ts";
import { authHandlers } from "./routes/auth.ts";
import { testConfig, testRing } from "./test-helpers.ts";

const DIR = "/opt/dockify";
const P = installPaths(DIR);
const COMPOSE = Buffer.from("services: {}\n");
const ref = (name: string, c: string) => `r/${name}@sha256:${c.repeat(64)}`;
const CURRENT = { control: ref("control", "1"), web: ref("web", "2") };
const PREV = { control: ref("control", "3"), web: ref("web", "4") };
const EVIL = { control: ref("evil", "e"), web: ref("evil", "f") };

function tree(prev: string | null = renderReleaseEnv(PREV)): GuardFs {
  const files: Record<string, { uid: number; mode: number; body: Buffer }> = {
    [P.dir]: { uid: 0, mode: 0o40750, body: Buffer.alloc(0) },
    [P.compose]: { uid: 0, mode: 0o100640, body: COMPOSE },
    [P.env]: { uid: 0, mode: 0o100640, body: Buffer.from(`DOCKIFY_COMPOSE_SHA256=${sha256Hex(COMPOSE)}\n`) },
    [P.releaseEnv]: { uid: 1000, mode: 0o100600, body: Buffer.from(renderReleaseEnv(CURRENT)) },
  };
  if (prev) files[`${P.releaseEnv}.prev`] = { uid: 1000, mode: 0o100600, body: Buffer.from(prev) };
  const get = (p: string) => {
    const f = files[p];
    if (!f) throw new Error(`ENOENT ${p}`);
    return f;
  };
  return {
    lstat: async (p) => ({ uid: get(p).uid, mode: get(p).mode, isSymbolicLink: () => false }),
    readFile: async (p) => get(p).body,
  };
}

const CFG: StepsConfig = { composeDir: DIR, backupDir: "/b", readyzUrl: "http://x/", healthTimeoutS: 1, feedUrl: "https://feed.example", publicKey: "k", minFreeBytes: 0, currentVersion: "1.0.0" };
const probe: ControlProbe = { databaseOk: async () => true, databaseBytes: async () => 0, busy: async () => null, workerSeenAt: async () => null };
const noDocker: Runner = async (cmd, args) => {
  if (cmd === "docker" && args[0] === "image") return JSON.stringify([args.at(-1)]);
  return "";
};
const feedListing = (images: { control: string; web: string }): VerifiedFeed => {
  const rel = release("1.5.0") as unknown as { images: { control: Record<string, string>; web: Record<string, string> } };
  rel.images = { control: { amd64: images.control, arm64: images.control }, web: { amd64: images.web, arm64: images.web } };
  return { channel: "stable", sha256: "s".repeat(64), generatedAt: "2026-11-01T00:00:00Z", releases: [rel] } as unknown as VerifiedFeed;
};
const steps = (o: { feed?: VerifiedFeed | Error; fs?: GuardFs; exec?: Runner; cfg?: Partial<StepsConfig> } = {}) =>
  dockerSteps({ ...CFG, ...o.cfg }, {
    probe, channel: async () => "stable", arch: "x64", fs: o.fs ?? tree(), run: o.exec ?? noDocker, sleep: async () => undefined,
    fetchFeed: async () => {
      if (o.feed instanceof Error) throw o.feed;
      return o.feed ?? feedListing(CURRENT);
    },
  });

describe("the updater takes no image on a database row's word", () => {
  it("refuses to pull, migrate to or pin images that are neither pinned here nor signed", async () => {
    const s = steps();
    await expect(s.pull(EVIL)).rejects.toThrow(/refusing to run them/);
    await expect(s.migrate(EVIL)).rejects.toThrow(/refusing to run them/);
    await expect(s.pin(EVIL)).rejects.toThrow(/refusing to run them/);
  });

  it("with the feed out of reach, accepts only what the updater itself wrote before", async () => {
    const s = steps({ feed: new Error("offline") });
    await expect(s.pull(PREV)).resolves.toBeUndefined();
    await expect(s.pull(CURRENT)).resolves.toBeUndefined();
    await expect(s.pull(EVIL)).rejects.toThrow(/offline/);
  });

  it("accepts images the freshly verified feed lists for this architecture", async () => {
    const signed = { control: ref("control", "7"), web: ref("web", "8") };
    await expect(steps({ feed: feedListing(signed) }).pull(signed)).resolves.toBeUndefined();
  });

  it("with no feed configured, refuses anything not already pinned", async () => {
    const s = steps({ cfg: { feedUrl: "" } });
    await expect(s.pull(EVIL)).rejects.toThrow(/no signed release feed/);
    await expect(s.pull(PREV)).resolves.toBeUndefined();
  });

  it("a forged fromImages on the row is replaced by release.env at the pull step", async () => {
    const journal: Journal = {
      id: "u", kind: "update", fromVersion: "1.0.0", version: "1.5.0", manifestSha256: "m", fromImages: EVIL, toImages: null, phase: "preflight", state: "running",
      dumpBackupId: null, dumpSha256: null, dumpBytes: null, migrationStarted: false, rollbackOfId: null, steps: plannedSteps(), attempt: 1, error: null, startedAt: new Date(), finishedAt: null,
    };
    const fake: UpdateSteps = {
      preflight: async () => ({ ok: true }), resolve: async () => PREV, currentImages: async () => CURRENT, pull: async () => { throw new Error("stop here"); },
      quiesce: async () => {}, dump: async () => ({ id: "d", sha256: "s", bytes: 1 }), migrate: async () => {}, pin: async () => {}, swap: async () => {}, healthy: async () => null, restoreDump: async () => {},
    };
    const rec: UpdateRecorder = { save: async () => {}, audit: async () => {}, beforeRestore: async () => {}, afterRestore: async () => {}, finish: async () => {}, log: () => {}, now: () => new Date() };
    await runUpdate(journal, fake, rec);
    expect(journal.fromImages).toEqual(CURRENT);
  });
});

describe("compose runs refuse while a tenant container poses as a service", () => {
  it("names the impostors and runs nothing", async () => {
    const seen: string[][] = [];
    const exec: Runner = async (cmd, args) => {
      seen.push([cmd, ...args]);
      return args[0] === "ps" ? "abc123\n" : "";
    };
    await expect(steps({ exec }).quiesce()).rejects.toThrow(/abc123.*Docker Compose's labels/);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(["docker", "ps", "-aq", "--filter", "label=dockify.managed=true", "--filter", "label=com.docker.compose.project=dockify"]);
  });

  it("goes on when there is none", async () => {
    const seen: string[] = [];
    const exec: Runner = async (_c, args) => {
      seen.push(args[0] === "compose" ? args.at(-3)! : args[0]!);
      return "";
    };
    await steps({ exec }).quiesce();
    expect(seen).toEqual(["ps", "stop"]);
  });
});

describe("the account ceiling", () => {
  const web = { origin: "https://dockify.test", secure: true };
  const reply = () => ({ header() { return this; }, getHeader: () => undefined, setCookie() { return this; } });
  const req = (ip: string, cookie?: string) => ({ clientIp: ip, headers: { "user-agent": "vitest", ...(cookie ? { cookie } : {}) }, cookies: {} });
  const login = authHandlers["auth.login"] as (i: unknown) => Promise<unknown>;
  const outcome = async (p: Promise<unknown>) => {
    try {
      return `ok:${((await p) as { next?: string }).next}`;
    } catch (e) {
      return e instanceof HttpError ? e.code : String(e);
    }
  };
  const password = "correct horse battery staple";

  async function world() {
    const owner = {
      id: "u1", email: "owner@example.com", name: "Owner", passwordHash: await argonHash(password),
      disabledAt: null, member: { role: "admin" }, totpConfirmedAt: new Date(), totpSecretId: "t1",
    };
    const audits: string[] = [];
    const db = {
      user: { findUnique: async ({ where }: { where: { email: string } }) => (where.email === owner.email ? owner : null) },
      activityLog: { create: async ({ data }: { data: { action: string } }) => { audits.push(data.action); return {}; } },
      loginChallenge: { findMany: async () => [], updateMany: async () => ({ count: 0 }), create: async () => ({}) },
      trustedDevice: { findUnique: async () => null },
      session: { findMany: async () => [{ ip: "203.0.113.9" }, { ip: null }] },
    } as unknown as Db;
    return { owner, audits, ctx: { db, ring: testRing(), config: testConfig(), web, limits: new RateLimits() } as unknown as Ctx };
  }
  const flood = async (ctx: Ctx, email: string) => {
    // Five /24s spend ten guesses each, each under its own limit: the account bucket is empty.
    for (let n = 0; n < 5; n++) for (let i = 0; i < 10; i++) ctx.limits.login.attempt(email, `198.51.${n}.7`);
  };

  it("lets a network the account signed in from through, held to that network's own rate", async () => {
    const { ctx, owner, audits } = await world();
    await flood(ctx, owner.email);
    expect(ctx.limits.login.attempt(owner.email, "192.0.2.1")).not.toBeNull();
    expect(await outcome(login({ body: { email: owner.email, password }, req: req("203.0.113.44"), reply: reply(), ctx }))).toBe("ok:verify");
    expect(audits).toEqual([]);
    // A guesser who shares that network still runs out.
    const guesses: string[] = [];
    for (let i = 0; i < 11; i++) guesses.push(await outcome(login({ body: { email: owner.email, password: `g-${i}` }, req: req("203.0.113.44"), reply: reply(), ctx })));
    expect(guesses.at(-1)).toBe("RATE_LIMITED");
  }, 60_000);

  it("still refuses a new network, however right its password, and records why once", async () => {
    const { ctx, owner, audits } = await world();
    await flood(ctx, owner.email);
    expect(await outcome(login({ body: { email: owner.email, password }, req: req("192.0.2.1"), reply: reply(), ctx }))).toBe("RATE_LIMITED");
    expect(await outcome(login({ body: { email: owner.email, password }, req: req("192.0.2.2"), reply: reply(), ctx }))).toBe("RATE_LIMITED");
    expect(audits).toEqual(["auth.login.ceiling"]);
  }, 60_000);

  it("the network that finished a password reset gets in, for a while", () => {
    const g = new LoginGuard();
    g.trustAfterReset("a@x", "192.0.2.1", 1000);
    expect(g.trustedAfterReset("a@x", "192.0.2.200", 2000)).toBe(true);
    expect(g.trustedAfterReset("a@x", "192.0.3.1", 2000)).toBe(false);
    expect(g.trustedAfterReset("b@x", "192.0.2.1", 2000)).toBe(false);
    expect(g.trustedAfterReset("a@x", "192.0.2.1", 1000 + LOGIN_RESET_TRUST_MS)).toBe(false);
  });

  it("onlyCeiling says so only when this network still has budget", () => {
    const g = new LoginGuard();
    for (let n = 0; n < 5; n++) for (let i = 0; i < 10; i++) g.attempt("a@x", `198.51.${n}.7`, 0);
    expect(g.onlyCeiling("a@x", "192.0.2.1", 0)).toBe(true);
    expect(g.onlyCeiling("a@x", "198.51.0.7", 0)).toBe(false);
  });
});

const BASH = process.env.DOCKIFY_TEST_BASH ?? (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");
const haveBash = spawnSync(BASH, ["-c", "true"]).status === 0;
const SCRIPT = path.resolve(import.meta.dirname, "../../../installer/install.sh");
const COMPOSE_FILE = path.resolve(import.meta.dirname, "../../../deploy/docker-compose.yml");
const posix = (p: string) => p.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");
const lib = (snippet: string) => {
  const r = spawnSync(BASH, ["-c", `DOCKIFY_INSTALL_LIB=1 . '${posix(SCRIPT)}'; ${snippet}`], { encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
};

describe("the installer", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const src = () => readFileSync(SCRIPT, "utf8");
  const body = (fn: string) => {
    const s = src();
    const start = s.indexOf(`${fn}() {`);
    return s.slice(start, s.indexOf("\n}\n", start));
  };

  it("never takes a stack file from next to the script without --from-checkout", () => {
    const f = body("fetch_stack_files");
    expect(f).toMatch(/if \[ "\$FROM_CHECKOUT" = 1 \]; then/);
    expect(f.indexOf('FROM_CHECKOUT')).toBeLessThan(f.indexOf('../deploy/docker-compose.yml') === -1 ? Infinity : f.indexOf('../deploy/docker-compose.yml'));
    expect(f).not.toMatch(/\[ -f "\$SRC\/\.\.\/deploy/);
    expect(f).toMatch(/owned_only_by 0 /);
    expect(f).toMatch(/COMPOSE_SHA.*does not match the signed manifest/s);
  });

  it.skipIf(!haveBash)("/tmp/deploy, where the bootstrap's folder points, cannot pass", () => {
    const d = mkdtempSync(path.join(tmpdir(), "dk-own-"));
    dirs.push(d);
    writeFileSync(path.join(d, "f"), "x");
    // Not owned by uid 0 on any machine that runs these tests as a user; a matching uid passes.
    const me = lib(`stat -c %u '${posix(d)}'`).out.trim();
    expect(lib(`owned_only_by ${me === "0" ? "1" : "0"} '${posix(d)}/f'`).code).toBe(1);
    expect(lib(`owned_only_by ${me} '${posix(d)}/nothing'`).code).toBe(1);
  });

  it.skipIf(!haveBash)("keeps the newest upgrade backups and nothing else", () => {
    const d = mkdtempSync(path.join(tmpdir(), "dk-bak-"));
    dirs.push(d);
    for (const n of ["20260101T000000Z", "20260201T000000Z", "20260301T000000Z", "20260401T000000Z", "20260501T000000Z", "keep-me"]) mkdirSync(path.join(d, n));
    expect(lib(`prune_upgrade_backups '${posix(d)}' 3`).code).toBe(0);
    const left = spawnSync(BASH, ["-c", `ls '${posix(d)}'`], { encoding: "utf8" }).stdout.trim().split("\n");
    expect(left).toEqual(["20260301T000000Z", "20260401T000000Z", "20260501T000000Z", "keep-me"]);
  });

  it("--upgrade moves postgres to its address before migrate, and clears the networks it left", () => {
    const f = body("upgrade");
    expect(f.indexOf("up_wait --no-deps postgres")).toBeGreaterThan(f.indexOf("pg_dump"));
    expect(f.indexOf("up_wait --no-deps postgres")).toBeLessThan(f.indexOf("dockify run --rm --no-deps migrate"));
    expect(f).toMatch(/dockify_socket dockify_default/);
    expect(f).toMatch(/prune_upgrade_backups "\$DIR\/upgrade-backups" 3/);
  });

  it("the wrapper refuses exec and admin while a tenant container poses as a service", () => {
    const w = lib(`render_wrapper /opt/dockify 0`).out;
    expect(w).toMatch(/docker ps -aq --filter label=dockify\.managed=true --filter label=com\.docker\.compose\.project=dockify/);
    expect(w.indexOf("label=dockify.managed=true")).toBeLessThan(w.indexOf("dockify admin set-domain <host>"));
  });
});

describe("BuildKit's bridge", () => {
  it("is named so the firewall's tenant rules cover RUN steps", () => {
    const c = readFileSync(COMPOSE_FILE, "utf8");
    expect(c).toMatch(/tenant-builds:\n\s+driver_opts:\n\s+com\.docker\.network\.bridge\.name: dk-build/);
  });
});

describe("the watchdog", () => {
  const row = (service: string, state: string, extra: Record<string, unknown> = {}) => JSON.stringify({ Service: service, State: state, Health: "", ExitCode: 0, Labels: "com.docker.compose.project=dockify", ...extra });

  it("reads Compose's json, both shapes, and never a tenant posing as a service", () => {
    expect(parseComposePs("")).toEqual([]);
    expect(parseComposePs(`${row("api", "running", { Health: "healthy" })}\n${row("worker", "exited", { ExitCode: 137 })}\n`)).toEqual([
      { service: "api", state: "running", health: "healthy", exitCode: 0 },
      { service: "worker", state: "exited", health: "", exitCode: 137 },
    ]);
    expect(parseComposePs(`[${row("web", "running")}]`)).toHaveLength(1);
    expect(parseComposePs(row("postgres", "exited", { ExitCode: 1, Labels: "a=b,dockify.managed=true" }))).toEqual([]);
  });

  const killed = [{ service: "worker", state: "exited", health: "", exitCode: 137 }];

  it("starts a killed service only after the grace period, and once per cooldown", () => {
    const bad = new Map();
    const last = new Map<string, number>();
    expect(decide(killed, bad, last, 0, true)).toEqual([]);
    expect(decide(killed, bad, last, GRACE_MS - 1, true)).toEqual([]);
    const [a] = decide(killed, bad, last, GRACE_MS, true);
    expect(a).toMatchObject({ service: "worker", action: "start" });
    last.set("worker", GRACE_MS);
    expect(decide(killed, bad, last, GRACE_MS + 1000, true)).toEqual([]);
    expect(decide(killed, bad, last, GRACE_MS + COOLDOWN_MS, true)).toHaveLength(1);
  });

  it("leaves a service someone stopped on purpose alone", () => {
    for (const exitCode of [0, 143]) {
      const bad = new Map();
      decide([{ service: "worker", state: "exited", health: "", exitCode }], bad, new Map(), 0, true);
      expect(decide([{ service: "worker", state: "exited", health: "", exitCode }], bad, new Map(), GRACE_MS * 2, true)).toEqual([]);
    }
  });

  it("restarts an unhealthy worker, but not while the database is what is down", () => {
    const sick = [{ service: "worker", state: "running", health: "unhealthy", exitCode: 0 }];
    const down = new Map();
    decide(sick, down, new Map(), 0, false);
    expect(decide(sick, down, new Map(), GRACE_MS * 2, false)).toEqual([]);
    const up = new Map();
    decide(sick, up, new Map(), 0, true);
    expect(decide(sick, up, new Map(), GRACE_MS, true)).toEqual([{ service: "worker", action: "restart", why: expect.any(String) }]);
  });

  it("forgets a state once it clears, and ignores what it does not watch", () => {
    const bad = new Map();
    decide(killed, bad, new Map(), 0, true);
    decide([], bad, new Map(), 1000, true);
    expect(decide(killed, bad, new Map(), GRACE_MS * 2, true)).toEqual([]);
    const m = new Map();
    decide([{ service: "migrate", state: "exited", health: "", exitCode: 1 }], m, new Map(), 0, true);
    expect(m.size).toBe(0);
  });

  const fakeDb = (over: { updating?: boolean } = {}) => ({
    releaseUpdate: { findFirst: async () => (over.updating ? { id: "u" } : null) },
    job: { findFirst: async () => null },
    activityLog: { create: async () => ({}) },
  }) as unknown as Db;

  it("does nothing during an update, which stops services itself", async () => {
    const calls: string[][] = [];
    const exec: Runner = async (_c, a) => { calls.push(a); return row("worker", "exited", { ExitCode: 137 }); };
    let now = 0;
    const w = dockerWatchdog({ composeDir: DIR }, { db: fakeDb({ updating: true }), probe, log: () => {}, exec, fs: tree(), now: () => now });
    await w.tick();
    now = GRACE_MS * 2;
    expect(await w.tick()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("brings a killed worker back through compose", async () => {
    const calls: string[][] = [];
    const exec: Runner = async (_c, a) => { calls.push(a); return a.includes("ps") ? row("worker", "exited", { ExitCode: 137 }) : ""; };
    let now = 0;
    const w = dockerWatchdog({ composeDir: DIR }, { db: fakeDb(), probe, log: () => {}, exec, fs: tree(), now: () => now });
    expect(await w.tick()).toEqual([]);
    now = GRACE_MS;
    expect(await w.tick()).toHaveLength(1);
    expect(calls.at(-1)?.slice(-2)).toEqual(["start", "worker"]);
  });

  it("with the database down, only the database may be touched", async () => {
    const calls: string[][] = [];
    const exec: Runner = async (_c, a) => { calls.push(a); return a.includes("ps") ? `${row("postgres", "exited", { ExitCode: 137 })}\n${row("worker", "exited", { ExitCode: 137 })}` : ""; };
    let now = 0;
    const w = dockerWatchdog({ composeDir: DIR }, { db: fakeDb(), probe: { databaseOk: async () => false }, log: () => {}, exec, fs: tree(), now: () => now });
    await w.tick();
    now = GRACE_MS;
    expect((await w.tick()).map((a) => a.service)).toEqual(["postgres"]);
  });
});

describe("reserved service names", () => {
  it("refused for a new service and a restored database, fine for an ordinary app", () => {
    const base = { kind: "postgres", projectId: "0f0e0d0c-0000-4000-8000-0000000000aa", environment: "production" };
    for (const name of ["postgres", "socket-proxy", "dockify-proxy", "dockify-worker", "api", "web", "worker"]) {
      expect(resources.CreateResourceBody.safeParse({ ...base, name }).success, name).toBe(false);
    }
    expect(resources.CreateResourceBody.safeParse({ ...base, name: "main-db" }).success).toBe(true);
    expect(backups.NewDbName.safeParse("postgres").success).toBe(false);
    expect(projects.NewAppBody.safeParse({ name: "web", kind: "backend", environment: "production" }).success).toBe(true);
  });

  it("a compose file's postgres service is imported under another name, with a warning", () => {
    const r = composeToSpecs({ services: { postgres: { image: "postgres:16" }, web: { image: "nginx:1" } } });
    expect(r.refusals).toEqual([]);
    expect(r.specs.map((s) => s.name)).toEqual(["postgres-db", "web"]);
    expect(r.warnings.join(" ")).toMatch(/postgres-db/);
  });
});

describe("the validation error for an app with one bad field", () => {
  const good = { name: "shop", kind: "backend", environment: "production", target: "server", source: { type: "image", image: "nginx:1", registryId: null } };

  it("names that field, not source", () => {
    const r = projects.NewAppBody.safeParse({ ...good, volumes: [{ name: "BAD NAME", path: "/data" }] });
    expect(r.success).toBe(false);
    const f = zodFields(r.error!);
    expect(JSON.stringify(f)).not.toMatch(/Unrecognized/);
    expect(f.fields).toHaveProperty("volumes.0.name");
    expect(f.field).toBe("volumes");
  });

  it("keeps both shapes working, with their output", () => {
    const full = projects.NewAppBody.safeParse(good);
    expect(full.success).toBe(true);
    expect(full.data).toMatchObject({ name: "shop", source: { type: "image" } });
    const bare = projects.NewAppBody.safeParse({ name: "db", kind: "postgres", environment: "production" });
    expect(bare.success).toBe(true);
    expect(projects.NewAppBody.safeParse({ name: "x", kind: "backend", environment: "production", privileged: true }).success).toBe(false);
    expect(projects.NewAppBody.safeParse("nope").success).toBe(false);
  });

  it("the import body names its bad field too", () => {
    const r = projects.ImportAppsBody.safeParse({ environment: "production", apps: [{ ...good, environment: undefined, name: "BAD" }] });
    expect(r.success).toBe(false);
    expect(zodFields(r.error!).fields).toHaveProperty("apps.0.name");
    expect(projects.ImportAppsBody.safeParse({ environment: "production", compose: "services: {}" }).success).toBe(true);
  });
});

describe("the request log", () => {
  it("writes the route's pattern, or the path without its query, never a secret", () => {
    expect(requestLogFields({ method: "GET", url: "/api/v1/git/app/callback?code=abc&state=d", routeOptions: { url: "/api/v1/git/app/callback" }, ip: "1.2.3.4" })).toEqual({ method: "GET", url: "/api/v1/git/app/callback", remoteAddress: "1.2.3.4" });
    expect(requestLogFields({ method: "POST", url: "/api/v1/auth/reset/tok123", routeOptions: { url: "/api/v1/auth/reset/:token" } }).url).toBe("/api/v1/auth/reset/:token");
    expect(requestLogFields({ method: "GET", url: "/nope?code=abc" }).url).toBe("/nope");
  });
});

describe("an ntfy token stays with its host", () => {
  it("is dropped when the webhook moves to another host, unless the patch sends one", () => {
    expect(secondFor("ntfy", {}, { provider: "ntfy", hasSecret: true, hostMoved: true })).toEqual({ action: "drop" });
    expect(secondFor("ntfy", {}, { provider: "ntfy", hasSecret: true, hostMoved: false })).toEqual({ action: "keep" });
    expect(secondFor("ntfy", { accessToken: "tk_abcdefgh" }, { provider: "ntfy", hasSecret: true, hostMoved: true })).toEqual({ action: "set", value: "tk_abcdefgh", generated: null });
  });
});
