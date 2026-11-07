/**
 * What a preview gets, across who opened it, what it is based on and what the owner allowed: the exact
 * env, network and cache namespace handed to the container and to both builders. Everything runs
 * through what the pipeline calls, from the row loadPreviewContext reads.
 */
import { describe, expect, it } from "vitest";
import { projects as P } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import { buildCacheScope, cachePruneArgs, planBuild, planRailpackBuild, pruneArgs, scopePruneArgs, type ContainerSummary } from "@dockify/engine";
import { removePreviewNetwork, sweepPreviewNetworks } from "./networks.ts";
import { ensurePreviewNetwork, FORK_NETWORK, loadPreviewContext, networkOf, previewContainerInput, previewNetwork, previewReleaseInput, previewVars } from "./preview.ts";
import { runtimeEnv, type ResolvedVar } from "./env.ts";
import { commentFor, type FeedbackView } from "../integrations/preview-feedback.ts";
import { correctIsolation, planIsolationDrift, reconcilePreviews, runPreviewCleanup, type PreviewRuntimeDeps } from "../integrations/previews.ts";

const ENV = "0f0f0f0f-0000-4000-8000-0000000000e1";
const PROD = "0f0f0f0f-0000-4000-8000-0000000000a1";
const DEV = "0f0f0f0f-0000-4000-8000-0000000000a2";
const APP = "0f0f0f0f-0000-4000-8000-0000000000b1";

const VARS: ResolvedVar[] = [
  { key: "API_KEY", value: "real-api-key", isSecret: true, target: "both" },
  { key: "BUILD_TOKEN", value: "real-build-token", isSecret: true, target: "build" },
  { key: "DATABASE_URL", value: "postgres://real", isSecret: true, target: "both" },
  { key: "PGHOST", value: "real-db-host", isSecret: false, target: "both" },
  { key: "PUBLIC_NAME", value: "shop", isSecret: false, target: "both" },
  { key: "REDIS_URL", value: "redis://real", isSecret: true, target: "runtime" },
];
const ALL_RUNTIME = ["API_KEY", "DATABASE_URL", "PGHOST", "PUBLIC_NAME", "REDIS_URL"];
const PREVIEW_KEYS = ["DOCKIFY_PREVIEW", "DOCKIFY_PREVIEW_PR", "DOCKIFY_PREVIEW_URL"];
const OWN_DB = { url: "postgres://own", host: "dk-pvdb", port: 5432, user: "preview", password: "own-pw", database: "preview" };

interface Case {
  fork: boolean;
  base: string;
  /** How many environments the project has. */
  envs: number;
  allowed: boolean;
  isolation: P.PreviewIsolation;
  network: string;
  scope: string;
  /** The app's runtime keys it keeps, besides the DOCKIFY_PREVIEW ones. */
  runtime: string[];
}

const OWN = previewNetwork(ENV);
const dev = `dockify-env-${DEV}`;
const prod = `dockify-env-${PROD}`;
const same = `dockify-preview-${ENV}`;
const fork = `dockify-fork-${ENV}`;

const TABLE: Case[] = [
  { fork: false, base: "production", envs: 2, allowed: false, isolation: "own", network: OWN, scope: same, runtime: ["PUBLIC_NAME"] },
  { fork: false, base: "production", envs: 2, allowed: true, isolation: "base", network: prod, scope: same, runtime: ALL_RUNTIME },
  { fork: false, base: "development", envs: 2, allowed: false, isolation: "base", network: dev, scope: same, runtime: ALL_RUNTIME },
  { fork: false, base: "development", envs: 2, allowed: true, isolation: "base", network: dev, scope: same, runtime: ALL_RUNTIME },
  { fork: true, base: "production", envs: 2, allowed: false, isolation: "fork", network: FORK_NETWORK, scope: fork, runtime: ["PGHOST", "PUBLIC_NAME"] },
  { fork: true, base: "production", envs: 2, allowed: true, isolation: "fork", network: FORK_NETWORK, scope: fork, runtime: ["PGHOST", "PUBLIC_NAME"] },
  { fork: true, base: "development", envs: 2, allowed: false, isolation: "fork", network: FORK_NETWORK, scope: fork, runtime: ["PGHOST", "PUBLIC_NAME"] },
  { fork: true, base: "development", envs: 2, allowed: true, isolation: "fork", network: FORK_NETWORK, scope: fork, runtime: ["PGHOST", "PUBLIC_NAME"] },
  // The one-environment project: its only environment holds the real data, whatever it is called.
  { fork: false, base: "production", envs: 1, allowed: false, isolation: "own", network: OWN, scope: same, runtime: ["PUBLIC_NAME"] },
  { fork: false, base: "main", envs: 1, allowed: false, isolation: "own", network: OWN, scope: same, runtime: ["PUBLIC_NAME"] },
  { fork: false, base: "main", envs: 1, allowed: true, isolation: "base", network: `dockify-env-${DEV}`, scope: same, runtime: ALL_RUNTIME },
  { fork: false, base: "prod", envs: 2, allowed: false, isolation: "own", network: OWN, scope: same, runtime: ["PUBLIC_NAME"] },
];

