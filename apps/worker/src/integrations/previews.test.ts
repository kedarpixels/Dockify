import { mkdtemp, mkdir, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreviewStatus } from "@dockify/db";
import { computeRetention } from "../deploy/janitor.ts";
import { firstErrorLine, FORK_NETWORK, previewContainerInput, previewStatusOf, previewVars, previewWildcard, type PreviewContext } from "../deploy/preview.ts";
import { commentFor, statusFor, type FeedbackView } from "./preview-feedback.ts";
import {
  parseRequestCounters, planDockerSweep, planReconcile, reconcilePreviews, runPreviewCleanup, runPreviewWake, sleepPreview,
  STUCK_CLOSING_MS, type PreviewFacts,
} from "./previews.ts";
import { fileRouteStore } from "@dockify/engine";

const now = new Date("2026-10-30T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const H = 3600_000;
const M = 60_000;

const facts = (o: Partial<PreviewFacts>): PreviewFacts => ({
  id: "p", status: "ready", projectEnabled: true, projectArchived: false, lastCommitAt: ago(H), lastRequestAt: ago(M), sleptAt: null,
  updatedAt: ago(M), ttlHours: 72, idleMinutes: 30, cleanupQueued: false, ...o,
});

describe("reconcile plan", () => {
  it("leaves a fresh, used preview alone", () => {
    expect(planReconcile([facts({})], now, true)).toEqual({ retire: [], sleep: [], requeue: [] });
  });
  it("deletes after the TTL without a commit, and when previews are off or the project archived", () => {
    const plan = planReconcile([
      facts({ id: "ttl", lastCommitAt: ago(72 * H) }),
      facts({ id: "ttl-asleep", status: "asleep", lastCommitAt: ago(80 * H) }),
      facts({ id: "blocked-ttl", status: "blocked", lastCommitAt: ago(73 * H) }),
      facts({ id: "off", projectEnabled: false }),
      facts({ id: "arch", projectArchived: true }),
      facts({ id: "young", lastCommitAt: ago(71 * H) }),
    ], now, true);
    expect(plan.retire).toEqual([
      { id: "ttl", reason: "ttl" }, { id: "ttl-asleep", reason: "ttl" }, { id: "blocked-ttl", reason: "ttl" },
      { id: "off", reason: "disabled" }, { id: "arch", reason: "disabled" },
    ]);
  });
  it("sleeps a ready preview after idleMinutes without a request, only when traffic is known", () => {
    const idle = facts({ id: "idle", lastCommitAt: ago(2 * H), lastRequestAt: ago(31 * M) });
    expect(planReconcile([idle], now, true).sleep).toEqual(["idle"]);
    expect(planReconcile([idle], now, false).sleep).toEqual([]);
    expect(planReconcile([{ ...idle, idleMinutes: 0 }], now, true).sleep).toEqual([]);
    expect(planReconcile([{ ...idle, status: "building" }], now, true).sleep).toEqual([]);
    // A recent commit counts as activity.
    expect(planReconcile([{ ...idle, lastCommitAt: ago(5 * M) }], now, true).sleep).toEqual([]);
  });
  it("re-queues a teardown that was lost, not one still queued or just started", () => {
    expect(planReconcile([facts({ id: "c", status: "closing", updatedAt: ago(STUCK_CLOSING_MS) })], now, true).requeue).toEqual(["c"]);
    expect(planReconcile([facts({ id: "c", status: "closing", updatedAt: ago(STUCK_CLOSING_MS), cleanupQueued: true })], now, true).requeue).toEqual([]);
    expect(planReconcile([facts({ id: "c", status: "closing", updatedAt: ago(1000) })], now, true).requeue).toEqual([]);
  });
});

const c = (id: string, labels: Record<string, string>) => ({ Id: id, Names: [`/${id}`], Image: "x", ImageID: "x", State: "running", Labels: { "dockify.managed": "true", ...labels } as Record<string, string> });

describe("docker sweep plan", () => {
  const E1 = "11111111-1111-1111-1111-111111111111";
  const M1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const M2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  it("keeps what a live preview holds and removes everything else labelled as a preview", () => {
    const containers = [
      c("app", { "dockify.app": "x" }),
      c("keep", { "dockify.preview": E1, "dockify.preview.app": M1, "dockify.role": "preview" }),
      c("dropped-member", { "dockify.preview": E1, "dockify.preview.app": M2, "dockify.role": "preview" }),
      c("db", { "dockify.preview": E1, "dockify.role": "preview-db" }),
      c("orphan", { "dockify.preview": "99999999-9999-9999-9999-999999999999", "dockify.role": "preview" }),
    ];
    const out = planDockerSweep(containers, [`pv-${M1}.yml`, `pv-${M2}.yml`, "app.yml", "__edge.yml"], { envs: [{ id: E1, status: "ready", isolatedDb: false, members: [M1] }] });
    expect(out.containers).toEqual(["dropped-member", "db", "orphan"]);
    expect(out.routes).toEqual([`pv-${M2}.yml`]);
  });
  it("an asleep preview keeps its stopped containers and its asleep page's route; a closed one keeps nothing", () => {
    const containers = [c("k", { "dockify.preview": E1, "dockify.preview.app": M1, "dockify.role": "preview" })];
    expect(planDockerSweep(containers, [`pv-${M1}.yml`], { envs: [{ id: E1, status: "asleep", isolatedDb: false, members: [M1] }] })).toEqual({ containers: [], routes: [] });
    expect(planDockerSweep(containers, [], { envs: [{ id: E1, status: "closed", isolatedDb: false, members: [M1] }] }).containers).toEqual(["k"]);
  });
});

describe("request counters", () => {
  it("sums Traefik's per-service counters for preview routes only", () => {
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const text = [
      "# TYPE traefik_service_requests_total counter",
      `traefik_service_requests_total{code="200",method="GET",protocol="http",service="pv-${id}@file"} 12`,
      `traefik_service_requests_total{code="404",method="GET",protocol="http",service="pv-${id}@file"} 3`,
      `traefik_service_requests_total{code="200",method="GET",protocol="http",service="someapp@file"} 99`,
    ].join("\n");
    expect([...parseRequestCounters(text)]).toEqual([[`pv-${id}`, 15]]);
  });
});

describe("preview env and container", () => {
  const vars = [
    { key: "API_KEY", value: "s3cret", isSecret: true, target: "both" as const },
    { key: "DATABASE_URL", value: "postgresql://dev", isSecret: true, target: "both" as const },
    { key: "PUBLIC_NAME", value: "shop", isSecret: false, target: "both" as const },
  ];
  const ctx = { isolation: "base" as const, prNumber: 7, hostname: "pr-7-web.preview.example.com" };
  it("a fork never gets a secret", () => {
    const out = previewVars(vars, { ...ctx, isolation: "fork" }, null);
    expect(out.some((v) => v.isSecret)).toBe(false);
    expect(out.map((v) => v.key)).toEqual(["DOCKIFY_PREVIEW", "DOCKIFY_PREVIEW_PR", "DOCKIFY_PREVIEW_URL", "PUBLIC_NAME"]);
  });
  it("an isolated database replaces the base environment's", () => {
    const out = previewVars(vars, ctx, { url: "postgresql://preview:x@dk-pvdb-1:5432/preview", host: "dk-pvdb-1", port: 5432, user: "preview", password: "x", database: "preview" });
    expect(out.find((v) => v.key === "DATABASE_URL")?.value).toBe("postgresql://preview:x@dk-pvdb-1:5432/preview");
    expect(out.find((v) => v.key === "API_KEY")?.value).toBe("s3cret");
  });
  it("runs with the preview limits, no volume and no added capability, never the app's name", () => {
    const pctx: PreviewContext = { pdId: "m1", envId: "e1", projectId: "p1", prNumber: 7, hostname: ctx.hostname, fromFork: true, isolatedDb: false, isolation: "fork", network: FORK_NETWORK, limits: { cpu: 0.5, memoryMb: 512, pids: 128 } };
    const input = previewContainerInput({ id: "app", port: 3000, startCommand: null, health: { path: null, expectedStatus: 200, timeoutSeconds: 5, graceSeconds: 1, intervalSeconds: 1, windowSeconds: 10 } }, pctx, { name: "dk-pv-m1-dep", imageId: "sha256:x", env: {}, deploymentId: "dep" });
    expect(input).toMatchObject({ network: FORK_NETWORK, cpuCores: 0.5, memoryMb: 512, pidsLimit: 128, capAdd: [], volumes: [], aliases: ["dk-pv-m1-dep"] });
    // Blanked, not absent: the built image bakes dockify.app=<base app id>, so the container must
    // override it to "" or observe would treat the preview as the production app.
    expect(input.labels?.["dockify.app"]).toBe("");
    expect(input.labels?.["dockify.preview"]).toBe("e1");
  });
  it("derives the preview status and the first error line", () => {
    expect(previewStatusOf(["ready", "building"])).toBe("building");
    expect(previewStatusOf(["ready", "failed"])).toBe("failed");
    expect(previewStatusOf(["ready", "ready"])).toBe("ready");
    expect(firstErrorLine("\n  npm ERR! missing script: build\nmore")).toBe("npm ERR! missing script: build");
  });
  it("uses one wildcard certificate per preview domain when DNS-01 is configured", () => {
    expect(previewWildcard("pr-7-web.preview.example.com", "ledns")).toEqual({ domain: "preview.example.com", certResolver: "ledns" });
    expect(previewWildcard("pr-7-web.preview.example.com", null)).toBeUndefined();
  });
});

describe("rollback images", () => {
  it("preview deployments never take one of the app's rollback slots", () => {
    const d = (id: string, minutes: number, previewId: string | null = null) => ({ id, appId: "a", status: "ready", imageId: `sha256:${id}`, createdAt: ago(minutes * M), previewId });
    const rows = [d("p1", 1, "m"), d("p2", 2, "m"), d("r1", 3), d("r2", 4), d("r3", 5)];
    const plan = computeRetention(rows, new Set(), 2, now);
    expect([...plan.keepImages].sort()).toEqual(["sha256:r1", "sha256:r2"]);
    // The preview's current deployment is kept as long as the preview lives.
    expect(computeRetention(rows, new Set(["p1"]), 2, now).keepImages.has("sha256:p1")).toBe(true);
  });
});

describe("PR feedback", () => {
  const view = (o: Partial<FeedbackView>): FeedbackView => ({
    prNumber: 42, status: "building", reason: null, error: null, lines: [], updatedAt: new Date("2026-11-06T14:05:00Z"), fromFork: false, isolatedDb: false, isolation: "base", baseEnvironment: "development",
    apps: [{ name: "web", url: "https://pr-42-web.preview.example.com" }], dashboardUrl: "https://dash.example.com/projects/shop?tab=previews", idleMinutes: 30, ttlHours: 72, ...o,
  });
  it("maps every state to a commit status", () => {
    expect(statusFor(view({}))).toMatchObject({ state: "pending", description: "Building pr-42" });
    expect(statusFor(view({ status: "ready" }))).toMatchObject({ state: "success", description: "Ready at https://pr-42-web.preview.example.com", target: "https://pr-42-web.preview.example.com" });
    expect(statusFor(view({ status: "failed", error: "npm ERR! missing script: build" }))).toMatchObject({ state: "failure", description: "Failed: npm ERR missing script: build" });
    expect(statusFor(view({ status: "asleep" })).description).toBe("Asleep, push or press Wake");
    expect(statusFor(view({ status: "failed", error: "x".repeat(300) })).description.length).toBeLessThanOrEqual(140);
  });
  it("renders one sticky comment that says asleep, evicted, blocked and deleted", () => {
    expect(commentFor(view({ status: "asleep" }))).toContain("⚪ [Asleep]");
    expect(commentFor(view({ status: "closed", reason: "evicted" }))).toContain("evicted to make room");
    expect(commentFor(view({ status: "blocked", error: "disk is 91% full" }))).toContain("Not started: `disk is 91% full`");
    expect(commentFor(view({ status: "closed", reason: "merged" }))).toContain("Removed: the pull request was merged");
    expect(commentFor(view({ fromFork: true }))).toContain("without any secret");
    expect(commentFor(view({})).startsWith("<!-- dockify-preview -->")).toBe(true);
  });
});

// ------------------------------------------------------------------ no preview leaks

/**
 * An in-memory server: preview rows, jobs, containers and route files. Enough of Prisma and the
 * Docker API for the cleanup, sleep, wake and reconcile paths.
 */
interface Env {
  id: string;
  status: PreviewStatus;
  isolatedDb: boolean;
  lastCommitAt: Date;
  lastRequestAt: Date | null;
  sleptAt: Date | null;
  updatedAt: Date;
  requestCount: bigint | null;
  closedAt?: Date | null;
  reason?: string | null;
  project: { previewEnabled: boolean; archivedAt: Date | null; previewTtlHours: number; previewIdleMinutes: number };
  apps: Array<{ id: string; appId: string; hostname: string; containerId: string | null; app: { port: number | null }; deployments: Array<{ id: string; status: string; imageId: string }> }>;
}

function world(dir: string) {
  const envs = new Map<string, Env>();
  const jobs: Array<{ id: string; kind: string; dedupeKey: string; payload: { previewId?: string }; completedAt: Date | null; failedAt: Date | null; lockedBy: string | null }> = [];
  const containers: Array<ReturnType<typeof c> & { running: boolean }> = [];
  const images = new Set<string>();
  const deployments = () => [...envs.values()].flatMap((e) => e.apps.flatMap((m) => m.deployments.map((d) => ({ ...d, previewId: m.id }))));

  const previewEnv = {
    findMany: async ({ where }: { where?: { status?: { not?: string } } } = {}) => [...envs.values()].filter((e) => !where?.status?.not || e.status !== where.status.not),
    findUnique: async ({ where }: { where: { id: string } }) => envs.get(where.id) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Partial<Env> }) => {
      const e = envs.get(where.id)!;
      Object.assign(e, data, { updatedAt: new Date() });
      return e;
    },
    updateMany: async ({ where, data }: { where: { id: string; status?: string }; data: Partial<Env> }) => {
      const e = envs.get(where.id);
      if (!e || (where.status && e.status !== where.status)) return { count: 0 };
      Object.assign(e, data, { updatedAt: new Date() });
      return { count: 1 };
    },
  };
  const tx = {
    $executeRaw: async () => 0,
    previewEnv,
    previewDeployment: {
      updateMany: async ({ where, data }: { where: { envId: string }; data: object }) => {
        for (const m of envs.get(where.envId)?.apps ?? []) Object.assign(m, data);
        return { count: 1 };
      },
      update: async () => ({}),
      findMany: async () => [],
    },
    job: {
      findFirst: async ({ where }: { where: { dedupeKey: string; lockedBy?: null } }) => jobs.find((j) => j.dedupeKey === where.dedupeKey && !j.completedAt && !j.failedAt && (where.lockedBy === undefined || j.lockedBy === null)) ?? null,
      findMany: async ({ where }: { where: { dedupeKey: { in: string[] } } }) => jobs.filter((j) => where.dedupeKey.in.includes(j.dedupeKey) && !j.completedAt && !j.failedAt),
      create: async ({ data }: { data: { kind: string; dedupeKey: string; payload: { previewId?: string } } }) => {
        const j = { id: `j${jobs.length}`, ...data, completedAt: null, failedAt: null, lockedBy: null };
        jobs.push(j);
        return j;
      },
    },
    deployment: {
      findMany: async ({ where }: { where: { id?: { in?: string[]; notIn?: string[] }; imageId?: { in?: string[] } } }) => {
        let rows = deployments();
        if (where.id?.in) rows = rows.filter((d) => where.id!.in!.includes(d.id));
        if (where.id?.notIn) rows = rows.filter((d) => !where.id!.notIn!.includes(d.id));
        if (where.imageId?.in) rows = rows.filter((d) => where.imageId!.in!.includes(d.imageId));
        return rows;
      },
      updateMany: async () => ({ count: 0 }),
      create: async () => ({ id: "dep-new" }),
    },
    server: { findFirst: async () => ({ id: "s1" }) },
  };
  const db = { ...tx, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  const removedVolumes: string[] = [];
  const docker = {
    listContainers: async (labels: Record<string, string>) => containers.filter((x) => Object.entries(labels).every(([k, v]) => x.Labels[k] === v)),
    removeContainer: async (id: string) => {
      const i = containers.findIndex((x) => x.Id === id);
      if (i >= 0) containers.splice(i, 1);
    },
    stopContainer: async (id: string) => void (containers.find((x) => x.Id === id)!.running = false),
    startContainer: async (id: string) => void (containers.find((x) => x.Id === id)!.running = true),
    inspectContainer: async (id: string) => ({ Id: id, Name: `/dk-pv-${id}`, NetworkSettings: { Networks: { "dockify-env-base": { IPAddress: "10.9.0.5" } } } }),
    connectNetwork: async () => undefined,
    removeImage: async (id: string) => void images.delete(id),
    removeVolume: async (name: string) => void removedVolumes.push(name),
  };

  let n = 0;
  const addPreview = async (status: PreviewStatus, o: Partial<Env> = {}) => {
    const id = `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;
    const member = `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, "0")}`;
    const image = `sha256:${String(n).repeat(8)}`;
    images.add(image);
    envs.set(id, {
      id, status, isolatedDb: true, lastCommitAt: ago(H), lastRequestAt: ago(M), sleptAt: null, updatedAt: ago(M), requestCount: null,
      project: { previewEnabled: true, archivedAt: null, previewTtlHours: 72, previewIdleMinutes: 30 },
      apps: [{ id: member, appId: "app", hostname: `pr-${n}-web.preview.example.com`, containerId: `ct-${n}`, app: { port: 3000 }, deployments: [{ id: `dep-${n}`, status: "ready", imageId: image }] }],
      ...o,
    });
    containers.push({ ...c(`ct-${n}`, { "dockify.preview": id, "dockify.preview.app": member, "dockify.role": "preview" }), running: true });
    containers.push({ ...c(`db-${n}`, { "dockify.preview": id, "dockify.role": "preview-db" }), running: true });
    await mkdir(join(dir, "conf"), { recursive: true });
    await writeFile(join(dir, "conf", `pv-${member}.yml`), "{}\n");
    return id;
  };

  /** Runs every open cleanup, wake and feedback job, like the maintenance lane would. */
  const drain = async (deps: Parameters<typeof runPreviewCleanup>[0]) => {
    for (let i = 0; i < 20; i++) {
      const open = jobs.filter((j) => !j.completedAt && !j.failedAt);
      if (!open.length) return;
      for (const j of open) {
        if (j.kind === "preview_cleanup") await runPreviewCleanup(deps, j.payload);
        if (j.kind === "preview_wake") await runPreviewWake(deps, j.payload);
        j.completedAt = new Date();
      }
    }
  };
  return { envs, jobs, containers, images, db, docker, addPreview, drain, removedVolumes };
}

describe("no preview leaks", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("every closed, expired, disabled or orphaned preview ends with no container, route or image left", async () => {
    dir = await mkdtemp(join(tmpdir(), "dk-previews-"));
    const w = world(dir);
    const deps = { db: w.db as never, docker: w.docker as never, serverId: "s1", routes: fileRouteStore(dir), mode: { ingress: "cloudflare_tunnel" } as const, proxyContainer: "dockify-proxy", dashboardHost: "dash.example.com", counters: async () => new Map<string, number>() };

    const keep = await w.addPreview("ready");
    const closedByPr = await w.addPreview("closing", { updatedAt: ago(STUCK_CLOSING_MS) });
    const expired = await w.addPreview("ready", { lastCommitAt: ago(73 * H) });
    const disabled = await w.addPreview("asleep");
    w.envs.get(disabled)!.project.previewEnabled = false;
    const orphan = await w.addPreview("ready");
    // The project was deleted: its rows cascaded away, its containers and route did not.
    w.envs.delete(orphan);

    await reconcilePreviews(deps, now);
    await w.drain(deps);
    await reconcilePreviews(deps, now);

    for (const id of [closedByPr, expired, disabled]) expect(w.envs.get(id)?.status, id).toBe("closed");
    const left = w.containers.map((x) => x.Labels["dockify.preview"]);
    expect([...new Set(left)]).toEqual([keep]);
    const files = (await readdir(join(dir, "conf"))).filter((f) => f.startsWith("pv-"));
    expect(files).toEqual([`pv-${w.envs.get(keep)!.apps[0]!.id}.yml`]);
    // Only the live preview's image is still on the server (the orphan's image is the janitor's).
    expect(w.images.has(`sha256:${"1".repeat(8)}`)).toBe(true);
    expect(w.images.has(`sha256:${"2".repeat(8)}`)).toBe(false);
    expect(w.images.has(`sha256:${"3".repeat(8)}`)).toBe(false);

    // A second pass finds nothing more to do.
    const again = await reconcilePreviews(deps, now);
    expect(again).toMatchObject({ retired: [], requeued: [], containersRemoved: 0, routesRemoved: 0 });
  });

  it("a push that lands while a preview is put to sleep keeps the row building", async () => {
    dir = await mkdtemp(join(tmpdir(), "dk-previews-"));
    const w = world(dir);
    const id = await w.addPreview("ready");
    const docker = { ...w.docker, stopContainer: async (cid: string) => {
      await w.docker.stopContainer(cid);
      w.envs.get(id)!.status = "building";
    } };
    await sleepPreview({ db: w.db as never, docker: docker as never, serverId: "s1", routes: fileRouteStore(dir), mode: { ingress: "cloudflare_tunnel" } as const, proxyContainer: "dockify-proxy", dashboardHost: "dash.example.com" }, id);
    expect(w.envs.get(id)!.status).toBe("building");
    expect(w.envs.get(id)!.sleptAt).toBeNull();
    expect(w.jobs.some((j) => j.kind === "preview_feedback")).toBe(false);
  });

  it("sleeps an idle preview, then wakes it on Wake with its route back", async () => {
    dir = await mkdtemp(join(tmpdir(), "dk-previews-"));
    const w = world(dir);
    const deps = { db: w.db as never, docker: w.docker as never, serverId: "s1", routes: fileRouteStore(dir), mode: { ingress: "cloudflare_tunnel" } as const, proxyContainer: "dockify-proxy", dashboardHost: "dash.example.com" };
    const id = await w.addPreview("ready", { lastCommitAt: ago(3 * H), lastRequestAt: ago(45 * M) });
    const member = w.envs.get(id)!.apps[0]!.id;

    // The proxy counters are read; nothing moved, so the preview is idle.
    const counters = async () => new Map([[`pv-${member}`, 10]]);
    w.envs.get(id)!.requestCount = 10n;
    const r = await reconcilePreviews({ ...deps, counters }, now);
    expect(r.slept).toEqual([id]);
    expect(w.envs.get(id)!.status).toBe("asleep");
    expect(w.containers.every((x) => !x.running)).toBe(true);
    // The route stays, on the page that says it sleeps, never on the stopped container.
    const asleep = await readFile(join(dir, "conf", `pv-${member}.yml`), "utf8");
    expect(asleep).toContain("/.well-known/dockify-preview-asleep");
    expect(asleep).not.toContain("dk-pv-");
    expect(w.jobs.some((j) => j.kind === "preview_feedback")).toBe(true);

    await runPreviewWake(deps, { previewId: id });
    expect(w.envs.get(id)!.status).toBe("ready");
    expect(w.containers.every((x) => x.running)).toBe(true);
    expect(await readdir(join(dir, "conf"))).toContain(`pv-${member}.yml`);

    // Traffic keeps it awake: a moved counter is a request.
    w.envs.get(id)!.status = "ready";
    w.envs.get(id)!.lastRequestAt = ago(45 * M);
    w.envs.get(id)!.requestCount = 10n;
    const busy = await reconcilePreviews({ ...deps, counters: async () => new Map([[`pv-${member}`, 25]]) }, now);
    expect(busy.slept).toEqual([]);
  });
});
