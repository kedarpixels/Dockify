/**
 * Removes the network of an environment with no app left on this server: Docker's address pools hold a limited
 * number. Only when nothing but Dockify's own containers is attached and no container of any state names it.
 */
import type { Db } from "@dockify/db";
import { appsHere } from "../server/apps-here.ts";
import { LABEL } from "./containers.ts";
import { DockerError, ENV_NETWORK_PREFIX, isNotFound, PREVIEW_NETWORK_PREFIX, type DockerClient } from "@dockify/engine";
import { PREVIEW_LABEL } from "./preview.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type NetworkDocker = Pick<DockerClient, "listEnvNetworks" | "listPreviewNetworks" | "inspectNetwork" | "removeNetwork" | "disconnectNetwork" | "listContainers">;

export interface NetworkSweepDeps {
  db: Db;
  serverId: string;
  docker: NetworkDocker;
  ownContainers: string[];
  log?: (msg: string, extra?: object) => void;
}

export async function sweepEnvNetworks(deps: NetworkSweepDeps): Promise<number> {
  const { db, docker } = deps;
  const named = (await docker.listEnvNetworks()).map((name) => ({ name, id: name.slice(ENV_NETWORK_PREFIX.length) })).filter((n) => UUID.test(n.id));
  if (!named.length) return 0;
  const live = new Set((await db.environment.findMany({ where: { id: { in: named.map((n) => n.id) }, apps: { some: appsHere(deps.serverId) } }, select: { id: true } })).map((e) => e.id));
  let removed = 0;
  for (const n of named) {
    if (live.has(n.id)) continue;
    try {
      if (await removeIfIdle(deps, n, LABEL.environment)) removed++;
    } catch (e) {
      if (!isNotFound(e)) deps.log?.(`could not remove the network ${n.name}`, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return removed;
}

/** A closed preview's network, right after its containers. A container still on it leaves it for the sweep. */
export async function removePreviewNetwork(deps: Pick<NetworkSweepDeps, "docker" | "ownContainers">, previewId: string): Promise<boolean> {
  try {
    return await removeIfIdle(deps, { name: `${PREVIEW_NETWORK_PREFIX}${previewId}`, id: previewId }, PREVIEW_LABEL.env);
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

/** The network of a preview whose row went, or a teardown a crash cut short. The shared fork network has no id, so it never qualifies. */
export async function sweepPreviewNetworks(deps: NetworkSweepDeps): Promise<number> {
  const named = (await deps.docker.listPreviewNetworks()).map((name) => ({ name, id: name.slice(PREVIEW_NETWORK_PREFIX.length) })).filter((n) => UUID.test(n.id));
  if (!named.length) return 0;
  const live = new Set((await deps.db.previewEnv.findMany({ where: { id: { in: named.map((n) => n.id) }, status: { not: "closed" } }, select: { id: true } })).map((e) => e.id));
  let removed = 0;
  for (const n of named) {
    if (live.has(n.id)) continue;
    try {
      if (await removePreviewNetwork(deps, n.id)) removed++;
    } catch (e) {
      deps.log?.(`could not remove the network ${n.name}`, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return removed;
}

async function removeIfIdle({ docker, ownContainers }: Pick<NetworkSweepDeps, "docker" | "ownContainers">, n: { name: string; id: string }, label: string): Promise<boolean> {
  const info = await docker.inspectNetwork(n.name);
  const attached = Object.values(info.Containers ?? {}).map((c) => c.Name ?? "");
  if (attached.some((c) => !ownContainers.includes(c))) return false;
  // A stopped container is not attached, and would lose its network if this one went.
  if ((await docker.listContainers({ [label]: n.id })).length) return false;
  for (const c of attached) await docker.disconnectNetwork(n.name, c);
  try {
    await docker.removeNetwork(n.name);
    return true;
  } catch (e) {
    // Something attached in between: the next pass looks again.
    if (e instanceof DockerError && (e.status === 403 || e.status === 409)) return false;
    throw e;
  }
}
