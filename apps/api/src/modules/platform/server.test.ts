import { describe, expect, it } from "vitest";
import { server as S } from "@dockify/contracts";
import type { Actor } from "../../actor.ts";
import { buildApp, type Ctx } from "../../app.ts";
import { HttpError } from "../../errors.ts";
import { POLICIES } from "../../policy.ts";
import { RateLimits } from "../../ratelimit.ts";
import { noDb, testConfig, testRing } from "../../test-helpers.ts";
import { DISK_SAMPLE_MAX_AGE_MS, diskSlices, prunedBytes, reclaimableOf, serverHandlers, WORKER_SILENT_MS, workerService } from "./server.ts";
import { loadPlatformEnv } from "./shared.ts";

const GB = 1e9;
const U1 = "00000000-0000-4000-8000-000000000001";
const SESSION: Actor = { kind: "session", userId: U1, name: "Olive", role: "admin", sessionId: "s1", elevated: false };
const TOKEN: Actor = { kind: "token", userId: U1, name: "ci", role: "admin", tokenId: "t1", scope: "read", allProjects: true, projectIds: [], grants: [], elevated: false };

/** What the worker writes to Instance.hostDisk (apps/worker/src/deploy/disk.ts). */
const SAMPLE = [
  { id: "images", bytes: 64 * GB, reclaimableBytes: 14 * GB, count: 87 },
  { id: "buildCache", bytes: 31 * GB, reclaimableBytes: 21 * GB, count: 412 },
  { id: "volumes", bytes: 42 * GB, reclaimableBytes: 0, count: 19 },
];

const ctxOf = (db: unknown): Ctx => ({ db, ring: testRing(), config: testConfig(), web: { origin: "https://dockify.test", secure: true }, limits: new RateLimits() }) as unknown as Ctx;
const call = (h: unknown, input: Record<string, unknown>) => (h as (i: unknown) => Promise<any>)(input);
const codeOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof HttpError ? [e.status, e.code, e.message] : e));

describe("the worker row and the issues its heartbeat reports", () => {
  const now = Date.UTC(2026, 10, 6, 12);
  const fresh = new Date(now - 20_000);
  /** What apps/worker/src/health.ts writes for a work folder it cannot write. */
  const folder = { key: "work_folder", summary: "cannot write its work folder; backups and restores fail", message: "The worker cannot write its work folder /var/lib/dockify/work/tmp (EACCES: permission denied), where backups and restores stage their files.", since: new Date(now - 60_000).toISOString() };

  it("is degraded, with the issue as its detail, while the heartbeat is fresh", () => {
    expect(workerService(fresh, now, [folder])).toEqual({ id: "worker", status: "degraded", latencyMs: null, detail: "cannot write its work folder; backups and restores fail" });
    expect(workerService(fresh, now, [folder, { ...folder, key: "other", summary: "x" }]).detail).toBe("cannot write its work folder; backups and restores fail (and 1 more)");
    expect(S.WorkerIssue.safeParse(folder).success).toBe(true);
  });

  it("is healthy with no issues, an older worker's null, or rows that do not parse", () => {
    for (const issues of [[], null, undefined, "x", [{ key: "a" }], [null]]) expect(workerService(fresh, now, issues).status, JSON.stringify(issues)).toBe("ok");
  });

  it("is down when silent, whatever it last reported", () => {
    expect(workerService(new Date(now - WORKER_SILENT_MS - 1_000), now, [folder]).status).toBe("down");
  });
});

describe("disk breakdown mapping", () => {
  const now = Date.UTC(2026, 10, 1, 12);
  const fresh = new Date(now - 5 * 60_000);

  it("serves the worker's slices in page order, with the reclaimable total", () => {
    const got = diskSlices([SAMPLE[2], SAMPLE[0], SAMPLE[1]], fresh, now);
    expect(got).toEqual(SAMPLE);
    expect(reclaimableOf(got)).toBe(35 * GB);
    expect(reclaimableOf([])).toBe(0);
  });

  it("drops rows that do not match the contract and never trusts a row's numbers", () => {
    const got = diskSlices(
      [
        { id: "images", bytes: 10, reclaimableBytes: 50, count: 2.6 },
        { id: "images", bytes: 99, reclaimableBytes: 1 },
        { id: "volumes", bytes: 7, reclaimableBytes: 7 },
        { id: "buildCache", bytes: -5, reclaimableBytes: -1 },
        { id: "containers", bytes: 1, reclaimableBytes: 0 },
        { id: "logs", bytes: "9", reclaimableBytes: 0 },
        null,
        "images",
      ],
      fresh,
      now,
    );
    // The first images row wins and cannot promise more than it holds; volumes are never reclaimable.
    expect(got).toEqual([
      { id: "images", bytes: 10, reclaimableBytes: 10, count: 3 },
      { id: "buildCache", bytes: 0, reclaimableBytes: 0 },
      { id: "volumes", bytes: 7, reclaimableBytes: 0 },
    ]);
  });

  it("reads a missing or stale sample as not reported yet", () => {
    expect(diskSlices(SAMPLE, null, now)).toEqual([]);
    expect(diskSlices(null, fresh, now)).toEqual([]);
    expect(diskSlices({ slices: SAMPLE }, fresh, now)).toEqual([]);
    expect(diskSlices(SAMPLE, new Date(now - DISK_SAMPLE_MAX_AGE_MS - 1), now)).toEqual([]);
    expect(diskSlices(SAMPLE, new Date(now - DISK_SAMPLE_MAX_AGE_MS), now)).toHaveLength(3);
  });

  it("reads the freed bytes off the prune job's row, and anything else as none", () => {
    expect(prunedBytes({ targets: ["images"], result: { reclaimedBytes: 7.2 * GB, imagesRemoved: 3 } })).toBe(7.2 * GB);
    expect(prunedBytes({ targets: ["images"] })).toBe(0);
    expect(prunedBytes({ result: { reclaimedBytes: "12" } })).toBe(0);
    expect(prunedBytes({ result: { reclaimedBytes: -4 } })).toBe(0);
    expect(prunedBytes(null)).toBe(0);
  });
});

