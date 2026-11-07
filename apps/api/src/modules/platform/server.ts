import { statfs } from "node:fs/promises";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { server as S, type ResponseOf } from "@dockify/contracts";
import { defaultServerId, type AppStatus, type Db, type MetricResolution } from "@dockify/db";
import type { Actor } from "../../actor.ts";
import type { Ctx, Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError } from "../../errors.ts";
import { projectLimit } from "../observe/scope.ts";
import { storageRef } from "../backups/map.ts";
import { actorAudit, enqueueJob, loadPlatformEnv, reqMeta, requireActor, type PlatformEnv } from "./shared.ts";
import { updateHandlers } from "./updates/handlers.ts";

export const RANGE: Record<"1h" | "24h" | "7d", { ms: number; resolution: MetricResolution }> = {
  "1h": { ms: 3600_000, resolution: "raw" },
  "24h": { ms: 24 * 3600_000, resolution: "five_min" },
  "7d": { ms: 7 * 24 * 3600_000, resolution: "hour" },
};

export interface HostSample {
  at: Date;
  cpuPct: number;
  memoryBytes: bigint;
  diskBytes: bigint | null;
  netTxBytes: bigint | null;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : 0);
const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Host samples as chart points: cpu, memory and disk in percent, network as outbound Mbps from the
 * delta of the cumulative tx counter. A counter reset (negative delta) reads as 0, never negative.
 */
export function toPoints(samples: HostSample[], totals: { memoryBytes: number; diskBytes: number }) {
  return samples.map((s, i) => {
    const prev = samples[i - 1];
    let mbps = 0;
    if (prev && s.netTxBytes !== null && prev.netTxBytes !== null) {
      const secs = (s.at.getTime() - prev.at.getTime()) / 1000;
      const delta = Number(s.netTxBytes - prev.netTxBytes);
      if (secs > 0 && delta > 0) mbps = (delta * 8) / secs / 1e6;
    }
    return {
      at: s.at.toISOString(),
      cpu: round(s.cpuPct),
      memory: round(pct(Number(s.memoryBytes), totals.memoryBytes)),
      disk: round(s.diskBytes === null ? 0 : pct(Number(s.diskBytes), totals.diskBytes)),
      network: round(mbps),
    };
  });
}

export const CONTAINER_STATE: Record<AppStatus, "running" | "restarting" | "unhealthy" | "exited"> = {
  running: "running",
  deploying: "restarting",
  degraded: "unhealthy",
  restarting: "restarting",
  stopped: "exited",
  exited: "exited",
  unknown: "exited",
  missing: "exited",
  failed: "exited",
};
/** Apps with no container to list: it never ran (failed, unknown) or the daemon has none (missing). */
export const NO_CONTAINER: ReadonlySet<AppStatus> = new Set<AppStatus>(["missing", "failed", "unknown"]);

type Service = ResponseOf<"server.get">["services"][number];
type ServiceId = Service["id"];

/** "45 s", "12 min", "5 h", "3 d": how long ago, or how long up. */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}

/**
 * The worker, judged from outside it: it stamps workerSeenAt every 30 seconds, so a stamp
 * older than WORKER_SILENT_MS means it is not running, whatever the worker last said of itself. A
 * live worker that reports an issue with its heartbeat (Instance.workerIssues, such as a work folder
 * it cannot write) is degraded, with the issue as its detail. A row that does not parse is dropped.
 */
export function workerService(seenAt: Date | null, now: number, issues: unknown = null): Service {
  if (!seenAt) return { id: "worker", status: "down", latencyMs: null, detail: "has not reported since Dockify started" };
  const age = now - seenAt.getTime();
  if (age > WORKER_SILENT_MS) return { id: "worker", status: "down", latencyMs: null, detail: `silent for ${spanText(age)}` };
  const reported = Array.isArray(issues) ? issues.flatMap((i) => {
    const r = S.WorkerIssue.safeParse(i);
    return r.success ? [r.data] : [];
  }) : [];
  const [first, ...more] = reported;
  if (first) return { id: "worker", status: "degraded", latencyMs: null, detail: more.length ? `${first.summary} (and ${more.length} more)` : first.summary };
  return { id: "worker", status: "ok", latencyMs: null, detail: `reported ${spanText(age)} ago` };
}

