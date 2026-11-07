/**
 * The control plane's own containers, as the worker sees them. The api has no Docker access,
 * so its server page could only list itself and Postgres. Once a minute the worker finds this server's
 * agent by its fixed name, reads the compose project from its labels, lists that project's containers
 * through the agent, and stores one row per service on the instance row. The api
 * reads it back (modules/platform/server.ts) next to its own probes and the worker's heartbeat.
 *
 * Read-only: a name filter, a label filter and one inspect per container, all calls the socket
 * proxy already allows the sampler.
 */
import type { Db, Prisma } from "@dockify/db";
import type { DockerReader } from "./docker.ts";

export interface ServiceState {
  /** The compose service: api, worker, web, proxy, buildkit, socket-proxy, updater, cloudflared, postgres. */
  service: string;
  /** Docker's state: running, restarting, exited, dead, created, paused. */
  state: string;
  health: string | null;
  startedAt: string | null;
}

const COMPOSE_PROJECT = "com.docker.compose.project";
const COMPOSE_SERVICE = "com.docker.compose.service";
const COMPOSE_ONEOFF = "com.docker.compose.oneoff";
/** Compose services that run once and exit (migrate), not long-running services. */
const ONE_SHOT = new Set(["migrate"]);

/** Null when the worker cannot find itself (dev without compose): nothing is stored then. */
export async function readControlPlane(docker: DockerReader, selfName: string): Promise<ServiceState[] | null> {
  if (!selfName) return null;
  const self = (await docker.listFiltered({ name: [`^/${selfName}$`] }))[0];
  const project = self?.Labels?.[COMPOSE_PROJECT];
  if (!project) return null;
  const list = await docker.listFiltered({ label: [`${COMPOSE_PROJECT}=${project}`] });
  const out: ServiceState[] = [];
  for (const c of list) {
    const service = c.Labels?.[COMPOSE_SERVICE];
    // dockify.managed is on every tenant container and no Compose one: a tenant container made
    // before its image's labels were blanked can still claim to be a service here.
    if (!service || ONE_SHOT.has(service) || c.Labels?.[COMPOSE_ONEOFF] === "True" || c.Labels?.["dockify.managed"]) continue;
    const insp = await docker.inspect(c.Id).catch(() => null);
    out.push({
      service,
      state: insp?.State.Status ?? c.State,
      health: insp?.State.Health?.Status ?? null,
      startedAt: insp?.State.StartedAt || null,
    });
  }
  return out.sort((a, b) => a.service.localeCompare(b.service));
}

/** One pass: read the control plane and store it with the time it was read. */
export async function recordControlPlane(db: Db, docker: DockerReader, selfName: string, now = new Date()): Promise<number> {
  const services = await readControlPlane(docker, selfName);
  if (!services) return 0;
  await db.instance.updateMany({ where: { id: 1 }, data: { controlPlane: services as unknown as Prisma.InputJsonValue, controlPlaneAt: now } });
  return services.length;
}