/** Just enough of the database for server.get's snapshot. */
const snapshotDb = (instance: Record<string, unknown> | null) => ({
  $queryRaw: async () => [{ ok: 1 }],
  app: { findMany: async () => [] },
  metricSample: { findMany: async () => [] },
  instance: { findUnique: async () => instance },
  backup: { findFirst: async () => null },
});

describe("server.get disk", () => {
  const handlers = serverHandlers(loadPlatformEnv({}));
  const sampled = { releaseVersion: "1.0.0", hostDisk: SAMPLE, hostDiskAt: new Date() };

  it("maps the stored slices for a session and sums what is reclaimable into the host", async () => {
    const out = await call(handlers["server.get"], { ctx: ctxOf(snapshotDb(sampled)), actor: SESSION });
    expect(out.disk).toEqual(SAMPLE);
    expect(out.host.disk.reclaimableBytes).toBe(35 * GB);
    expect(S.ServerSnapshot.safeParse(out).success).toBe(true);
  });

  it("keeps disk empty and nothing reclaimable until the worker has sampled", async () => {
    const out = await call(handlers["server.get"], { ctx: ctxOf(snapshotDb({ releaseVersion: null, hostDisk: null, hostDiskAt: null })), actor: SESSION });
    expect(out.disk).toEqual([]);
    expect(out.host.disk.reclaimableBytes).toBe(0);
  });

  it("shows a token what it saw before: no breakdown and nothing reclaimable", async () => {
    const out = await call(handlers["server.get"], { ctx: ctxOf(snapshotDb(sampled)), actor: TOKEN });
    expect(out.disk).toEqual([]);
    expect(out.host.disk.reclaimableBytes).toBe(0);
    expect(out.host.name).toBe("");
    expect(S.ServerSnapshot.safeParse(out).success).toBe(true);
  });
});

