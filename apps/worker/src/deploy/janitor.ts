/**
 * The janitor keeps the disk from filling. Images are kept by reference, not by age: anything a
 * current, in-flight or one of the last N ready deployments of an app points at stays (those are
 * the rollback targets); every other Dockify-built or pulled image goes, plus dangling images. The
 * BuildKit cache is pruned down to a size cap rather than wiped, so builds stay fast. Old
 * deployments beyond the kept ready ones are deleted after the retention window, logs with them.
 * Images of apps that no longer exist go whatever their age. Volumes are not removed here: the
 * anonymous ones no container uses are listed in Activity. The wider sweep (scratch copies, empty
 * volumes, orphaned networks and containers) runs just before this pass (wiring.ts).
 */
import type { Db } from "@dockify/db";
import { recordVolumeSizes, reportUnusedVolumes } from "../data/volumes.ts";
import type { DeployConfig } from "./config.ts";
import { canonicalName, LABEL, parkedNames } from "./containers.ts";
import type { DiskUsageVolume, DockerApi, ImageSummary } from "@dockify/engine";
import { isConflict, isNotFound } from "@dockify/engine";
import { reason } from "@dockify/engine";
import { IN_FLIGHT } from "./pipeline.ts";
import { appsHere } from "../server/apps-here.ts";
import type { Builder } from "../server/runtime.ts";

/** Keep any image built or pulled within this window: a deploy may be about to use it. */
export const IMAGE_MIN_AGE_MS = 60 * 60_000;

export interface DeploymentRef {
  id: string;
  appId: string;
  status: string;
  imageId: string | null;
  createdAt: Date;
  /** Set on a preview deployment: never a production rollback target. */
  previewId?: string | null;
}

export interface Retention {
  keepImages: Set<string>;
  deleteDeployments: string[];
}

/** Pure: which image ids to keep and which deployment rows to delete. */
export function computeRetention(rows: DeploymentRef[], currentIds: Set<string>, keepReady: number, cutoff: Date): Retention {
  const keepImages = new Set<string>();
  const keepRows = new Set<string>();
  const byApp = new Map<string, DeploymentRef[]>();
  for (const r of rows) {
    const list = byApp.get(r.appId) ?? [];
    list.push(r);
    byApp.set(r.appId, list);
  }
  for (const list of byApp.values()) {
    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    let ready = 0;
    for (const r of list) {
      // A preview deployment is kept only while it is what a live preview serves (or in flight);
      // it never takes one of the app's rollback slots.
      const isPreview = !!r.previewId;
      const keep =
        currentIds.has(r.id) ||
        (IN_FLIGHT as readonly string[]).includes(r.status) ||
        (!isPreview && r.status === "ready" && ready++ < keepReady);
      if (keep) {
        keepRows.add(r.id);
        if (r.imageId) keepImages.add(r.imageId);
      }
    }
  }
  const deleteDeployments = rows.filter((r) => !keepRows.has(r.id) && r.createdAt < cutoff).map((r) => r.id);
  return { keepImages, deleteDeployments };
}

/** The image tag a build gets (build.ts imageNameFor), which names the app it belongs to. */
const APP_IMAGE_TAG = /^dockify\/app-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/;

/**
 * Every image Dockify built. A Dockerfile build carries the dockify.managed label; a Railpack build
 * cannot (its frontend takes no label option), so it is known by its dockify/app-<id> tag.
 */
export async function builtImages(docker: Pick<DockerApi, "listImages">): Promise<ImageSummary[]> {
  const [labelled, all] = await Promise.all([docker.listImages({ "dockify.managed": "true" }), docker.listImages({})]);
  const byId = new Map(labelled.map((i) => [i.Id, i]));
  for (const i of all) if (!byId.has(i.Id) && (i.RepoTags ?? []).some((t) => APP_IMAGE_TAG.test(t))) byId.set(i.Id, i);
  return [...byId.values()];
}

