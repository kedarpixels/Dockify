/**
 * Teardown work no single module owns: removing a deleted app (remove_app, queued by the projects
 * module in the same transaction that deletes the rows). Previews have their own teardown in
 * integrations/previews.ts.
 */
import type { Db } from "@dockify/db";
import { enqueue } from "@dockify/db";
import { LABEL } from "./deploy/containers.ts";
import { isNotFound, type DockerApi } from "@dockify/engine";
import { removeDeletedAppImages } from "./deploy/janitor.ts";
import { sweepEnvNetworks, type NetworkSweepDeps } from "./deploy/networks.ts";
import { removeRoute } from "./deploy/routes.ts";
import { appsHere } from "./server/apps-here.ts";
import { PermanentJobError } from "./errors.ts";
import type { RouteStore } from "./server/runtime.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VOLUME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

export interface RemoveAppPayload {
  appId: string;
  volumeNames: string[];
  domains: Array<{ hostname: string; cfZoneId: string | null; cfRecordId: string | null }>;
  /** Images its deployments ran, built or pulled. Absent from jobs an older api queued. */
  imageIds: string[];
}

export function parseRemoveApp(p: unknown): RemoveAppPayload {
  const o = (p ?? {}) as Record<string, unknown>;
  if (typeof o.appId !== "string" || !UUID.test(o.appId)) throw new PermanentJobError("remove_app payload has no appId");
  const volumeNames = Array.isArray(o.volumeNames) ? o.volumeNames.filter((v): v is string => typeof v === "string" && VOLUME.test(v)) : [];
  const domains = Array.isArray(o.domains)
    ? o.domains.flatMap((d) => {
        const x = (d ?? {}) as Record<string, unknown>;
        if (typeof x.hostname !== "string") return [];
        return [{ hostname: x.hostname, cfZoneId: typeof x.cfZoneId === "string" ? x.cfZoneId : null, cfRecordId: typeof x.cfRecordId === "string" ? x.cfRecordId : null }];
      })
    : [];
  const imageIds = Array.isArray(o.imageIds) ? o.imageIds.filter((v): v is string => typeof v === "string" && IMAGE_ID.test(v)) : [];
  return { appId: o.appId, volumeNames, domains, imageIds };
}

export interface TeardownDeps {
  db: Db;
  docker: DockerApi;
  routes: RouteStore;
  removeVolume(name: string): Promise<void>;
  /** Removes the environment networks nothing needs any more, which this app's going may leave. */
  networks?: Omit<NetworkSweepDeps, "db" | "serverId">;
}

/**
 * Idempotent: every container labelled with the app (live, parked, release one-offs) with the
 * anonymous volumes only it used, its route file, its named volumes, the images it alone ran, the
 * Cloudflare objects Dockify recorded for its domains (handed to the edge module, which deletes only
 * those ids), and its environment's network if that environment went too. Runs after the rows are
 * gone, so it only reads the payload.
 */
export async function removeApp(deps: TeardownDeps, payload: unknown, serverId: string): Promise<void> {
  const p = parseRemoveApp(payload);
  await removeRoute(deps.routes, p.appId);
  const containers = await deps.docker.listContainers({ [LABEL.app]: p.appId, "dockify.managed": "true" });
  for (const c of containers) {
    await deps.docker.removeContainer(c.Id, { volumes: true }).catch((e: unknown) => {
      if (!isNotFound(e)) throw e;
    });
  }
  for (const v of p.volumeNames) await deps.removeVolume(v);
  // Best effort, like the janitor it shares its rule with: a leftover image never fails a teardown.
  await removeDeletedAppImages(deps.db, deps.docker, serverId).catch(() => {});
  for (const id of p.imageIds) {
    if (await deps.db.deployment.findFirst({ where: { imageId: id, ...appsHere(serverId) }, select: { id: true } })) continue;
    await deps.docker.removeImage(id).catch(() => {});
  }
  if (deps.networks) await sweepEnvNetworks({ db: deps.db, serverId, ...deps.networks }).catch(() => {});
  for (const d of p.domains) {
    if (!d.cfZoneId || !d.cfRecordId) continue;
    await enqueue(deps.db, {
      kind: "edge_cf_unwire",
      lane: "deploy",
      serverId,
      payload: { hostname: d.hostname, zoneId: d.cfZoneId, recordId: d.cfRecordId, tunnelId: null },
      dedupeKey: `edge.cf.unwire:${d.cfRecordId}`,
      maxAttempts: 5,
    });
  }
}