describe("server.get services and host", () => {
  const now = Date.now();
  const services = (out: { services: Array<{ id: string; status: string; detail: string }> }) => Object.fromEntries(out.services.map((s) => [s.id, s]));

  it("judges the worker from its heartbeat, and lists every control-plane service the worker saw", async () => {
    const handlers = serverHandlers(loadPlatformEnv({}));
    const inst = {
      releaseVersion: "1.0.0", hostDisk: null, hostDiskAt: null,
      workerSeenAt: new Date(now - WORKER_SILENT_MS - 60_000),
      controlPlaneAt: new Date(now - 30_000),
      controlPlane: [
        { service: "web", state: "running", health: "healthy", startedAt: new Date(now - 3 * 3600_000).toISOString() },
        { service: "proxy-direct", state: "running", health: "unhealthy", startedAt: null },
        { service: "buildkit", state: "restarting", health: null, startedAt: null },
        { service: "updater", state: "exited", health: null, startedAt: null },
        { service: "socket-proxy", state: "running", health: null, startedAt: null },
        { service: "api", state: "running", health: null, startedAt: null },
        { service: "nonsense" },
      ],
    };
    const out = await call(handlers["server.get"], { ctx: ctxOf(snapshotDb(inst)), actor: SESSION });
    expect(S.ServerSnapshot.safeParse(out).success).toBe(true);
    const by = services(out);
    expect(out.services.map((s: { id: string }) => s.id)).toEqual(["api", "worker", "postgres", "web", "proxy", "buildkit", "socketProxy", "updater"]);
    expect(by.worker).toMatchObject({ status: "down" });
    expect(by.worker!.detail).toMatch(/^silent for 3 min$/);
    expect(by.web).toMatchObject({ status: "ok", detail: "up 3 h" });
    expect(by.proxy).toMatchObject({ status: "degraded" });
    expect(by.buildkit).toMatchObject({ status: "degraded", detail: "restarting" });
    expect(by.updater).toMatchObject({ status: "down", detail: "exited" });
  });

  it("shows a fresh heartbeat as ok, never lists a stale control-plane reading, and says a silent worker never reported", async () => {
    const handlers = serverHandlers(loadPlatformEnv({}));
    const fresh = await call(handlers["server.get"], {
      ctx: ctxOf(snapshotDb({ releaseVersion: null, hostDisk: null, hostDiskAt: null, workerSeenAt: new Date(now - 10_000), controlPlaneAt: new Date(now - 10 * 60_000), controlPlane: [{ service: "web", state: "running" }] })),
      actor: SESSION,
    });
    expect(services(fresh).worker).toMatchObject({ status: "ok" });
    expect(services(fresh).web).toBeUndefined();
    const never = await call(handlers["server.get"], { ctx: ctxOf(snapshotDb({ releaseVersion: null, hostDisk: null, hostDiskAt: null, workerSeenAt: null })), actor: SESSION });
    expect(services(never).worker).toMatchObject({ status: "down", detail: "has not reported since Dockify started" });
  });

  it("names the server, not the api's container, and sends an unknown link speed as null", async () => {
    const plain = await call(serverHandlers(loadPlatformEnv({}))["server.get"], { ctx: ctxOf(snapshotDb({ releaseVersion: null })), actor: SESSION });
    // Without DOCKIFY_HOST_NAME (an install from before the installer recorded it): the dashboard's name.
    expect(plain.host.name).toBe(new URL(testConfig().publicUrl).hostname);
    expect(plain.host.network.capacityMbps).toBeNull();
    const named = await call(serverHandlers(loadPlatformEnv({ DOCKIFY_HOST_NAME: "vps-fra-1", DOCKIFY_NET_CAPACITY_MBPS: "1000" }))["server.get"], { ctx: ctxOf(snapshotDb({ releaseVersion: null })), actor: SESSION });
    expect(named.host.name).toBe("vps-fra-1");
    expect(named.host.network.capacityMbps).toBe(1000);
  });

  it("lists only apps that have a container, with its start time, and reads a crash loop as restarting", async () => {
    const started = new Date(now - 3_600_000);
    const app = (id: string, status: string) => ({
      id, name: id, kind: "backend", status, containerId: `c-${id}`, containerStartedAt: status === "running" ? started : null,
      environment: { name: "production", project: { slug: "shop" } }, metrics: [],
    });
    const db = { ...snapshotDb({ releaseVersion: null }), app: { findMany: async () => [app("up", "running"), app("loop", "restarting"), app("gone", "missing"), app("never", "failed")] } };
    const out = await call(serverHandlers(loadPlatformEnv({}))["server.get"], { ctx: ctxOf(db), actor: SESSION });
    expect(out.containers.map((c: { name: string; state: string; startedAt: string | null }) => [c.name, c.state, c.startedAt])).toEqual([
      ["up", "running", started.toISOString()],
      ["loop", "restarting", null],
    ]);
    expect(out.host.containers).toBe(2);
  });
});

interface PruneDbOptions {
  seenAt?: Date | null;
  /** An open prune job with the same targets. */
  open?: string;
  /** What each poll of the job row returns; the last one repeats. */
  polls?: Array<Record<string, unknown> | null>;
  hostDisk?: unknown;
}

/** The rows server.prune reads and writes, with every write recorded. */
function pruneDb(o: PruneDbOptions = {}) {
  const created: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const polled: string[] = [];
  const polls = [...(o.polls ?? [])];
  const tx = {
    $executeRaw: async () => 0,
    server: { findFirst: async () => ({ id: "s1" }) },
    job: {
      findFirst: async () => (o.open ? { id: o.open } : null),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "job-new" };
      },
    },
    activityLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return {};
      },
    },
  };
  const db = {
    instance: {
      findUnique: async ({ select }: { select: Record<string, boolean> }) =>
        select.workerSeenAt ? { workerSeenAt: o.seenAt === undefined ? new Date() : o.seenAt } : { hostDisk: o.hostDisk ?? SAMPLE, hostDiskAt: new Date() },
    },
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    job: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        polled.push(where.id);
        return polls.length > 1 ? polls.shift() : (polls[0] ?? null);
      },
    },
  };
  return { db, created, audits, polled };
}

