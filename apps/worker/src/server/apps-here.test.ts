/**
 * Two servers and one database: whatever a pass does on one must not touch the other's apps. Today
 * only one server exists, so without these rows a missing scope would show on the day the second joins,
 * as apps read missing, images deleted and routes swept. The fake database honours `where`, including
 * serverId, so a site that loses its scope fails here.
 */
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { sweepLeftovers } from "../data/leftovers.ts";
import { recoverQuiesced, upgradeLegacyServices } from "../data/scheduler.ts";
import type { DataDeps } from "../data/context.ts";
import type { DockerPort } from "../data/docker-port.ts";
import { runPrune } from "../deploy/disk.ts";
import { removeDeletedAppImages, runJanitor } from "../deploy/janitor.ts";
import { sweepEnvNetworks } from "../deploy/networks.ts";
import { settleOrphanedDeployments } from "../deploy/pipeline.ts";
import type { DeployConfig } from "../deploy/config.ts";
import { edgeServerHandlers, resyncRoutes, syncAppRoute, type EdgeDeps } from "../edge/jobs.ts";
import { readRoute, writeRoute } from "../edge/routes.ts";
import { reconcilePreviews, type PreviewRuntimeDeps } from "../integrations/previews.ts";
import { settleOrphanRuns } from "../jobs/tick.ts";
import { createAlertRunner } from "../observe/alert-runner.ts";
import { reconcileAppStatus } from "../observe/app-status.ts";
import type { ContainerSummary, DockerReader } from "../observe/docker.ts";
import { reachTargets } from "../observe/reach.ts";
import { createSampler, newSamplerState } from "../observe/sampler.ts";
import { recordUptimeMinute } from "../observe/uptime.ts";
import type { ClaimedJob } from "../queue.ts";
import { removeApp } from "../teardown.ts";
import { appsHere } from "./apps-here.ts";
import { fileRouteStore } from "@dockify/engine";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const APP_A = "0a0a0a0a-0000-4000-8000-00000000000a";
const APP_B = "0b0b0b0b-0000-4000-8000-00000000000b";
const ENV_A = "0e0e0e0e-0000-4000-8000-00000000000a";
const ENV_B = "0e0e0e0e-0000-4000-8000-00000000000b";
const ENV_BOTH = "0e0e0e0e-0000-4000-8000-0000000000ab";
const IMG_A = `sha256:${"a".repeat(64)}`;
const IMG_B = `sha256:${"b".repeat(64)}`;

type Row = Record<string, unknown>;