/**
 * Tagged builds of apps that are gone from this server. Their deployment rows went with the app, so nothing
 * keeps them and no retention rule ever names them. By tag, so an image with two tags loses both.
 * One a container still uses stays until the next pass.
 */
export async function removeDeletedAppImages(db: Db, docker: Pick<DockerApi, "listImages" | "removeImage">, serverId: string): Promise<{ removed: number; bytes: number }> {
  const images = await builtImages(docker);
  const tagged = images.flatMap((img) => (img.RepoTags ?? []).flatMap((tag) => {
    const appId = APP_IMAGE_TAG.exec(tag)?.[1];
    return appId ? [{ tag, appId, img }] : [];
  }));
  if (!tagged.length) return { removed: 0, bytes: 0 };
  const live = new Set((await db.app.findMany({ where: { id: { in: [...new Set(tagged.map((t) => t.appId))] }, ...appsHere(serverId) }, select: { id: true } })).map((a) => a.id));
  let removed = 0;
  let bytes = 0;
  const counted = new Set<string>();
  for (const t of tagged) {
    if (live.has(t.appId)) continue;
    try {
      await docker.removeImage(t.tag);
      removed++;
      if (!counted.has(t.img.Id)) bytes += t.img.Size;
      counted.add(t.img.Id);
    } catch (e) {
      if (!isConflict(e) && !isNotFound(e)) throw e;
    }
  }
  return { removed, bytes };
}

export interface LoadedRetention {
  plan: Retention;
  /** Every image id a deployment row points at. Images pulled for image-based apps carry no label. */
  referenced: Set<string>;
}

/**
 * Reads what the retention rules need of this server's rows and applies them. The janitor and the
 * disk prune both call this, so what one keeps the other keeps too.
 */
export async function loadRetention(db: Db, config: Pick<DeployConfig, "keepReady" | "deploymentRetentionDays">, now: Date, serverId: string): Promise<LoadedRetention> {
  const rows = await db.deployment.findMany({ where: appsHere(serverId), select: { id: true, appId: true, status: true, imageId: true, createdAt: true, previewId: true } });
  const apps = await db.app.findMany({ where: { currentDeploymentId: { not: null }, ...appsHere(serverId) }, select: { currentDeploymentId: true } });
  // Live previews keep the image they serve (asleep ones too, for a fast wake).
  const live = await db.previewDeployment.findMany({
    where: { currentDeploymentId: { not: null }, env: { status: { in: ["building", "ready", "asleep", "failed"] } }, app: appsHere(serverId) },
    select: { currentDeploymentId: true },
  });
  const current = new Set([...apps, ...live].map((a) => a.currentDeploymentId!));
  const cutoff = new Date(now.getTime() - config.deploymentRetentionDays * 86_400_000);
  return {
    plan: computeRetention(rows, current, config.keepReady, cutoff),
    referenced: new Set(rows.map((r) => r.imageId).filter((x): x is string => !!x)),
  };
}

export const PARKED_ACTION = "janitor.containers.parked";

/**
 * Containers a dead worker left parked and no deploy is coming back for. One may hold an app that is
 * now down, another may be old code still running next to the new, and only the next deploy of that
 * app can tell which (swap.ts), so they are reported, once each time the set changes.
 */
