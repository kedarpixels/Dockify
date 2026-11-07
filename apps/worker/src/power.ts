/**
 * Start, stop and restart of one app's live container (app_power, queued by the apps module in the
 * same transaction that records the new desired state). The job converges on the row: a stop that
 * runs after a newer start, or the reverse, does nothing, so two quick clicks can never leave the
 * container in the state the owner asked for first. The route file follows through edge_route_sync,
 * which drops the route of an app that should not run and rewrites it with the new address after a
 * start.
 */
import type { Db } from "@dockify/db";
import { enqueue } from "@dockify/db";
import { canonicalName, LABEL } from "./deploy/containers.ts";
import { isNotFound, isNotModified, type DockerApi } from "@dockify/engine";
import { STOP_TIMEOUT_S } from "./deploy/swap.ts";
import { PermanentJobError } from "./errors.ts";
import { writeObservedStatus } from "./observe/app-status.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const POWER_OPS = ["start", "stop", "restart"] as const;
export type PowerOp = (typeof POWER_OPS)[number];
const ROUTED = new Set(["frontend", "backend"]);
const IN_FLIGHT = ["queued", "building", "deploying", "cancelling"] as const;

export interface PowerPayload {
  appId: string;
  op: PowerOp;
}

export function parsePower(p: unknown): PowerPayload {
  const o = (p ?? {}) as Record<string, unknown>;
  if (typeof o.appId !== "string" || !UUID.test(o.appId)) throw new PermanentJobError("app_power payload has no appId");
  if (typeof o.op !== "string" || !(POWER_OPS as readonly string[]).includes(o.op)) throw new PermanentJobError("app_power payload has no valid op");
  return { appId: o.appId, op: o.op as PowerOp };
}

export interface PowerDeps {
  db: Db;
  docker: DockerApi;
}

export type PowerResult = "started" | "stopped" | "restarted" | "skipped";

const ignoreNotModified = (e: unknown) => {
  if (!isNotModified(e)) throw e;
};

async function activity(db: Db, app: { id: string; name: string }, action: string, verb: string, failed = false, suffix: string | null = null): Promise<void> {
  await db.activityLog
    .create({ data: { category: "deploys", action, verb, actorType: "system", actorName: "Dockify", targetType: "app", targetId: app.id, targetLabel: app.name, failed, suffix } })
    .catch(() => {});
}

/** Writes the app's observed status from one inspect of `name` (null: it has no container). */
async function observe(deps: PowerDeps, appId: string, name: string | null): Promise<void> {
  const info = name
    ? await deps.docker.inspectContainer(name).catch((e: unknown) => {
        if (isNotFound(e)) return null;
        throw e;
      })
    : null;
  const container = info ? { id: info.Id, state: info.State.Status, health: info.State.Health?.Status ?? null, startedAt: info.State.StartedAt ?? null } : null;
  await writeObservedStatus(deps.db, appId, container);
}

export async function runPower(deps: PowerDeps, payload: unknown): Promise<PowerResult> {
  const { db, docker } = deps;
  const p = parsePower(payload);
  const app = await db.app.findUnique({ where: { id: p.appId }, select: { id: true, name: true, kind: true, desiredState: true, deployTarget: true, serverId: true } });
  // Deleted before the job ran, or moved to Vercel: nothing on this server to power.
  if (!app || app.deployTarget !== "server") return "skipped";
  const wanted = p.op === "stop" ? "stopped" : "running";
  // A newer request changed the desired state; that request's own job does the work.
  if (app.desiredState !== wanted) return "skipped";
  // A deploy owns the container while it runs and settles the state itself. A preview build of the
  // app runs in its own container, so it must not swallow a stop of the live one.
  if (await db.deployment.findFirst({ where: { appId: app.id, previewId: null, status: { in: [...IN_FLIGHT] } }, select: { id: true } })) return "skipped";

  const name = canonicalName(app.id);
  const info = await docker.inspectContainer(name).catch((e: unknown) => {
    if (isNotFound(e)) return null;
    throw e;
  });
  // Only ever touch a container Dockify labelled with this app.
  if (info && info.Config.Labels?.[LABEL.app] !== app.id) throw new PermanentJobError(`container ${name} is not labelled for this app`);

  let result: PowerResult;
  if (p.op === "stop") {
    if (info) await docker.stopContainer(name, STOP_TIMEOUT_S).catch(ignoreNotModified);
    result = "stopped";
  } else {
    if (!info) {
      // Reads "missing": it should run and has no container.
      await observe(deps, app.id, null);
      await activity(db, app, `app.${p.op}`, p.op === "start" ? "could not start" : "could not restart", true, "because it has no container; deploy it again");
      throw new PermanentJobError(`app ${app.id} has no container to ${p.op}; deploy it again`);
    }
    if (p.op === "restart") await docker.stopContainer(name, STOP_TIMEOUT_S).catch(ignoreNotModified);
    await docker.startContainer(name).catch(ignoreNotModified);
    result = p.op === "start" ? "started" : "restarted";
  }
  // The status is what the daemon reports now, by the observe pass's rule: a container that dies
  // right after its start reads exited or restarting, not running.
  await observe(deps, app.id, name);
  if (ROUTED.has(app.kind)) {
    await enqueue(db, { kind: "edge_route_sync", serverId: app.serverId, payload: { appId: app.id }, dedupeKey: `edge.route:${app.id}` });
  }
  return result;
}
