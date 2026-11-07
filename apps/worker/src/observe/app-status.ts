/**
 * App.status as the daemon reports it. Before this, only a deploy or a power action wrote
 * the status, so a stopped container read "running", a crash loop read "running", and the status
 * page said Operational while the app answered 502. Now every sampler tick re-derives each app's
 * status from what the listing and the inspect saw, and the deploy pipeline and power actions use
 * the same rule for the write they make right after acting.
 *
 * The rule (observedStatus) is pure. The writer only changes a row whose status is still the one it
 * read (a compare-and-set), so a deploy that sets "deploying" between the read and the write is
 * never overwritten, and a blind or stale tick writes nothing.
 */
import type { AppStatus, Db } from "@dockify/db";
import { appsHere } from "../server/apps-here.ts";
import type { SamplerState } from "./sampler.ts";

/** Restarts of one container within this window that make it crash looping, even while it is up. */
export const CRASH_LOOP = { windowMs: 5 * 60_000, restarts: 2 } as const;
const IN_FLIGHT = ["queued", "building", "deploying", "cancelling"] as const;

export interface StatusInput {
  desiredState: "running" | "stopped";
  /** The app has had a deployment go live (it has a current deployment). */
  deployed: boolean;
  /** The status of its newest deployment, if any: tells a failed first deploy from a never-deployed app. */
  lastDeployment: string | null;
  /** A deployment of the app (not a preview) is queued or running. */
  inFlight: boolean;
  /** The app's container as the daemon reports it, or null when it has none. */
  container: { state: string; health: string | null } | null;
  /** Restarts of the current container within CRASH_LOOP.windowMs. */
  recentRestarts: number;
}

export function observedStatus(i: StatusInput): AppStatus {
  // A deploy owns the app while it runs and settles the status itself.
  if (i.inFlight) return "deploying";
  const c = i.container;
  if (c) {
    if (c.state === "restarting" || i.recentRestarts >= CRASH_LOOP.restarts) return "restarting";
    if (c.state === "running") return c.health === "unhealthy" ? "degraded" : "running";
    // created, exited, dead, paused, removing: nothing is serving.
    return i.desiredState === "stopped" ? "stopped" : "exited";
  }
  if (i.desiredState === "stopped") return "stopped";
  if (i.deployed) return "missing";
  return i.lastDeployment === "failed" ? "failed" : "unknown";
}

/** Docker's State.StartedAt, or null for a container that never started (Docker sends year 1). */
export function startedAtOf(raw: string | null | undefined): Date | null {
  if (!raw || raw.startsWith("0001-01-01")) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

const recent = (times: number[] | undefined, now: number): number => (times ?? []).filter((t) => t > now - CRASH_LOOP.windowMs).length;

/** What the writers need of each app: its desired state, whether it went live, its newest deployment. */
const APP_FIELDS = {
  id: true, status: true, desiredState: true, currentDeploymentId: true, containerStartedAt: true,
  deployments: { where: { previewId: null }, orderBy: { createdAt: "desc" as const }, take: 1, select: { status: true, finishedAt: true } },
} as const;

/** Writes `next` only over the status that was read, so a concurrent deploy's write always wins. */
async function writeIfUnchanged(db: Db, id: string, read: AppStatus, next: AppStatus, extra: { containerStartedAt?: Date | null; containerId?: string | null } = {}): Promise<boolean> {
  if (read === next && Object.keys(extra).length === 0) return false;
  const r = await db.app.updateMany({ where: { id, status: read }, data: { status: next, ...extra } });
  return r.count === 1;
}

/**
 * One pass over every app on this server from the sampler's latest reading. Skips a blind start,
 * a listing older than `maxAgeMs`, an app whose inspect failed this tick, an app a restore has
 * stopped on purpose (its job owns the container), and an app whose deploy settled after the listing
 * was taken: the listing shows the container that deploy has since replaced or scrapped, and
 * the deploy already wrote what it saw. Returns how many rows it changed.
 */
export async function reconcileAppStatus(db: Db, serverId: string, state: SamplerState, opts: { maxAgeMs: number; now?: number }): Promise<number> {
  const now = opts.now ?? Date.now();
  if (!state.dockerSeen || state.listedAt === null || now - state.listedAt > opts.maxAgeMs) return 0;
  const [apps, open] = await Promise.all([
    db.app.findMany({ where: { deployTarget: "server", quiescedByJobId: null, ...appsHere(serverId) }, select: APP_FIELDS }),
    db.deployment.findMany({ where: { previewId: null, status: { in: [...IN_FLIGHT] }, ...appsHere(serverId) }, select: { appId: true } }),
  ]);
  const busy = new Set(open.map((d) => d.appId));
  let changed = 0;
  for (const a of apps) {
    const latest = state.apps.get(a.id);
    // Listed but not read this tick: no verdict on its container either way.
    if (state.listed.has(a.id) && !latest) continue;
    const settledAt = a.deployments[0]?.finishedAt?.getTime();
    if (settledAt !== undefined && settledAt >= state.listedAt) continue;
    const next = observedStatus({
      desiredState: a.desiredState,
      deployed: !!a.currentDeploymentId,
      lastDeployment: a.deployments[0]?.status ?? null,
      inFlight: busy.has(a.id),
      container: latest ? { state: latest.state, health: latest.health } : null,
      recentRestarts: recent(state.restarts.get(a.id), now),
    });
    const started = latest ? startedAtOf(latest.startedAt) : undefined;
    const extra = started !== undefined && started?.getTime() !== a.containerStartedAt?.getTime() ? { containerStartedAt: started } : {};
    if (await writeIfUnchanged(db, a.id, a.status, next, extra)) changed++;
  }
  return changed;
}

/**
 * The status right after the worker acted on one app (a deploy settled, a power action ran), from
 * one inspect of its container: `container` null when the daemon has none. Writes the container id
 * with it, over the status it read only (a deploy queued meanwhile keeps its "deploying"). Best
 * effort, like the observe pass that follows it.
 */
export async function writeObservedStatus(
  db: Db,
  appId: string,
  container: { id: string; state: string; health: string | null; startedAt?: string | null } | null,
): Promise<AppStatus | null> {
  const a = await db.app.findUnique({ where: { id: appId }, select: APP_FIELDS });
  if (!a) return null;
  const open = await db.deployment.findFirst({ where: { appId, previewId: null, status: { in: [...IN_FLIGHT] } }, select: { id: true } });
  const next = observedStatus({
    desiredState: a.desiredState,
    deployed: !!a.currentDeploymentId,
    lastDeployment: a.deployments[0]?.status ?? null,
    inFlight: !!open,
    container,
    recentRestarts: 0,
  });
  const extra = container
    ? { containerId: container.id, ...(container.startedAt !== undefined ? { containerStartedAt: startedAtOf(container.startedAt) } : {}) }
    : { containerId: null };
  return (await writeIfUnchanged(db, appId, a.status, next, extra)) ? next : null;
}