export async function reportParked(db: Db, docker: Pick<DockerApi, "listContainers">, serverId: string, now: Date): Promise<string[]> {
  const rows = await docker.listContainers({ "dockify.managed": "true" });
  const byApp = new Map<string, string[]>();
  for (const c of rows) {
    const appId = c.Labels[LABEL.app];
    const names = appId ? parkedNames([c], appId) : [];
    if (appId && names.length) byApp.set(appId, [...(byApp.get(appId) ?? []), ...names]);
  }
  const busy = byApp.size ? await db.deployment.findMany({ where: { appId: { in: [...byApp.keys()] }, status: { in: [...IN_FLIGHT] }, ...appsHere(serverId) }, select: { appId: true } }) : [];
  for (const d of busy) byApp.delete(d.appId);
  const parked = [...byApp.values()].flat().sort();
  const last = await db.activityLog.findFirst({ where: { action: PARKED_ACTION }, orderBy: { at: "desc" }, select: { changes: true } });
  const before = Array.isArray(last?.changes) ? (last.changes as Array<{ key?: string }>).map((c) => c.key ?? "").join(",") : "";
  if (parked.join(",") === before) return parked;
  await db.activityLog.create({
    data: {
      at: now, category: "system", action: PARKED_ACTION, actorType: "system", actorName: "Dockify",
      verb: parked.length ? `found ${parked.length} container${parked.length === 1 ? "" : "s"} an interrupted deploy left parked on` : "found no containers left parked on",
      targetType: "server", targetLabel: "this server",
      suffix: parked.length ? "Deploy each app again: that takes back a parked container or removes it." : null,
      changes: parked.map((name) => ({ key: name, before: null, after: "parked" })),
    },
  });
  return parked;
}

export const ORPHANS_ACTION = "janitor.containers.orphaned";
/** A container this new is left alone, whatever its labels say: its row may only just be going. */
export const ORPHAN_GRACE_MS = 60 * 60_000;
const APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOT_AN_APP_CONTAINER = ["com.docker.compose.project", "com.docker.compose.service", "dockify.preview", "dockify.preview.app"];

/**
 * Removes tenant containers whose app row is gone. A worker that dies mid-deploy, followed by a delete
 * of that app, can leave one that no teardown will ever name. It has to prove what it is: the managed
 * label, an app id in the app label, a name of dk-<that id> or dk-<that id>-<suffix>, no Compose or
 * preview label, and older than the grace period. Any app row anywhere keeps it, and a failed removal
 * waits for the next pass. Volumes stay: what a named one holds is not for a sweep to judge.
 */