/** Compose services as the server page names them; api, worker and postgres come from the api's own checks. */
const CONTROL_PLANE_ID: Record<string, ServiceId> = {
  web: "web", proxy: "proxy", "proxy-direct": "proxy", buildkit: "buildkit", "socket-proxy": "socketProxy", updater: "updater", cloudflared: "cloudflared",
};
const SERVICE_ORDER: readonly ServiceId[] = ["api", "worker", "postgres", "web", "proxy", "buildkit", "socketProxy", "updater", "cloudflared"];
/** The worker writes the control plane's containers every minute; a reading older than this is not shown. */
export const CONTROL_PLANE_MAX_AGE_MS = 3 * 60_000;

/**
 * The control plane's other services from the worker's last reading (Instance.controlPlane, written
 * by apps/worker/src/observe/control-plane.ts). A row that does not parse is dropped, and a stale
 * reading is no reading: the worker row already says why.
 */
export function controlPlaneServices(raw: unknown, at: Date | null, now: number): Service[] {
  if (!at || now - at.getTime() > CONTROL_PLANE_MAX_AGE_MS || !Array.isArray(raw)) return [];
  const out = new Map<ServiceId, Service>();
  for (const row of raw) {
    const r = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
    const id = typeof r.service === "string" ? CONTROL_PLANE_ID[r.service] : undefined;
    if (!id || out.has(id) || typeof r.state !== "string") continue;
    const health = typeof r.health === "string" ? r.health : null;
    const started = typeof r.startedAt === "string" ? Date.parse(r.startedAt) : Number.NaN;
    if (r.state === "running" && health === "unhealthy") out.set(id, { id, status: "degraded", latencyMs: null, detail: "running, failing its health check" });
    else if (r.state === "running") out.set(id, { id, status: "ok", latencyMs: null, detail: Number.isFinite(started) && started > 0 ? `up ${spanText(now - started)}` : "running" });
    else if (r.state === "restarting") out.set(id, { id, status: "degraded", latencyMs: null, detail: "restarting" });
    else out.set(id, { id, status: "down", latencyMs: null, detail: r.state.slice(0, 40) });
  }
  return [...out.values()];
}

/** Every service in one fixed order. */
export const orderServices = (list: Service[]): Service[] => [...list].sort((a, b) => SERVICE_ORDER.indexOf(a.id) - SERVICE_ORDER.indexOf(b.id));

export type DiskSlice = ResponseOf<"server.get">["disk"][number];

/** The worker samples every five minutes (deploy/disk.ts); a breakdown this old no longer describes the disk. */
export const DISK_SAMPLE_MAX_AGE_MS = 60 * 60_000;
const SLICE_ORDER: readonly DiskSlice["id"][] = ["images", "buildCache", "volumes", "logs"];
const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/**
 * The worker-written breakdown (Instance.hostDisk) as the contract's slices. A row that does not
 * match the contract is dropped rather than trusted, each slice counts once, its reclaimable part
 * never exceeds it, and volumes are never reclaimable here whatever the row says. A missing or
 * stale sample is an empty list, which the page reads as not reported yet.
 */
export function diskSlices(raw: unknown, at: Date | null, now: number): DiskSlice[] {
  if (!at || now - at.getTime() > DISK_SAMPLE_MAX_AGE_MS || !Array.isArray(raw)) return [];
  const byId = new Map<DiskSlice["id"], DiskSlice>();
  for (const row of raw) {
    const r = S.DiskSlice.safeParse(row);
    if (!r.success || byId.has(r.data.id)) continue;
    const bytes = whole(r.data.bytes);
    const reclaimableBytes = r.data.id === "volumes" ? 0 : Math.min(bytes, whole(r.data.reclaimableBytes));
    byId.set(r.data.id, { id: r.data.id, bytes, reclaimableBytes, ...(r.data.count === undefined ? {} : { count: whole(r.data.count) }) });
  }
  return SLICE_ORDER.flatMap((id) => {
    const s = byId.get(id);
    return s ? [s] : [];
  });
}