const dbFor = (c: Pick<Case, "fork" | "base" | "envs" | "allowed">, isolatedDb = false): Db => ({
  previewDeployment: {
    findUnique: async () => ({
      id: "pd", hostname: "pr-7-web.preview.example.com",
      env: {
        id: ENV, prNumber: 7, fromFork: c.fork, isolatedDb, status: "building",
        baseEnvironmentId: c.base === "production" || c.base === "prod" ? PROD : DEV,
        baseEnvironment: { name: c.base },
        project: { id: "p", previewCpuLimit: 0.5, previewMemoryMb: 256, previewPidsLimit: 64, previewProductionAccess: c.allowed, environments: Array.from({ length: c.envs }, (_, i) => ({ id: String(i) })) },
      },
    }),
  },
}) as unknown as Db;

const name = (c: Case) => `${c.fork ? "fork" : "same repo"}, base ${c.base} of ${c.envs}, setting ${c.allowed ? "on" : "off"}`;

describe.each(TABLE.map((c) => [name(c), c] as const))("%s", (_n, c) => {
  const ctx = async () => (await loadPreviewContext(dbFor(c), "pd"))!;

  it("decides the isolation and the network", async () => {
    expect(await ctx()).toMatchObject({ isolation: c.isolation, network: c.network });
  });

  it("gives the container exactly that env and that network", async () => {
    const pv = await ctx();
    const env = runtimeEnv(previewVars(VARS, pv, null), 3000);
    expect(Object.keys(env).sort()).toEqual([...c.runtime, ...PREVIEW_KEYS, "PORT"].sort());
    const input = previewContainerInput({ port: 3000, startCommand: null }, pv, { name: "dk-pv-x", imageId: "sha256:i", env, deploymentId: "dep" });
    expect(input.network).toBe(c.network);
    expect(input.env).toEqual(env);
    expect(previewReleaseInput(pv, { name: "dk-pv-r", imageId: "sha256:i", env, deploymentId: "dep", command: "x" }).network).toBe(c.network);
    if (c.isolation !== "base") expect(JSON.stringify(env)).not.toMatch(/real-api-key|postgres:\/\/real|redis:\/\/real/);
  });

  it("hands both builders exactly that env, and the preview's own cache", async () => {
    const pv = await ctx();
    const vars = previewVars(VARS, pv, null);
    expect(buildCacheScope(APP, pv)).toBe(c.scope);
    const docker = planBuild({ buildkitAddr: "a", contextDir: "/c", dockerfileDir: "/c", dockerfileName: "Dockerfile", imageName: "i", appId: APP, deploymentId: "d", vars, cacheScope: buildCacheScope(APP, pv) });
    const railpack = planRailpackBuild({ buildkitAddr: "a", contextDir: "/c", planDir: "/p", imageName: "i", appId: APP, cacheScope: buildCacheScope(APP, pv), vars });
    const secrets = c.isolation === "base" ? ["API_KEY", "BUILD_TOKEN", "DATABASE_URL"] : [];
    for (const plan of [docker, railpack]) {
      for (const k of secrets) expect(plan.env[`DOCKIFY_BUILD_SECRET_${k}`], k).toBeDefined();
      if (c.isolation !== "base") expect(JSON.stringify([plan.args, plan.env])).not.toMatch(/real-api-key|real-build-token|postgres:\/\/real/);
    }
    expect(docker.args).toContain(`build-arg:BUILDKIT_CACHE_MOUNT_NS=${c.scope}`);
    expect(docker.args).toContain(`build-arg:BUILDKIT_SANDBOX_HOSTNAME=${c.scope}`);
    expect(railpack.args).toContain(`build-arg:cache-key=${c.scope}`);
    expect(JSON.stringify(docker.args)).not.toContain(`dockify-app-`);
    expect(JSON.stringify(railpack.args)).not.toContain(`dockify-app-`);
  });
});

