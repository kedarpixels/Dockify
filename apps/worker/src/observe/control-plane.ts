/** The api has no Docker access, so the worker stores the control plane's containers on the instance row. */
import type { Db, Prisma } from "@dockify/db";
import type { DockerReader } from "./docker.ts";

export interface ServiceState {
  service: string;
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

export async function recordControlPlane(db: Db, docker: DockerReader, selfName: string, now = new Date()): Promise<number> {
  const services = await readControlPlane(docker, selfName);
  if (!services) return 0;
  await db.instance.updateMany({ where: { id: 1 }, data: { controlPlane: services as unknown as Prisma.InputJsonValue, controlPlaneAt: now } });
  return services.length;
}