export const reclaimableOf = (slices: readonly DiskSlice[]): number => slices.reduce((n, s) => n + s.reclaimableBytes, 0);

/** The freed bytes the worker's prune job left on its own row (apps/worker/src/deploy/disk.ts, runPrune). */
export function prunedBytes(payload: unknown): number {
  const r = (payload as { result?: { reclaimedBytes?: unknown } } | null)?.result?.reclaimedBytes;
  return typeof r === "number" ? whole(r) : 0;
}

/** CPU busy share across all cores over a short window, from the kernel's own counters. */
async function cpuBusyPct(windowMs = 200): Promise<number> {
  const snap = () => os.cpus().reduce((acc, c) => {
    const t = c.times;
    acc.idle += t.idle;
    acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return acc;
  }, { idle: 0, total: 0 });
  const a = snap();
  await new Promise((r) => setTimeout(r, windowMs));
  const b = snap();
  const total = b.total - a.total;
  return total > 0 ? round(((total - (b.idle - a.idle)) / total) * 100) : 0;
}

async function rootDisk(): Promise<{ usedBytes: number; totalBytes: number }> {
  try {
    const s = await statfs("/");
    const total = s.blocks * s.bsize;
    return { totalBytes: total, usedBytes: total - s.bfree * s.bsize };
  } catch {
    return { totalBytes: 0, usedBytes: 0 };
  }
}

async function postgresProbe(ctx: Ctx) {
  const t0 = performance.now();
  try {
    await ctx.db.$queryRaw`SELECT 1`;
    const ms = Math.round(performance.now() - t0);
    return { id: "postgres" as const, status: ms > 500 ? ("degraded" as const) : ("ok" as const), latencyMs: ms, detail: `answered in ${ms} ms` };
  } catch {
    return { id: "postgres" as const, status: "down" as const, latencyMs: null, detail: "did not answer" };
  }
}

/**
 * What a caller may see of the host. A token limited to projects lists only their apps; any token
 * gets no Docker container ids, no host identity (address, kernel, Docker version, hostname) and
 * no Docker disk breakdown (image, cache and volume totals across every project), which only a
 * signed-in session needs. A token keeps the empty breakdown it always had, so it reads as not reported.
 */
export function snapshotView(actor: Actor | null) {
  const limit = projectLimit(actor);
  return {
    appWhere: limit ? { environment: { projectId: { in: limit } } } : {},
    hostDetails: actor?.kind !== "token",
  };
}