export async function removeOrphanContainers(db: Db, docker: Pick<DockerApi, "listContainers" | "removeContainer">, now: Date, log: (msg: string, extra?: object) => void = () => {}): Promise<string[]> {
  const rows = await docker.listContainers({ "dockify.managed": "true" });
  const candidates = rows.flatMap((c) => {
    const appId = c.Labels[LABEL.app];
    if (!appId || !APP_ID.test(appId) || c.Labels["dockify.managed"] !== "true") return [];
    if (NOT_AN_APP_CONTAINER.some((k) => c.Labels[k])) return [];
    const name = c.Names.map((n) => n.replace(/^\//, "")).find((n) => n === canonicalName(appId) || n.startsWith(`${canonicalName(appId)}-`));
    if (!name || !c.Created || now.getTime() - c.Created * 1000 < ORPHAN_GRACE_MS) return [];
    return [{ id: c.Id, appId, name }];
  });
  if (!candidates.length) return [];
  const live = new Set((await db.app.findMany({ where: { id: { in: [...new Set(candidates.map((c) => c.appId))] } }, select: { id: true } })).map((a) => a.id));
  const removed: string[] = [];
  for (const c of candidates) {
    if (live.has(c.appId)) continue;
    try {
      await docker.removeContainer(c.id);
      removed.push(c.name);
    } catch (e) {
      if (!isConflict(e) && !isNotFound(e)) log("could not remove an orphaned container", { container: c.name, error: reason(e) });
    }
  }
  if (removed.length) {
    await db.activityLog.create({
      data: {
        at: now, category: "system", action: ORPHANS_ACTION, actorType: "system", actorName: "Dockify",
        verb: `removed ${removed.length} container${removed.length === 1 ? "" : "s"} of deleted apps from`,
        targetType: "server", targetLabel: "this server",
        changes: removed.map((name) => ({ key: name, before: "orphaned", after: null })),
      },
    });
  }
  return removed;
}

export interface JanitorReport {
  imagesRemoved: number;
  bytesFreed: number;
  deploymentsDeleted: number;
  cacheMessage: string;
  /** Anonymous volumes no container uses: listed in Activity, never removed (data/volumes.ts). Null when not read. */
  unusedVolumes: number | null;
}

export interface JanitorDeps {
  db: Db;
  docker: DockerApi;
  config: DeployConfig;
  serverId: string;
  builder: Pick<Builder, "trimCache">;
  /** Every local volume with its usage (GET /system/df?type=volume). Without it, volumes are not reported. */
  volumes?: () => Promise<DiskUsageVolume[]>;
  now?: () => Date;
}

export async function runJanitor(deps: JanitorDeps): Promise<JanitorReport> {
  const { db, docker, config, serverId } = deps;
  const now = deps.now?.() ?? new Date();
  // Images pulled for image-based apps carry no label; they are known through deployment rows.
  const { plan, referenced: pulledIds } = await loadRetention(db, config, now, serverId);

  const gone = await removeDeletedAppImages(db, docker, serverId);
  let imagesRemoved = gone.removed;
  let bytesFreed = gone.bytes;
  const candidates: ImageSummary[] = [
    ...(await builtImages(docker)),
    ...(await docker.listImages({}, true)),
  ];
  const seen = new Set<string>();
  for (const img of candidates) {
    if (seen.has(img.Id) || plan.keepImages.has(img.Id)) continue;
    // A deploy can pin and build/pull an image after the row snapshot above but before it creates
    // the container that keeps it. Never remove a very fresh image, so that race cannot fail it.
    if (img.Created * 1000 > now.getTime() - IMAGE_MIN_AGE_MS) continue;
    seen.add(img.Id);
    try {
      await docker.removeImage(img.Id);
      imagesRemoved++;
      bytesFreed += img.Size;
    } catch (e) {
      // In use by a container (a parked one, a release one-off): leave it for the next pass.
      if (!isConflict(e) && !isNotFound(e)) throw e;
    }
  }
  for (const id of pulledIds) {
    if (plan.keepImages.has(id) || seen.has(id)) continue;
    try {
      const info = await docker.inspectImage(id);
      await docker.removeImage(id);
      imagesRemoved++;
      bytesFreed += info.Size;
    } catch (e) {
      if (!isConflict(e) && !isNotFound(e)) throw e;
    }
  }

  let deploymentsDeleted = 0;
  for (let i = 0; i < plan.deleteDeployments.length; i += 500) {
    const ids = plan.deleteDeployments.slice(i, i + 500);
    // The sealed env snapshot is a separate row the deployment points at; it goes too.
    const snaps = await db.deployment.findMany({ where: { id: { in: ids }, envSecretId: { not: null } }, select: { envSecretId: true } });
    deploymentsDeleted += await db.$transaction(async (tx) => {
      const n = (await tx.deployment.deleteMany({ where: { id: { in: ids } } })).count;
      await tx.secret.deleteMany({ where: { id: { in: snaps.map((s) => s.envSecretId!) }, kind: "env_snapshot" } });
      return n;
    });
  }

  let cacheMessage: string;
  try {
    await deps.builder.trimCache(config.buildCacheBytes);
    cacheMessage = `build cache pruned to ${Math.round(config.buildCacheBytes / 1024 ** 3)} GiB`;
  } catch (e) {
    cacheMessage = `build cache prune failed: ${reason(e)}`;
  }

  // Volumes are never removed here; unused anonymous ones are reported so none leaks silently, and
  // each app volume's size is recorded for the Resources page.
  await reportParked(db, docker, serverId, now).catch(() => {
    // Only informs; the next pass reports.
  });
  let unusedVolumes: number | null = null;
  if (deps.volumes) {
    try {
      const volumes = await deps.volumes();
      await recordVolumeSizes(db, volumes);
      unusedVolumes = (await reportUnusedVolumes(db, volumes, now)).length;
    } catch {
      // The disk read is slow on a big host and only informs; the next pass reports.
    }
  }
  return { imagesRemoved, bytesFreed, deploymentsDeleted, cacheMessage, unusedVolumes };
}