const RUNNING = { completedAt: null, failedAt: null, lastError: null, payload: { targets: ["images", "buildCache"] } };
const DONE = { completedAt: new Date(), failedAt: null, lastError: null, payload: { targets: ["images", "buildCache"], result: { reclaimedBytes: 35 * GB, imagesRemoved: 9, cacheRecordsRemoved: 120 } } };
const req = { clientIp: "203.0.113.9", headers: { "user-agent": "vitest" } };
const quick = serverHandlers(loadPlatformEnv({}), { waitMs: 200, pollMs: 1 });
const prune = (db: unknown, targets: string[]) => call(quick["server.prune"], { ctx: ctxOf(db), actor: SESSION, body: { targets }, req });

describe("server.prune", () => {
  it("queues one prune of the named targets, audits it, waits, and answers with the freed bytes and the new breakdown", async () => {
    const after = [{ ...SAMPLE[0]!, bytes: 50 * GB, reclaimableBytes: 0 }, { ...SAMPLE[1]!, bytes: 10 * GB, reclaimableBytes: 0 }, SAMPLE[2]!];
    const { db, created, audits, polled } = pruneDb({ polls: [RUNNING, RUNNING, DONE], hostDisk: after });
    const out = await prune(db, ["buildCache", "images", "buildCache"]);
    expect(created).toEqual([
      { kind: "prune", lane: "maintenance", serverId: "s1", payload: { targets: ["images", "buildCache"] }, dedupeKey: "prune:images+buildCache", maxAttempts: 1, runAfter: expect.any(Date) },
    ]);
    expect(audits).toEqual([
      expect.objectContaining({
        category: "system", action: "server.prune", verb: "started a disk prune of", targetType: "disk",
        targetLabel: "unused images and unused build cache", actorType: "user", actorId: U1, actorName: "Olive",
        ip: "203.0.113.9", userAgent: "vitest", failed: false,
      }),
    ]);
    expect(polled).toEqual(["job-new", "job-new", "job-new"]);
    expect(out).toEqual({ reclaimedBytes: 35 * GB, disk: after });
    expect(S.PruneResult.safeParse(out).success).toBe(true);
  });

  it("joins the prune already open for the same targets instead of queuing a second one", async () => {
    const { db, created, audits, polled } = pruneDb({ open: "job-open", polls: [DONE] });
    const out = await prune(db, ["logs"]);
    expect(created).toEqual([]);
    expect(polled).toEqual(["job-open"]);
    expect(audits[0]).toMatchObject({ targetLabel: "rotated logs" });
    expect(out.reclaimedBytes).toBe(35 * GB);
  });

  it("answers 502 with the worker's reason when the job failed", async () => {
    const { db } = pruneDb({ polls: [{ completedAt: null, failedAt: new Date(), lastError: "buildctl: connection refused", payload: RUNNING.payload }] });
    expect(await codeOf(prune(db, ["buildCache"]))).toEqual([502, "PRUNE_FAILED", "The prune failed: buildctl: connection refused"]);
    const gone = pruneDb({ polls: [null] });
    expect(await codeOf(prune(gone.db, ["images"]))).toEqual([502, "PRUNE_FAILED", "The prune failed: the prune job disappeared"]);
  });

  it("answers 504 and leaves the job to finish when it outlasts the wait", async () => {
    const { db, polled } = pruneDb({ polls: [RUNNING] });
    expect(await codeOf(prune(db, ["images"]))).toEqual([504, "PRUNE_PENDING", "The prune is still running. The disk breakdown updates when it finishes."]);
    expect(polled.length).toBeGreaterThan(1);
  });

  it("refuses at once, queuing and auditing nothing, when the worker is not running", async () => {
    for (const seenAt of [null, new Date(Date.now() - WORKER_SILENT_MS - 1_000)]) {
      const { db, created, audits, polled } = pruneDb({ seenAt, polls: [DONE] });
      expect(await codeOf(prune(db, ["images"]))).toEqual([503, "WORKER_DOWN", "The worker is not running, so nothing can be pruned right now"]);
      expect([created, audits, polled]).toEqual([[], [], []]);
    }
  });

  it("is an Admin session route with no step-up and no token, and its body can never name volumes", async () => {
    expect(POLICIES["server.prune"]).toEqual({ access: "session", role: "admin" });
    for (const targets of [["volumes"], ["images", "volumes"], [], ["containers"]]) expect(S.PruneBody.safeParse({ targets }).success, targets.join()).toBe(false);
    expect(S.PruneBody.safeParse({ targets: ["images"], force: true }).success).toBe(false);
    const { app } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), handlers: serverHandlers(loadPlatformEnv({})), logger: false });
    const anon = await app.inject({ method: "POST", url: "/api/v1/server/prune", payload: { targets: ["images"] } });
    expect(anon.statusCode).toBe(401);
    const token = await app.inject({ method: "POST", url: "/api/v1/server/prune", headers: { authorization: "Bearer dk_x" }, payload: { targets: ["images"] } });
    expect(token.statusCode).toBe(403);
    await app.close();
  });
});