async function snapshot(ctx: Ctx, env: PlatformEnv, actor: Actor | null) {
  const view = snapshotView(actor);
  const since = new Date(Date.now() - 10 * 60_000);
  const [cpu, disk, pg, apps, hostRecent, inst, cpb] = await Promise.all([
    cpuBusyPct(),
    rootDisk(),
    postgresProbe(ctx),
    ctx.db.app.findMany({
      where: { containerId: { not: null }, ...view.appWhere },
      select: {
        id: true, name: true, kind: true, status: true, containerId: true, containerStartedAt: true,
        environment: { select: { name: true, project: { select: { slug: true } } } },
        metrics: { where: { resolution: "raw", at: { gte: since } }, orderBy: { at: "desc" }, take: 1 },
      },
    }),
    ctx.db.metricSample.findMany({ where: { appId: null, resolution: "raw", at: { gte: since } }, orderBy: { at: "desc" }, take: 2 }),
    ctx.db.instance.findUnique({ where: { id: 1 }, select: { releaseVersion: true, hostDisk: true, hostDiskAt: true, workerSeenAt: true, workerIssues: true, controlPlane: true, controlPlaneAt: true } }),
    // The newest control-plane dump: the updater takes one before every update.
    ctx.db.backup.findFirst({ where: { kind: "control_plane" }, orderBy: { createdAt: "desc" }, include: { destination: { include: { integration: true } } } }),
  ]);
  const totalMem = os.totalmem();
  const [h0, h1] = hostRecent;
  const net = h0 && h1 ? toPoints([h1, h0], { memoryBytes: totalMem, diskBytes: disk.totalBytes })[1]?.network ?? 0 : 0;
  const now = Date.now();
  const breakdown = view.hostDetails ? diskSlices(inst?.hostDisk, inst?.hostDiskAt ?? null, now) : [];
  // An app the daemon has no container for is not a container row, whatever id it last had.
  const listed = apps.filter((a) => !NO_CONTAINER.has(a.status));

  return {
    host: {
      // The api's own hostname is its container id; the installer records the server's (DOCKIFY_HOST_NAME),
      // and an install from before that falls back to the name the dashboard answers on.
      name: view.hostDetails ? (env.hostName ?? ctx.config.publicUrl.hostname) : "",
      region: env.region,
      uptimeSeconds: Math.round(os.uptime()),
      containers: listed.filter((a) => a.status === "running" || a.status === "degraded" || a.status === "restarting").length,
      load1: round(os.loadavg()[0] ?? 0),
      cpu: { usedPct: cpu, cores: os.cpus().length },
      memory: { usedBytes: totalMem - os.freemem(), totalBytes: totalMem },
      // What the worker last measured as safe to prune; only it can read Docker and BuildKit.
      disk: { usedBytes: disk.usedBytes, totalBytes: disk.totalBytes, reclaimableBytes: reclaimableOf(breakdown) },
      network: { outMbps: net, capacityMbps: env.networkCapacityMbps },
    },
    system: {
      os: view.hostDetails ? (env.hostOs ?? `${os.type()} ${os.release()}`) : os.type(),
      kernel: view.hostDetails ? os.release() : "",
      docker: view.hostDetails ? (env.dockerVersion ?? "unknown") : "unknown",
      dockify: inst?.releaseVersion ?? env.version,
      ip: view.hostDetails ? (env.publicIp ?? "") : "",
      cores: os.cpus().length,
      memoryBytes: totalMem,
    },
    disk: breakdown,
    containers: listed.map((a) => {
      const m = a.metrics[0];
      return {
        id: view.hostDetails ? (a.containerId ?? a.id) : a.id,
        name: a.name,
        app: { id: a.id, name: a.name, projectSlug: a.environment.project.slug, environment: a.environment.name, kind: a.kind },
        cpuPct: m ? round(m.cpuPct) : 0,
        memoryBytes: m ? Number(m.memoryBytes) : 0,
        restarts: m?.restarts ?? 0,
        startedAt: a.containerStartedAt?.toISOString() ?? null,
        state: CONTAINER_STATE[a.status],
      };
    }),
    services: orderServices([
      { id: "api" as const, status: "ok" as const, latencyMs: 0, detail: "serving this request" },
      pg,
      workerService(inst?.workerSeenAt ?? null, now, inst?.workerIssues),
      ...controlPlaneServices(inst?.controlPlane, inst?.controlPlaneAt ?? null, now),
    ]),
    janitor: null,
    // The server's own backup, not a project's: a limited token sees neither its bucket nor its errors.
    controlPlaneBackup: cpb && !projectLimit(actor)
      ? {
          status: cpb.status,
          lastAt: (cpb.finishedAt ?? cpb.createdAt).toISOString(),
          sizeBytes: cpb.sizeBytes === null ? null : Number(cpb.sizeBytes),
          storage: storageRef(cpb.destination),
          encrypted: cpb.encrypted,
          // Taken before each update, not on a schedule.
          nextAt: null,
          error: cpb.error,
        }
      : null,
  };
}

/**
 * How long server.prune waits for the worker before it answers. The page's request also crosses
 * the web server and, in tunnel mode, Cloudflare, which gives up on an origin after 100 seconds.
 */
export interface PruneWait {
  waitMs: number;
  pollMs: number;
}
export const PRUNE_WAIT: PruneWait = { waitMs: 75_000, pollMs: 1_000 };
/** The worker stamps workerSeenAt every 30 seconds, so two minutes of silence means it is not running. */
export const WORKER_SILENT_MS = 2 * 60_000;