describe("a production build's cache", () => {
  const scope = buildCacheScope(APP, null);
  const vars = VARS.slice(4);
  const dockerArgs = (cacheScope?: string) => planBuild({ buildkitAddr: "a", contextDir: "/c", dockerfileDir: "/c", dockerfileName: "Dockerfile", imageName: "i", appId: APP, deploymentId: "d", vars, ...(cacheScope ? { cacheScope } : {}) }).args;
  const hash = (cacheScope: string) => planRailpackBuild({ buildkitAddr: "a", contextDir: "/c", planDir: "/p", imageName: "i", appId: APP, cacheScope, vars }).args.find((a) => a.startsWith("build-arg:secrets-hash="));

  it("stays where it was: the same namespace, and no hostname that would cold-start it", () => {
    expect(scope).toBe(`dockify-app-${APP}`);
    expect(dockerArgs(scope)).toEqual(dockerArgs());
    expect(dockerArgs()).toContain(`build-arg:BUILDKIT_CACHE_MOUNT_NS=${scope}`);
    expect(dockerArgs().join(" ")).not.toContain("BUILDKIT_SANDBOX_HOSTNAME");
  });

  it("shares no layer key with a preview, on the same vars", () => {
    expect(dockerArgs(same).join(" ")).toContain("BUILDKIT_SANDBOX_HOSTNAME");
    expect(hash(same)).not.toBe(hash(scope));
    expect(hash(fork)).not.toBe(hash(scope));
    expect(hash(same)).not.toBe(hash(fork));
  });

  it("a tenant variable cannot move a build onto production's namespace or hostname", () => {
    const hostile: ResolvedVar[] = [
      { key: "BUILDKIT_SANDBOX_HOSTNAME", value: "buildkitsandbox", isSecret: false, target: "build" },
      { key: "BUILDKIT_CACHE_MOUNT_NS", value: scope, isSecret: false, target: "build" },
    ];
    const args = planBuild({ buildkitAddr: "a", contextDir: "/c", dockerfileDir: "/c", dockerfileName: "Dockerfile", imageName: "i", appId: APP, deploymentId: "d", vars: hostile, cacheScope: same }).args;
    expect(args.filter((a) => a.startsWith("build-arg:"))).toEqual([`build-arg:BUILDKIT_CACHE_MOUNT_NS=${same}`, `build-arg:BUILDKIT_SANDBOX_HOSTNAME=${same}`]);
  });

  it("the hostname BuildKit is given is a valid one", () => {
    expect(same.length).toBeLessThanOrEqual(63);
    expect(same).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("an old row", () => {
  it("with no setting recorded reads as off", () => {
    const old = { fromFork: false, baseEnvironment: { name: "production" }, project: { environments: [{}] } } as unknown as Parameters<typeof P.previewIsolation>[0];
    expect(P.previewIsolation(old)).toBe("own");
  });
  it("Prisma's default is off", async () => {
    const { readFile } = await import("node:fs/promises");
    const schema = await readFile(new URL("../../../../packages/db/prisma/schema.prisma", import.meta.url), "utf8");
    expect(schema).toMatch(/previewProductionAccess\s+Boolean\s+@default\(false\)/);
  });
});

describe("what a preview kept out of production gets instead", () => {
  const own = { isolation: "own" as const, prNumber: 7, hostname: "h" };
  it("with an isolated database: that, and still no secret", () => {
    const by = new Map(previewVars(VARS, own, OWN_DB).map((v) => [v.key, v.value]));
    expect(by.get("DATABASE_URL")).toBe("postgres://own");
    expect(by.get("PGHOST")).toBe("dk-pvdb");
    expect(by.has("API_KEY")).toBe(false);
    expect(by.has("REDIS_URL")).toBe(false);
  });
  it("without one: no database key, even one nobody marked secret", () => {
    const keys = previewVars(VARS, own, null).map((v) => v.key);
    expect(keys).toEqual([...PREVIEW_KEYS, "PUBLIC_NAME"]);
  });
  it("a retry that reopens a snapshot sealed with secrets loses them too", () => {
    const sealedBefore = previewVars(VARS, { ...own, isolation: "base" }, null);
    const again = previewVars(sealedBefore, own, null);
    expect(again.some((v) => v.isSecret)).toBe(false);
    expect(again.map((v) => v.key)).toEqual([...PREVIEW_KEYS, "PUBLIC_NAME"]);
  });
  it("its database is on the same network as the app, labelled for the sweep", async () => {
    const made: Array<[string, Record<string, string>]> = [];
    const docker = { ensureNetwork: async (n: string, l: Record<string, string>) => { made.push([n, l]); } } as never;
    await ensurePreviewNetwork(docker, { network: OWN, isolation: "own", envId: ENV });
    expect(made[0]![0]).toBe(OWN);
    expect(made[0]![1]).toMatchObject({ "dockify.preview": ENV });
    expect(OWN).toMatch(/^dockify-pv-[0-9a-f-]{36}$/);
  });
  it("a production base's network, or a dev one, is never what it is told to join", () => {
    expect(networkOf("own", ENV, PROD)).toBe(OWN);
    expect(networkOf("own", ENV, PROD)).not.toBe(prod);
  });
});

describe("what it says about itself", () => {
  const view: FeedbackView = {
    prNumber: 7, status: "ready", reason: null, error: null, lines: [], updatedAt: new Date(0), fromFork: false, isolatedDb: false, isolation: "own", baseEnvironment: "production",
    apps: [{ name: "web", url: null }], dashboardUrl: null, idleMinutes: 30, ttlHours: 72,
  };
  it("the comment never claims production's services it does not have", () => {
    const c = commentFor(view);
    expect(c).toContain("Runs without production's secrets and services, so an app that needs them fails here.");
    expect(c).not.toContain("environment's services");
    expect(commentFor({ ...view, isolatedDb: true })).toContain("Uses its own temporary database");
  });
  it("when allowed, it says what it does use", () => {
    const c = commentFor({ ...view, isolation: "base" });
    expect(c).toContain("Uses the production environment's services.");
    expect(c).not.toContain("Runs without production's");
  });
});

const summary = (id: string, labels: Record<string, string>, networks?: string[]): ContainerSummary => ({
  Id: id, Names: [`/${id}`], Image: "i", ImageID: "i", State: "running", Labels: labels,
  ...(networks ? { NetworkSettings: { Networks: Object.fromEntries(networks.map((n) => [n, {}])) } } : {}),
});
const appOn = (id: string, env: string, net: string) => summary(id, { "dockify.preview": env, "dockify.role": "preview" }, [net]);

describe("a preview already running when the answer changes", () => {
  const rows = (status: "ready" | "failed" | "asleep" | "building") => [{ id: ENV, status, network: OWN }];

  it("on production's network, as older ones are: its containers go, its database too, and it builds again", () => {
    const c = [appOn("a", ENV, prod), summary("d", { "dockify.preview": ENV, "dockify.role": "preview-db" }, [prod])];
    expect(planIsolationDrift(c, rows("ready"))).toEqual({ containers: ["a", "d"], rebuild: [ENV] });
    expect(planIsolationDrift(c, rows("failed"))).toEqual({ containers: ["a", "d"], rebuild: [ENV] });
  });
  it("asleep: its secrets go now, and its wake builds", () => {
    expect(planIsolationDrift([appOn("a", ENV, prod)], rows("asleep"))).toEqual({ containers: ["a"], rebuild: [] });
  });
  it("building: left for the next pass, its new container may be starting", () => {
    expect(planIsolationDrift([appOn("a", ENV, prod)], rows("building"))).toEqual({ containers: [], rebuild: [] });
  });
  it("on the right network, a one-off, another's or one that does not say: left alone", () => {
    expect(planIsolationDrift([appOn("a", ENV, OWN)], rows("ready")).containers).toEqual([]);
    expect(planIsolationDrift([summary("r", { "dockify.preview": ENV, "dockify.role": "preview-release" }, [prod])], rows("ready")).containers).toEqual([]);
    expect(planIsolationDrift([appOn("a", "other", prod)], rows("ready")).containers).toEqual([]);
    expect(planIsolationDrift([summary("a", { "dockify.preview": ENV, "dockify.role": "preview" })], rows("ready")).containers).toEqual([]);
  });

  /** Enough of a world for one correction: a project that has just had the setting turned off. */
  const world = (over: { status?: string; busy?: boolean } = {}) => {
    const removed: string[] = [];
    const routes: string[] = [];
    const jobs: unknown[] = [];
    const deployments: unknown[] = [];
    const row: Record<string, unknown> = {
      id: ENV, status: over.status ?? "ready", fromFork: false, baseEnvironmentId: PROD, baseEnvironment: { name: "production" }, project: { previewProductionAccess: false, environments: [{ id: PROD }] },
      commitSha: "c".repeat(40), branch: "b", title: "t", apps: [{ id: "m1", appId: APP, app: { serverId: "s" } }],
    };
    const tx = {
      $executeRaw: async () => 1,
      previewEnv: { updateMany: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(row, data); return { count: 1 }; } },
      previewDeployment: { updateMany: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(row, { member: data }); return { count: 1 }; } },
      deployment: { findFirst: async () => (over.busy ? { id: "busy" } : null), create: async (a: { data: unknown }) => { deployments.push(a.data); return { id: "dep" }; } },
      job: { create: async (a: unknown) => { jobs.push(a); return {}; }, upsert: async (a: unknown) => { jobs.push(a); return {}; }, findFirst: async () => null },
    };
    const db = { ...tx, previewEnv: { ...tx.previewEnv, findMany: async () => [row], findUnique: async () => row }, $transaction: async (fn: (t: unknown) => unknown) => fn(tx) };
    const deps = {
      db, serverId: "s",
      docker: { removeContainer: async (id: string) => { removed.push(id); } },
      routes: { apply: async (c: { removes: string[] }) => { routes.push(...c.removes); }, snapshot: async () => ({}) },
    } as unknown as PreviewRuntimeDeps;
    return { deps, row, removed, routes, jobs, deployments };
  };

  it("nothing keeps serving: the container and route go before the build, and links go with them", async () => {
    const w = world();
    const out = await correctIsolation(w.deps, [appOn("a", ENV, prod)], new Date(0));
    expect(out).toEqual({ containers: 1, rebuilt: [ENV] });
    expect(w.removed).toEqual(["a"]);
    expect(w.routes).toEqual(["pv-m1.yml"]);
    expect(w.row.status).toBe("building");
    expect(w.row.member).toMatchObject({ currentDeploymentId: null, containerId: null });
    expect(w.deployments).toHaveLength(1);
    expect(w.deployments[0]).toMatchObject({ previewId: "m1", trigger: "preview", commitSha: "c".repeat(40) });
  });

  it("the reconcile applies it on its own, with no one asking", async () => {
    const w = world();
    Object.assign(w.row, { lastCommitAt: new Date(0), lastRequestAt: null, sleptAt: null, updatedAt: new Date(0), requestCount: null, isolatedDb: false });
    Object.assign(w.row.project as object, { previewEnabled: true, archivedAt: null, previewTtlHours: 1000, previewIdleMinutes: 0 });
    const db = w.deps.db as unknown as Record<string, unknown>;
    db.job = { ...(db.job as object), findMany: async () => [] };
    db.previewDeployment = { findMany: async () => [] };
    (w.deps.docker as unknown as Record<string, unknown>).listContainers = async () => (w.removed.length ? [] : [appOn("a", ENV, prod)]);
    await reconcilePreviews(w.deps, new Date(1000));
    expect(w.removed).toEqual(["a"]);
    expect(w.deployments).toHaveLength(1);
  });

  it("a build already running is not queued twice", async () => {
    const w = world({ busy: true });
    await correctIsolation(w.deps, [appOn("a", ENV, prod)], new Date(0));
    expect(w.deployments).toHaveLength(0);
  });

  it("a preview on the right network costs nothing", async () => {
    const w = world();
    expect(await correctIsolation(w.deps, [appOn("a", ENV, OWN)], new Date(0))).toEqual({ containers: 0, rebuilt: [] });
    expect(w.removed).toEqual([]);
    expect(w.row.status).toBe("ready");
  });
});

describe("what a preview leaves behind", () => {
  const networkDocker = (over: { attached?: string[]; containers?: ContainerSummary[] } = {}) => {
    const calls: string[] = [];
    return {
      calls,
      docker: {
        inspectNetwork: async () => ({ Name: "n", Containers: Object.fromEntries((over.attached ?? []).map((n) => [n, { Name: n }])) }),
        listContainers: async () => over.containers ?? [],
        disconnectNetwork: async (n: string, c: string) => { calls.push(`disconnect ${n} ${c}`); },
        removeNetwork: async (n: string) => { calls.push(`remove ${n}`); },
        listPreviewNetworks: async () => [OWN, FORK_NETWORK],
      },
    };
  };
  const own = ["dockify-proxy", "dockify-agent"];

  it("teardown removes its network and its cache mounts, by the namespace it built with", async () => {
    const pruned: string[] = [];
    const n = networkDocker({ attached: ["dockify-proxy"] });
    for (const [fromFork, scope] of [[false, same], [true, fork]] as const) {
      pruned.length = 0;
      n.calls.length = 0;
      const row = { id: ENV, status: "closing", fromFork, apps: [] };
      const tx = { $executeRaw: async () => 1, previewEnv: { update: async () => ({}) }, job: { upsert: async () => ({}), findFirst: async () => null, create: async () => ({}) } };
      const db = { ...tx, previewEnv: { ...tx.previewEnv, findUnique: async () => row }, deployment: { updateMany: async () => ({ count: 0 }), findMany: async () => [] }, previewDeployment: { updateMany: async () => ({ count: 0 }) }, $transaction: async (fn: (t: unknown) => unknown) => fn(tx) };
      await runPreviewCleanup({
        db, serverId: "s", docker: { listContainers: async () => [], removeVolume: async () => {} }, routes: {},
        networks: { docker: n.docker, ownContainers: own }, builder: { pruneCacheScope: async (s: string) => { pruned.push(s); return ""; } },
      } as never, { previewId: ENV });
      expect(pruned).toEqual([scope]);
      expect(n.calls).toEqual([`disconnect ${OWN} dockify-proxy`, `remove ${OWN}`]);
    }
  });

  it("a failed reclaim never holds a teardown up", async () => {
    let closed = false;
    const tx = { $executeRaw: async () => 1, previewEnv: { update: async () => { closed = true; return {}; } }, job: { upsert: async () => ({}), findFirst: async () => null, create: async () => ({}) } };
    const db = { ...tx, previewEnv: { ...tx.previewEnv, findUnique: async () => ({ id: ENV, status: "closing", fromFork: false, apps: [] }) }, deployment: { updateMany: async () => ({ count: 0 }), findMany: async () => [] }, previewDeployment: { updateMany: async () => ({ count: 0 }) }, $transaction: async (fn: (t: unknown) => unknown) => fn(tx) };
    const logged: string[] = [];
    await runPreviewCleanup({
      db, serverId: "s", docker: { listContainers: async () => [], removeVolume: async () => {} }, routes: {}, log: (m: string) => logged.push(m),
      networks: { docker: { inspectNetwork: async () => { throw new Error("boom"); } }, ownContainers: own },
      builder: { pruneCacheScope: async () => { throw new Error("no daemon"); } },
    } as never, { previewId: ENV });
    expect(closed).toBe(true);
    expect(logged).toEqual(["could not remove a preview's network", "could not reclaim a preview's build cache"]);
  });

  it("a network with a container of anyone else on it, or a stopped one of its own, stays", async () => {
    const busy = networkDocker({ attached: ["someone"] });
    expect(await removePreviewNetwork({ docker: busy.docker as never, ownContainers: own }, ENV)).toBe(false);
    const stopped = networkDocker({ containers: [summary("x", {})] });
    expect(await removePreviewNetwork({ docker: stopped.docker as never, ownContainers: own }, ENV)).toBe(false);
    expect([...busy.calls, ...stopped.calls]).toEqual([]);
  });

  it("the sweep takes an orphan and never the shared fork network", async () => {
    const n = networkDocker();
    const db = { previewEnv: { findMany: async () => [] } } as unknown as Db;
    expect(await sweepPreviewNetworks({ db, serverId: "s", docker: n.docker as never, ownContainers: own })).toBe(1);
    expect(n.calls).toEqual([`remove ${OWN}`]);
  });

  it("the sweep leaves the network of a preview still open", async () => {
    const n = networkDocker();
    const db = { previewEnv: { findMany: async () => [{ id: ENV }] } } as unknown as Db;
    expect(await sweepPreviewNetworks({ db, serverId: "s", docker: n.docker as never, ownContainers: own })).toBe(0);
    expect(n.calls).toEqual([]);
  });

  it("the janitor's trim and the disk prune name no scope, so they cover a preview's cache like any other", () => {
    expect(pruneArgs("a", 1024 ** 3).join(" ")).not.toContain("filter");
    expect(cachePruneArgs("a").join(" ")).not.toContain("filter");
  });

  it("a scope's prune asks for that scope and nothing wider", () => {
    expect(scopePruneArgs("a", same)).toEqual(["--addr", "a", "prune", "--filter", `description~=${same}`, "--format", "{{json .}}"]);
  });
});