/** The part of Prisma's where these passes use. */
function matches(row: Row, where: unknown): boolean {
  if (!where) return true;
  for (const [key, want] of Object.entries(where as Row)) {
    if (key === "OR") {
      if (!(want as unknown[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const have = row[key];
    if (want !== null && typeof want === "object" && !(want instanceof Date)) {
      const w = want as { in?: unknown[]; notIn?: unknown[]; not?: unknown; some?: unknown; none?: unknown; lte?: Date; lt?: Date; gt?: Date };
      if ("in" in w && !w.in!.includes(have)) return false;
      if ("notIn" in w && w.notIn!.includes(have)) return false;
      if ("not" in w && have === w.not) return false;
      if ("gt" in w && !(have instanceof Date && have > w.gt!)) return false;
      if ("lt" in w && !(have instanceof Date && have < w.lt!)) return false;
      if ("some" in w && !((have as Row[] | undefined) ?? []).some((r) => matches(r, w.some))) return false;
      if ("none" in w && ((have as Row[] | undefined) ?? []).some((r) => matches(r, w.none))) return false;
      if (!["in", "notIn", "not", "gt", "lt", "some", "none"].some((k) => k in w) && !(have && matches(have as Row, want))) return false;
    } else if (have !== want) {
      return false;
    }
  }
  return true;
}

function table(rows: Row[]) {
  const pick = (where: unknown) => rows.filter((r) => matches(r, where));
  return {
    rows,
    findMany: async (a?: { where?: unknown }) => pick(a?.where),
    findFirst: async (a?: { where?: unknown }) => pick(a?.where)[0] ?? null,
    findUnique: async (a: { where: { id: string } }) => rows.find((r) => r.id === a.where.id) ?? null,
    updateMany: async (a: { where?: unknown; data: Row }) => {
      const hit = pick(a.where);
      for (const r of hit) Object.assign(r, a.data);
      return { count: hit.length };
    },
    update: async (a: { where: { id: string }; data: Row }) => Object.assign(rows.find((r) => r.id === a.where.id) ?? {}, a.data),
    create: async (a: { data: Row }) => {
      const row = { id: `row-${rows.length}`, ...a.data };
      rows.push(row);
      return row;
    },
    createMany: async (a: { data: Row[] }) => {
      rows.push(...a.data);
      return { count: a.data.length };
    },
    upsert: async (a: { create: Row }) => {
      rows.push(a.create);
      return a.create;
    },
    deleteMany: async () => ({ count: 0 }),
  };
}

const app = (id: string, serverId: string, over: Row = {}) => ({
  id, name: id.slice(0, 2), serverId, kind: "backend", status: "running", desiredState: "running", deployTarget: "server", quiescedByJobId: null,
  currentDeploymentId: `dep-${id}`, containerStartedAt: null, deployments: [], statusItems: [{ statusPage: { enabled: true } }], domains: [{ hostname: `${id.slice(0, 2)}.example.com`, dnsStatus: "ok" }],
  primaryDomain: null, port: 3000, healthCheckPath: null, environmentId: id === APP_A ? ENV_A : ENV_B, ...over,
});
const deployment = (id: string, appId: string, serverId: string, imageId: string, over: Row = {}) => ({
  id, appId, serverId, imageId, status: "ready", previewId: null, createdAt: new Date(0), provider: "dockify", ...over,
});

function world(over: Partial<Record<"app" | "deployment" | "previewEnv" | "previewDeployment" | "environment" | "job" | "alertEvent", Row[]>> = {}) {
  const t = {
    app: table(over.app ?? [app(APP_A, A), app(APP_B, B)]),
    deployment: table(over.deployment ?? [deployment(`dep-${APP_A}`, APP_A, A, IMG_A), deployment(`dep-${APP_B}`, APP_B, B, IMG_B)]),
    previewEnv: table(over.previewEnv ?? []),
    previewDeployment: table(over.previewDeployment ?? []),
    environment: table(over.environment ?? []),
    job: table(over.job ?? []),
    alertEvent: table(over.alertEvent ?? []),
    alertRule: table([]),
    alertMute: table([]),
    metricSample: table([]),
    appUptimeDay: table([]),
    volume: table([]),
    activityLog: table([]),
    instance: table([{ id: 1, hostDisk: null, hostDiskAt: null, dashboardDomain: null, dashboardPreviousHosts: [], dashboardLastChange: null }]),
    integration: table([]),
    scheduledJobRun: table([]),
    secret: table([]),
  };
  const db = {
    ...t,
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ "?column?": 1 }],
    $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { db: db as unknown as Db, ...t };
}

const summary = (appId: string, id = "c".repeat(64)): ContainerSummary => ({ Id: id, Names: [`/dk-${appId}`], Labels: { "dockify.app": appId, "dockify.role": "app" }, State: "running", Status: "", Created: 1 });
const running = { Id: "x", RestartCount: 0, State: { Status: "running", Running: true, Restarting: false, StartedAt: "2026-01-01T00:00:00Z" } };
const sampledState = (appIds: string[]) => {
  const state = newSamplerState();
  state.dockerSeen = true;
  state.listedAt = Date.now();
  state.listed = new Set(appIds);
  for (const id of appIds) state.apps.set(id, { at: new Date(), containerId: "c", state: "running", health: null, startedAt: null, restartCount: 0, cpuPct: 1, memBytes: 1, memLimitBytes: 0 });
  return state;
};

let dirA = "";
let dirB = "";
beforeEach(async () => {
  dirA = await mkdtemp(join(tmpdir(), "dk-here-a-"));
  dirB = await mkdtemp(join(tmpdir(), "dk-here-b-"));
});
afterEach(async () => {
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
});
const files = (dir: string) => readdir(join(dir, "conf")).catch(() => [] as string[]);
const TUNNEL = { ingress: "cloudflare_tunnel" } as const;

const edgeDeps = (w: ReturnType<typeof world>, serverId: string, dir: string): EdgeDeps => ({
  db: w.db, vault: {} as never, serverId, routes: fileRouteStore(dir), mode: TUNNEL,
  settings: { mode: TUNNEL, dashboardHost: "dash.example.com", serverIpv4: null, serverIpv6: null, acmeEmail: null, acmeCaServer: null },
  routeTarget: async (id) => ({ backend: `dk-route-${id}`, network: "dockify-env-x" }),
  imagePort: async () => null,
  joinProxy: async () => {},
  dns: { resolve4: async () => [], resolveCname: async () => [] },
  tls: async () => { throw new Error("no TLS here"); },
});

describe("appsHere", () => {
  it("is the one where fragment", () => {
    expect(appsHere(A)).toEqual({ serverId: A });
  });
});

describe("the status of an app on the other server", () => {
  it("app status: nothing here reads missing, and only this server's apps are written", async () => {
    const w = world();
    // Server B's listing shows B's app; A's is not on this machine, so it must not read missing.
    expect(await reconcileAppStatus(w.db, B, sampledState([]), { maxAgeMs: 60_000 })).toBe(1);
    expect(w.app.rows.find((a) => a.id === APP_A)!.status).toBe("running");
    expect(w.app.rows.find((a) => a.id === APP_B)!.status).toBe("missing");
  });

  it("uptime: no minute is written for it", async () => {
    const w = world();
    expect(await recordUptimeMinute(w.db, B, sampledState([APP_B]))).toBe(1);
    expect(w.appUptimeDay.rows.map((r) => r.appId)).toEqual([APP_B]);
  });

  it("alerts: it never reads as down here, and its open event is left to its own server", async () => {
    const OPEN = "0d0d0d0d-0000-4000-8000-00000000000a";
    const w = world({
      alertEvent: [{ id: OPEN, ruleId: "rule-a", metric: "down", appId: APP_A, service: null, state: "firing", app: { serverId: A } }],
    });
    w.alertRule.rows.push({ id: "rule-a", metric: "down", appId: null, service: null, threshold: null, durationMin: 0, channels: [], webhooks: [], enabled: true });
    const runner = createAlertRunner(w.db, { serverId: B, proxyUp: async () => null }, sampledState([APP_B]), { probes: { api: null, proxy: null } } as never);
    expect(await runner.tick()).toEqual({ opened: 0, resolved: 0 });
    expect(w.alertEvent.rows[0]!.state).toBe("firing");
  });

  it("alerts: with no container listed here, only this server's app opens an event", async () => {
    const w = world();
    w.alertRule.rows.push({ id: "rule-a", metric: "down", appId: null, service: null, threshold: null, durationMin: 0, channels: [], webhooks: [], enabled: true });
    const runner = createAlertRunner(w.db, { serverId: B, proxyUp: async () => null }, sampledState([]), { probes: { api: null, proxy: null } } as never);
    expect((await runner.tick()).opened).toBe(1);
    expect(w.alertEvent.rows.map((e) => e.appId)).toEqual([APP_B]);
  });

  it("reachability: it is not probed through this server's proxy", async () => {
    const w = world();
    expect((await reachTargets(w.db, B)).map((t) => t.appId)).toEqual([APP_B]);
  });
});

describe("the sampler", () => {
  const reader = (list: ContainerSummary[]): DockerReader => ({
    listManaged: async () => list,
    listFiltered: async () => [],
    inspect: async () => running as never,
    stats: async () => ({ memory_stats: { usage: 1 }, pids_stats: { current: 1 } }),
    followLogs: async () => { throw new Error("not followed"); },
  });
  const host = async () => ({ cpu: null, memUsedBytes: 1, memTotalBytes: 2, disk: null, net: null });

  it("a container labelled for an app on the other server writes no sample and no state", async () => {
    const w = world();
    const sampler = createSampler(w.db, { serverId: B, docker: reader([summary(APP_A, "a".repeat(64)), summary(APP_B, "b".repeat(64))]), host }, () => {});
    await sampler.tick();
    expect([...sampler.state.apps.keys()]).toEqual([APP_B]);
    expect([...sampler.state.listed]).toEqual([APP_B]);
    expect(w.metricSample.rows.map((r) => r.appId)).toEqual([APP_B]);
  });
});

describe("routes", () => {
  it("the boot resync writes only this server's apps, in this server's folder", async () => {
    const w = world();
    expect((await resyncRoutes(edgeDeps(w, B, dirB))).apps).toBe(1);
    expect(await files(dirB)).toEqual([`${APP_B}.yml`]);
    expect(await files(dirA)).toEqual([]);
  });

  it("a route sync of an app now on the other server writes nothing here, and clears a stray file", async () => {
    const w = world();
    const d = edgeDeps(w, B, dirB);
    expect(await syncAppRoute(d, APP_A)).toBe("removed");
    expect(await files(dirB)).toEqual([]);
    await writeRoute(d.routes, { id: APP_A, port: 80, hosts: ["a.example.com"] }, "dk-route-x", TUNNEL, new Set());
    await syncAppRoute(d, APP_A);
    expect(await readRoute(d.routes, APP_A)).toBeNull();
  });

  it("the reconcile sweeps what is not this server's, keeps what is, and queues only its own apps", async () => {
    const w = world();
    const previewHere = "0c0c0c0c-0000-4000-8000-00000000000b";
    const previewThere = "0c0c0c0c-0000-4000-8000-00000000000a";
    w.previewDeployment.rows.push(
      { id: previewHere, env: { status: "ready" }, app: { serverId: B } },
      { id: previewThere, env: { status: "ready" }, app: { serverId: A } },
    );
    const d = edgeDeps(w, B, dirB);
    await mkdir(join(dirB, "conf"), { recursive: true });
    for (const f of [`${APP_B}.yml`, `${APP_A}.yml`, `pv-${previewHere}.yml`, `pv-${previewThere}.yml`]) await writeFile(join(dirB, "conf", f), "{}");
    // The other server's folder is its own: nothing here may reach it.
    await mkdir(join(dirA, "conf"), { recursive: true });
    await writeFile(join(dirA, "conf", `${APP_A}.yml`), "{}");
    await edgeServerHandlers(d).reconcile!({ payload: {} } as ClaimedJob, new AbortController().signal);
    expect((await files(dirB)).sort()).toEqual([`${APP_B}.yml`, `pv-${previewHere}.yml`].sort());
    expect(await files(dirA)).toEqual([`${APP_A}.yml`]);
    expect(w.job.rows.map((j) => (j.payload as { appId: string }).appId)).toEqual([APP_B]);
    expect(w.job.rows.map((j) => j.serverId)).toEqual([B]);
  });
});

describe("images", () => {
  const image = (Id: string, over: Row = {}) => ({ Id, RepoTags: [] as string[], Labels: null, Size: 1, Created: 1, ...over });
  const dockerWith = (images: Array<ReturnType<typeof image>>) => {
    const removed: string[] = [];
    const inspected: string[] = [];
    return {
      removed,
      inspected,
      docker: {
        listImages: async (labels: Record<string, string>) => (Object.keys(labels).length ? [] : images),
        removeImage: async (id: string) => void removed.push(id),
        inspectImage: async (id: string) => {
          inspected.push(id);
          return image(id);
        },
      },
    };
  };
  const config = { keepReady: 1, deploymentRetentionDays: 36500, buildCacheBytes: 1024 ** 3 } as DeployConfig;

  it("the janitor never reaches for an image only the other server's deployments name", async () => {
    const w = world({
      deployment: [
        deployment(`dep-${APP_A}`, APP_A, A, IMG_A),
        // Past retention on A: A's janitor removes it, B's has no business asking its Docker about it.
        deployment("dep-old-a", APP_A, A, `sha256:${"c".repeat(64)}`, { status: "failed", createdAt: new Date(1) }),
        deployment(`dep-${APP_B}`, APP_B, B, IMG_B),
      ],
    });
    const d = dockerWith([image(IMG_B)]);
    await runJanitor({ db: w.db, docker: d.docker as never, config, serverId: B, builder: { trimCache: async () => "" } });
    expect(d.inspected).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(w.deployment.rows).toHaveLength(3);
  });

  it("the janitor keeps its own server's current image while the other server's rows say nothing about it", async () => {
    const w = world();
    const d = dockerWith([image(IMG_A), image(IMG_B)]);
    await runJanitor({ db: w.db, docker: d.docker as never, config, serverId: A, builder: { trimCache: async () => "" } });
    expect(d.removed).not.toContain(IMG_A);
  });

  it("a tagged build reads as gone only when its app is not on this server, and removes only here", async () => {
    const w = world();
    const d = dockerWith([image(IMG_A, { RepoTags: [`dockify/app-${APP_A}:1`] }), image(IMG_B, { RepoTags: [`dockify/app-${APP_B}:1`] })]);
    await removeDeletedAppImages(w.db, d.docker, B);
    expect(d.removed).toEqual([`dockify/app-${APP_A}:1`]);
  });

  it("the prune leaves an image only the other server's deployments call its own", async () => {
    const OLD_A = `sha256:${"c".repeat(64)}`;
    const w = world({
      deployment: [
        deployment(`dep-${APP_A}`, APP_A, A, IMG_A),
        // Past its rollback slots on A: A's prune may take it. To B it is nobody's.
        deployment("dep-old-a", APP_A, A, OLD_A, { status: "failed" }),
        deployment(`dep-${APP_B}`, APP_B, B, IMG_B),
      ],
    });
    const df = { LayersSize: 3, Images: [
      { Id: OLD_A, RepoTags: [], Labels: null, Created: 1, Size: 1, SharedSize: 0, Containers: 0 },
      { Id: IMG_A, RepoTags: [], Labels: null, Created: 1, Size: 1, SharedSize: 0, Containers: 0 },
      { Id: IMG_B, RepoTags: [], Labels: null, Created: 1, Size: 1, SharedSize: 0, Containers: 0 },
    ] };
    const removed: string[] = [];
    const deps = {
      db: w.db, serverId: B, config, log: () => {},
      docker: { diskUsage: async () => df, removeImage: async (id: string) => void removed.push(id) },
      builder: { cacheUsage: async () => "null", pruneCache: async () => "" },
    };
    w.job.rows.push({ id: "prune" });
    await runPrune(deps, { id: "prune", payload: { targets: ["images"] } });
    // B's own deployment keeps its image; A's is on no row of B, so it is not Dockify's to remove here.
    expect(removed).toEqual([]);
    await runPrune({ ...deps, serverId: A }, { id: "prune", payload: { targets: ["images"] } });
    expect(removed).toEqual([OLD_A]);
  });

  it("removing an app keeps an image only while a deployment on this server still names it", async () => {
    const w = world();
    const remove = async (serverId: string) => {
      const d = dockerWith([]);
      await removeApp({
        db: w.db, docker: { ...d.docker, listContainers: async () => [] } as never, routes: fileRouteStore(dirB), removeVolume: async () => {},
      }, { appId: "0f0f0f0f-0000-4000-8000-0000000000ff", volumeNames: [], domains: [], imageIds: [IMG_A] }, serverId);
      return d.removed;
    };
    expect(await remove(A)).toEqual([]);
    expect(await remove(B)).toEqual([IMG_A]);
  });
});

describe("networks", () => {
  const fakeDocker = () => {
    const removed: string[] = [];
    return {
      removed,
      docker: {
        listEnvNetworks: async () => [`dockify-env-${ENV_A}`, `dockify-env-${ENV_B}`, `dockify-env-${ENV_BOTH}`],
        inspectNetwork: async (name: string) => ({ Name: name, Containers: {} }),
        disconnectNetwork: async () => {},
        removeNetwork: async (name: string) => void removed.push(name),
        listContainers: async () => [],
      },
    };
  };
  const environments = () => [
    { id: ENV_A, apps: [{ serverId: A }] },
    { id: ENV_B, apps: [{ serverId: B }] },
    { id: ENV_BOTH, apps: [{ serverId: A }, { serverId: B }] },
  ];

  it("an environment's network stays on every server with an app of it, and goes from one with none", async () => {
    const w = world({ environment: environments() });
    const a = fakeDocker();
    await sweepEnvNetworks({ db: w.db, serverId: A, docker: a.docker as never, ownContainers: [] });
    expect(a.removed).toEqual([`dockify-env-${ENV_B}`]);
    const b = fakeDocker();
    await sweepEnvNetworks({ db: w.db, serverId: B, docker: b.docker as never, ownContainers: [] });
    expect(b.removed).toEqual([`dockify-env-${ENV_A}`]);
  });
});

describe("previews", () => {
  const ENV_THERE = "0d0d0d0d-0000-4000-8000-0000000000aa";
  const ENV_HERE = "0d0d0d0d-0000-4000-8000-0000000000bb";
  const MEMBER_THERE = "0c0c0c0c-0000-4000-8000-0000000000aa";
  const MEMBER_HERE = "0c0c0c0c-0000-4000-8000-0000000000bb";
  const env = (id: string, member: string, serverId: string, over: Row = {}) => ({
    id, status: "ready", isolatedDb: false, lastCommitAt: new Date(), lastRequestAt: null, sleptAt: null, updatedAt: new Date(), requestCount: 0n,
    project: { previewEnabled: true, archivedAt: null, previewTtlHours: 1000, previewIdleMinutes: 0 },
    apps: [{ id: member, containerId: null, app: { serverId } }],
    ...over,
  });
  const deps = (w: ReturnType<typeof world>, serverId: string, dir: string, containers: ContainerSummary[] = []): PreviewRuntimeDeps & { removedContainers: string[] } => {
    const removedContainers: string[] = [];
    return {
      removedContainers,
      db: w.db, serverId, routes: fileRouteStore(dir), mode: TUNNEL, proxyContainer: "dockify-proxy", dashboardHost: "dash.example.com",
      docker: { listContainers: async () => containers, removeContainer: async (id: string) => void removedContainers.push(id) } as never,
      counters: async () => new Map([[`pv-${MEMBER_THERE}`, 5], [`pv-${MEMBER_HERE}`, 5]]),
    };
  };

  it("a reconcile on one server does not retire, count or sweep a preview on the other", async () => {
    const w = world({
      // Retired if read here: its project turned previews off.
      previewEnv: [env(ENV_THERE, MEMBER_THERE, A, { project: { previewEnabled: false, archivedAt: null, previewTtlHours: 1000, previewIdleMinutes: 0 } }), env(ENV_HERE, MEMBER_HERE, B)],
    });
    await mkdir(join(dirB, "conf"), { recursive: true });
    await writeFile(join(dirB, "conf", `pv-${MEMBER_HERE}.yml`), "{}");
    const report = await reconcilePreviews(deps(w, B, dirB));
    expect(report.retired).toEqual([]);
    expect(report.routesRemoved).toBe(0);
    expect(w.previewEnv.rows.find((e) => e.id === ENV_THERE)!.status).toBe("ready");
    expect(w.previewEnv.rows.find((e) => e.id === ENV_THERE)!.requestCount).toBe(0n);
    expect(w.previewEnv.rows.find((e) => e.id === ENV_HERE)!.requestCount).toBe(5n);
    expect(w.job.rows.some((j) => j.kind === "preview_cleanup")).toBe(false);
    expect(await files(dirB)).toEqual([`pv-${MEMBER_HERE}.yml`]);
  });

  it("the sweep on its own server still finds the preview's route and container", async () => {
    const w = world({ previewEnv: [env(ENV_HERE, MEMBER_HERE, B)] });
    const c = { ...summary(APP_B, "e".repeat(64)), Labels: { "dockify.preview": ENV_HERE, "dockify.preview.app": MEMBER_HERE, "dockify.role": "preview" } };
    await mkdir(join(dirB, "conf"), { recursive: true });
    await writeFile(join(dirB, "conf", `pv-${MEMBER_HERE}.yml`), "{}");
    const d = deps(w, B, dirB, [c]);
    expect((await reconcilePreviews(d)).containersRemoved).toBe(0);
    expect(await files(dirB)).toEqual([`pv-${MEMBER_HERE}.yml`]);
    expect(d.removedContainers).toEqual([]);
  });
});

describe("what crashed work leaves behind", () => {
  const BACKUP = "0b0b0b0b-1111-4000-8000-000000000001";
  const scratchDocker = () => {
    const removed: string[] = [];
    return {
      removed,
      docker: {
        cpuCores: 4,
        list: async () => [],
        remove: async () => {},
        removeVolume: async (name: string) => void removed.push(name),
      } as unknown as DockerPort,
    };
  };

  it("a restore test live on the other server does not keep this server's copy, and one live here does", async () => {
    const volume = { Name: `dk-rt-${BACKUP}`, Labels: null, UsageData: { Size: 1, RefCount: 0 } };
    const job = (serverId: string) => ({ kind: "restore_test", serverId, dedupeKey: `restore-test:${BACKUP}`, completedAt: null, failedAt: null, lockedUntil: new Date(Date.now() + 60_000) });
    const elsewhere = scratchDocker();
    await sweepLeftovers({ db: world({ job: [job(A)] }).db, serverId: B, docker: elsewhere.docker, volumes: async () => [volume], log: () => {} });
    expect(elsewhere.removed).toEqual([`dk-rt-${BACKUP}`]);
    const here = scratchDocker();
    await sweepLeftovers({ db: world({ job: [job(B)] }).db, serverId: B, docker: here.docker, volumes: async () => [volume], log: () => {} });
    expect(here.removed).toEqual([]);
  });

  it("a restore that died on the other server starts nothing here", async () => {
    const started: string[] = [];
    const job = { id: "j", serverId: A, kind: "restore", createdAt: new Date(), failedAt: new Date(), completedAt: null, attempts: 1, maxAttempts: 1, payload: { quiesced: [APP_A] } };
    const w = world({ job: [job] });
    const deps = { db: w.db, docker: { start: async (n: string) => void started.push(n) } } as unknown as DataDeps;
    expect(await recoverQuiesced(deps, new Date(), B)).toBe(0);
    expect(started).toEqual([]);
    expect((job.payload as { resumedAt?: string }).resumedAt).toBeUndefined();
  });

  it("an older service on the other server is not queued for the managed path from here", async () => {
    const w = world({ app: [app(APP_A, A, { kind: "redis" }), app(APP_B, B, { kind: "postgres" })] });
    const inspected: string[] = [];
    const deps = { db: w.db, docker: { inspect: async (n: string) => { inspected.push(n); return null; } } } as unknown as DataDeps;
    await upgradeLegacyServices(deps, B);
    expect(inspected).toEqual([`dk-${APP_B}`]);
  });

  /** A $queryRaw that runs the one check the SQL makes of a server: rows with that server id. */
  const rawFor = (rows: Array<Row & { serverId: string }>) => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    expect(strings.join("?")).toContain(`"serverId" = `);
    return rows.filter((r) => values.includes(r.serverId));
  };

  it("the deploy sweep settles only this server's orphans", async () => {
    const w = world({
      deployment: [
        { id: "orphan-a", appId: APP_A, serverId: A, previewId: null, status: "building", steps: [] },
        { id: "orphan-b", appId: APP_B, serverId: B, previewId: null, status: "building", steps: [] },
      ],
    });
    (w.db as unknown as Row).$queryRaw = rawFor(w.deployment.rows as never);
    const docker = { inspectContainer: async () => { throw new Error("no docker here"); } };
    expect(await settleOrphanedDeployments({ db: w.db, docker: docker as never, serverId: B })).toEqual(["orphan-b"]);
    expect(w.deployment.rows.find((d) => d.id === "orphan-a")!.status).toBe("building");
  });

  it("the scheduled run sweep settles only this server's", async () => {
    const asked: string[] = [];
    const db = {
      $queryRaw: rawFor([{ id: "run-a", serverId: A }, { id: "run-b", serverId: B }]),
      scheduledJobRun: {
        findUnique: async (a: { where: { id: string } }) => {
          asked.push(a.where.id);
          return null;
        },
      },
    } as unknown as Db;
    await settleOrphanRuns(db, { removeContainer: async () => {} }, B);
    expect(asked).toEqual(["run-b"]);
  });
});

describe("isPrimary", () => {
  const SRC = join(import.meta.dirname, "..");
  /** Where a server's being the first may be read at all (design 5.2). */
  const ALLOWED = new Set(["link/enroll.ts", "server/registry.ts"]);
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });

  it("appears in the worker only where the design allows: everything else asks by server id", () => {
    const found = sources(SRC).filter((f) => readFileSync(f, "utf8").includes("isPrimary")).map((f) => relative(SRC, f).split(sep).join("/"));
    expect(found.filter((f) => !ALLOWED.has(f))).toEqual([]);
  });
});