const PRUNE_ORDER = ["images", "buildCache", "logs"] as const;
const PRUNE_LABEL: Record<(typeof PRUNE_ORDER)[number], string> = { images: "unused images", buildCache: "unused build cache", logs: "rotated logs" };
const listed = (parts: string[]) => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

async function waitForJob(db: Db, id: string, wait: PruneWait) {
  const deadline = Date.now() + wait.waitMs;
  for (;;) {
    const j = await db.job.findUnique({ where: { id }, select: { completedAt: true, failedAt: true, lastError: true, payload: true } });
    if (!j) return { completedAt: null, failedAt: new Date(), lastError: "the prune job disappeared", payload: null };
    if (j.completedAt || j.failedAt || Date.now() >= deadline) return j;
    await sleep(wait.pollMs);
  }
}

export function serverHandlers(env: PlatformEnv = loadPlatformEnv(), wait: PruneWait = PRUNE_WAIT): Handlers {
  return {
    "server.get": async ({ ctx, actor }) => snapshot(ctx, env, actor),

    /**
     * The api holds no Docker socket, so the worker prunes (deploy/disk.ts): the request queues a
     * prune job and waits for it, then answers with the freed bytes the job left on its row and the
     * breakdown it sampled right after. Past the wait it answers 504 and the job carries on; the
     * page's next poll shows the result. Admin without step-up: it removes only what the janitor
     * removes on its own timer (images no rollback needs, unused build cache), never volumes or
     * anything of the control plane, so it changes no code and destroys no data.
     */
    "server.prune": async ({ body, actor, req, ctx }) => {
      const a = requireActor(actor);
      const targets = PRUNE_ORDER.filter((t) => body.targets.includes(t));
      const seen = await ctx.db.instance.findUnique({ where: { id: 1 }, select: { workerSeenAt: true } });
      // Queued with no worker running, a prune would sit unseen and run whenever a worker next starts.
      if (!seen?.workerSeenAt || Date.now() - seen.workerSeenAt.getTime() > WORKER_SILENT_MS) {
        throw new HttpError(503, "The worker is not running, so nothing can be pruned right now", "WORKER_DOWN");
      }
      const jobId = await ctx.db.$transaction(async (tx) => {
        // The same targets join the prune already queued or running, so a double click prunes once.
        const id = await enqueueJob(tx, { kind: "prune", lane: "maintenance", serverId: await defaultServerId(tx), payload: { targets }, dedupeKey: `prune:${targets.join("+")}` });
        await audit(tx, {
          category: "system", action: "server.prune", verb: "started a disk prune of", targetType: "disk",
          targetLabel: listed(targets.map((t) => PRUNE_LABEL[t])), ...actorAudit(a), ...reqMeta(req),
        });
        return id;
      });
      const job = await waitForJob(ctx.db, jobId, wait);
      if (job.failedAt) throw new HttpError(502, `The prune failed: ${job.lastError ?? "the worker gave no reason"}`, "PRUNE_FAILED");
      if (!job.completedAt) throw new HttpError(504, "The prune is still running. The disk breakdown updates when it finishes.", "PRUNE_PENDING");
      const after = await ctx.db.instance.findUnique({ where: { id: 1 }, select: { hostDisk: true, hostDiskAt: true } });
      return { reclaimedBytes: prunedBytes(job.payload), disk: diskSlices(after?.hostDisk, after?.hostDiskAt ?? null, Date.now()) };
    },

    "server.metrics": async ({ query, ctx }) => {
      const range = query.range ?? "1h";
      const r = RANGE[range];
      const rows = await ctx.db.metricSample.findMany({
        where: { appId: null, resolution: r.resolution, at: { gte: new Date(Date.now() - r.ms) } },
        orderBy: { at: "asc" },
        select: { at: true, cpuPct: true, memoryBytes: true, diskBytes: true, netTxBytes: true },
        take: 2000,
      });
      const disk = await rootDisk();
      return { range, points: toPoints(rows, { memoryBytes: os.totalmem(), diskBytes: disk.totalBytes }) };
    },

    ...updateHandlers(env),
  };
}
