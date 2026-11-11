/**
 * App.status re-derived from the daemon on every sampler tick. The write is a compare-and-set on the
 * status it read, so a deploy's "deploying" is never overwritten and a blind or stale tick writes nothing.
 */
import type { AppStatus, Db } from "@dockify/db";
import { appsHere } from "../server/apps-here.ts";
import type { SamplerState } from "./sampler.ts";

/** Restarts of one container within this window that make it crash looping, even while it is up. */
export const CRASH_LOOP = { windowMs: 5 * 60_000, restarts: 2 } as const;
const IN_FLIGHT = ["queued", "building", "deploying", "cancelling"] as const;

export interface StatusInput {
  desiredState: "running" | "stopped";
  deployed: boolean;
  lastDeployment: string | null;
  inFlight: boolean;
  container: { state: string; health: string | null } | null;
  recentRestarts: number;
}

export function observedStatus(i: StatusInput): AppStatus {
  // A deploy owns the app while it runs and settles the status itself.
  if (i.inFlight) return "deploying";
  const c = i.container;
  if (c) {
    if (c.state === "restarting" || i.recentRestarts >= CRASH_LOOP.restarts) return "restarting";
    if (c.state === "running") return c.health === "unhealthy" ? "degraded" : "running";
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
 * Skips a blind start, a stale listing, an app whose inspect failed, one a restore stopped on purpose,
 * and one whose deploy settled after the listing: it shows the container that deploy has replaced.
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

/** Written only over the status it read, so a deploy queued meanwhile keeps its "deploying". Best effort. */
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
