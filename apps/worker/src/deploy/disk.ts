/**
 * The disk breakdown on the Server page, and the Prune button behind it, on the worker side.
 *
 * Docker is read through the socket proxy (GET /system/df, images and volumes only) and the build
 * cache through buildctl: builds run in Dockify's own rootless BuildKit, never in Docker's builder,
 * so Docker's build cache list would always be empty. A timer samples every few minutes into
 * Instance.hostDisk, and the prune job samples again right after it removes anything, so the page
 * shows the freed space at once.
 *
 * What a prune may remove follows the janitor's retention rules exactly (loadRetention). An image
 * that the current, an in-flight or one of the last N ready deployments of an app points at is a
 * rollback target and stays. So does any image a container was created from, any image younger
 * than the janitor's one hour guard, and any image Dockify did not build or pull for a deployment,
 * which keeps the control plane's own images out of reach. Volumes are never removed here. Logs
 * are not measured at all: Docker's log files live on the host, where the worker cannot see them,
 * so the page gets no logs slice rather than a guess.
 */
import type { Db, Prisma } from "@dockify/db";
import { PermanentJobError, stderrLog } from "../errors.ts";
import type { DeployConfig } from "./config.ts";
import { isConflict, isNotFound, type DiskUsage, type DiskUsageImage, type DiskUsageType, type DiskUsageVolume } from "@dockify/engine";
import { reason } from "@dockify/engine";
import { recordVolumeSizes } from "../data/volumes.ts";
import { IMAGE_MIN_AGE_MS, loadRetention, type LoadedRetention } from "./janitor.ts";
import type { Builder } from "../server/runtime.ts";

export type DiskSliceId = "images" | "buildCache" | "volumes";

/** One slice as Instance.hostDisk stores it and the api's server.get serves it. */
export interface DiskSlice {
  id: DiskSliceId;
  bytes: number;
  reclaimableBytes: number;
  count: number;
}

/** The order the page lists the slices in. */
const ORDER: readonly DiskSliceId[] = ["images", "buildCache", "volumes"];

/** How often the timer samples. A sample walks every volume, so it is not something to run often. */
export const SAMPLE_EVERY_MS = 5 * 60_000;
/** The first sample waits a little after boot, while Docker and BuildKit are busy starting things. */
const FIRST_SAMPLE_MS = 30_000;
/** Docker sizes each volume by walking its files, which can take minutes on a large host. */
const DF_TIMEOUT_MS = 3 * 60_000;
/** buildctl du reads BuildKit's own records, so it answers fast or not at all. */
const DU_TIMEOUT_MS = 60_000;
/** The same ceiling the janitor gives its own buildctl prune. */
const PRUNE_TIMEOUT_MS = 10 * 60_000;

const bytes = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

// ------------------------------------------------------------------ BuildKit

/** A BuildKit cache record, as buildctl prints client.UsageInfo with --format '{{json .}}'. */
export interface CacheRecord {
  id: string;
  inUse: boolean;
  /** Bytes, or -1 while BuildKit has not sized the record yet. */
  size: number;
  recordType: string;
  shared: boolean;
}

function toRecord(v: unknown): CacheRecord {
  const r = v as Partial<Record<keyof CacheRecord, unknown>> | null;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || typeof r.size !== "number" || typeof r.inUse !== "boolean") {
    throw new Error("buildctl printed a cache record without an id, a size and inUse");
  }
  return {
    id: r.id,
    inUse: r.inUse,
    size: r.size,
    recordType: typeof r.recordType === "string" && r.recordType ? r.recordType : "regular",
    shared: r.shared === true,
  };
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} did not print JSON`);
  }
}

/**
 * Reads `buildctl du --format '{{json .}}'`: the whole record list as one JSON array, or null when
 * the cache is empty. Anything else throws, so a changed output never reads as an empty cache.
 */
export function parseCacheUsage(text: string): CacheRecord[] {
  const t = text.trim();
  if (!t) throw new Error("buildctl du printed nothing");
  const v = parseJson(t, "buildctl du");
  if (v === null) return [];
  if (!Array.isArray(v)) throw new Error("buildctl du did not print a list of cache records");
  return v.map(toRecord);
}

/** Reads `buildctl prune --format '{{json .}}'`: one JSON record per line for each record it removed. */
export function parsePrunedRecords(text: string): CacheRecord[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => toRecord(parseJson(l, "buildctl prune")));
}

/** buildctl prune leaves these record types alone unless it is told --all, which this module never does. */
const KEPT_RECORD_TYPES = new Set(["internal", "frontend"]);

/**
 * Whether buildctl prune, run the way the prune job runs it, removes this record: nothing uses it,
 * it is not shared with an image store, and it is neither an internal nor a frontend record.
 */
export const isPrunableRecord = (r: CacheRecord): boolean => !r.inUse && !r.shared && !KEPT_RECORD_TYPES.has(r.recordType);

/** The cache's size and record count, and what a prune would free of it. */
export function buildCacheSlice(records: readonly CacheRecord[]): DiskSlice {
  let total = 0;
  let spare = 0;
  for (const r of records) {
    total += bytes(r.size);
    if (isPrunableRecord(r)) spare += bytes(r.size);
  }
  return { id: "buildCache", bytes: total, reclaimableBytes: spare, count: records.length };
}

// ------------------------------------------------------------------ images and volumes

/** What the retention rules keep, and what Dockify built or pulled. */
export interface Ownership {
  /** Images a rollback, a live app or preview, or a deploy in flight needs. */
  keep: ReadonlySet<string>;
  /** Images deployment rows point at: everything Dockify built or pulled for an app. */
  referenced: ReadonlySet<string>;
}

export const ownershipOf = (r: LoadedRetention): Ownership => ({ keep: r.plan.keepImages, referenced: r.referenced });

/** The repository of a tag ("ghcr.io/org/app:1" is "ghcr.io/org/app"), keeping a registry port. */
const repoOfTag = (tag: string): string => {
  const colon = tag.lastIndexOf(":");
  return colon > tag.lastIndexOf("/") ? tag.slice(0, colon) : tag;
};
const repoOfDigest = (ref: string): string => ref.split("@")[0] ?? ref;
const realRefs = (refs: readonly string[] | null | undefined, placeholder: string) => (refs ?? []).filter((r) => r && r !== placeholder);

/**
 * Whether Docker removes this image by id without force, which the prune never uses: it refuses
 * while two tags name the image, or while its references span more than one repository. Counting
 * such an image as reclaimable would promise bytes a prune can never free.
 */
export function deletableById(img: DiskUsageImage): boolean {
  const tags = realRefs(img.RepoTags, "<none>:<none>");
  if (tags.length > 1) return false;
  const repos = new Set([...tags.map(repoOfTag), ...realRefs(img.RepoDigests, "<none>@<none>").map(repoOfDigest)]);
  return repos.size <= 1;
}

/**
 * Pure: the images a prune may remove. An image qualifies only when Dockify made it (built with
 * the dockify.managed label, or built or pulled for a deployment), the retention rules do not keep
 * it, Docker counted no container created from it, no other image is built on it, Docker would
 * remove it by id without force, and it is older than the janitor's one hour guard. Everything
 * else on the host stays. That includes the control plane's images, among them a release pinned
 * by digest, which has no tag and so looks dangling to Docker.
 */
export function removableImages(images: readonly DiskUsageImage[], own: Ownership, nowMs: number): DiskUsageImage[] {
  const out: DiskUsageImage[] = [];
  const seen = new Set<string>();
  const parents = new Set(images.map((i) => i.ParentId).filter((p): p is string => !!p));
  for (const img of images) {
    if (seen.has(img.Id)) continue;
    seen.add(img.Id);
    if (own.keep.has(img.Id)) continue;
    // -1 means Docker did not count; only a counted zero shows no container was created from it.
    if (img.Containers !== 0) continue;
    // A deploy may have just built or pulled it and not yet created the container that keeps it.
    if (!(img.Created * 1000 <= nowMs - IMAGE_MIN_AGE_MS)) continue;
    // A Railpack build has no label (its frontend takes none), only its dockify/app-<id> tag.
    const built = img.Labels?.["dockify.managed"] === "true" || (img.RepoTags ?? []).some((t) => t.startsWith("dockify/app-"));
    if (!built && !own.referenced.has(img.Id)) continue;
    if (parents.has(img.Id) || !deletableById(img)) continue;
    out.push(img);
  }
  return out;
}

/**
 * Bytes this image shares with no other image. Removing it frees at least that much, so an
 * estimate built from it never promises more than a prune frees.
 */
export const uniqueBytes = (img: DiskUsageImage): number => (img.SharedSize >= 0 ? bytes(img.Size - img.SharedSize) : 0);

/** Every image on the host, each shared layer counted once, and what removing the removable ones frees. */
export function imagesSlice(df: DiskUsage, removable: readonly DiskUsageImage[]): DiskSlice {
  const images = df.Images ?? [];
  // Docker always sends LayersSize with images. Without it, each image's own bytes plus the largest
  // shared part is still a floor: those layers are on disk at least once.
  const total =
    typeof df.LayersSize === "number" && df.LayersSize >= 0
      ? Math.round(df.LayersSize)
      : images.reduce((n, i) => n + uniqueBytes(i), 0) + images.reduce((m, i) => Math.max(m, bytes(i.SharedSize)), 0);
  const spare = removable.reduce((n, i) => n + uniqueBytes(i), 0);
  return { id: "images", bytes: total, reclaimableBytes: Math.min(total, spare), count: images.length };
}

/**
 * The compose volume rootless BuildKit keeps its state in (deploy/docker-compose.yml). Its bytes
 * are the build cache slice already, so counting the volume under Volumes too would draw the same
 * bytes twice in the page's stacked bar.
 */
const BUILDKIT_VOLUME = "dockify-buildkit";

export const isBuildkitVolume = (v: DiskUsageVolume): boolean =>
  v.Labels?.["com.docker.compose.volume"] === BUILDKIT_VOLUME || v.Name === BUILDKIT_VOLUME || v.Name.endsWith(`_${BUILDKIT_VOLUME}`);

/** Every other volume's size and count. A volume holds data, so none of it is ever reclaimable here. */
export function volumesSlice(df: DiskUsage): DiskSlice {
  const vols = (df.Volumes ?? []).filter((v) => !isBuildkitVolume(v));
  return { id: "volumes", bytes: vols.reduce((n, v) => n + bytes(v.UsageData?.Size), 0), reclaimableBytes: 0, count: vols.length };
}

// ------------------------------------------------------------------ sampling

/** The two Docker calls this module makes. DockerClient has both. */
export interface DiskDocker {
  diskUsage(types: readonly DiskUsageType[], signal?: AbortSignal): Promise<DiskUsage>;
  removeImage(id: string): Promise<void>;
}

export interface DiskDeps {
  db: Db;
  docker: DiskDocker;
  config: Pick<DeployConfig, "keepReady" | "deploymentRetentionDays">;
  serverId: string;
  builder: Pick<Builder, "cacheUsage" | "pruneCache">;
  now?: () => Date;
  log?: (msg: string, extra?: object) => void;
}

const logOf = (deps: DiskDeps) => deps.log ?? stderrLog;

/** The slices last written, so a source that fails this time keeps its last reading. Malformed rows are dropped. */
export function storedSlices(raw: unknown): DiskSlice[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is DiskSlice =>
      !!s &&
      typeof s === "object" &&
      ORDER.includes((s as DiskSlice).id) &&
      typeof (s as DiskSlice).bytes === "number" &&
      typeof (s as DiskSlice).reclaimableBytes === "number",
  );
}

export interface Sample {
  slices: DiskSlice[];
  /** The slices read this time. The others were carried over from the stored sample. */
  fresh: ReadonlySet<DiskSliceId>;
}

export interface SampleOptions {
  /**
   * Size volumes too. Docker walks every volume's files to size it, the slow part of a sample. A
   * prune never touches volumes, so its own sample leaves them to the timer once one exists.
   */
  volumes: boolean;
}

/**
 * Reads every source it can reach and writes the breakdown. A source that fails keeps its last
 * stored slice, and the sample fails only when no source answered at all.
 */
export async function sampleDisk(deps: DiskDeps, opts: SampleOptions): Promise<Sample> {
  const startedAt = deps.now?.() ?? new Date();
  const stored = await deps.db.instance.findUnique({ where: { id: 1 }, select: { hostDisk: true } });
  const prev = new Map(storedSlices(stored?.hostDisk).map((s) => [s.id, s] as const));
  const withVolumes = opts.volumes || !prev.has("volumes");
  const [df, cache, retention] = await Promise.allSettled([
    deps.docker.diskUsage(withVolumes ? ["image", "volume"] : ["image"], AbortSignal.timeout(DF_TIMEOUT_MS)),
    deps.builder.cacheUsage(DU_TIMEOUT_MS).then(parseCacheUsage),
    loadRetention(deps.db, deps.config, startedAt, deps.serverId),
  ]);

  const next = new Map<DiskSliceId, DiskSlice>();
  const problems: string[] = [];
  if (df.status === "fulfilled") {
    // Without the retention rules nothing can be called reclaimable safely, so images keep their last reading.
    if (retention.status === "fulfilled") {
      next.set("images", imagesSlice(df.value, removableImages(df.value.Images ?? [], ownershipOf(retention.value), startedAt.getTime())));
    } else {
      problems.push(`retention: ${reason(retention.reason)}`);
    }
    if (withVolumes) {
      next.set("volumes", volumesSlice(df.value));
      // The same read gives each app volume's size, so the Resources page never waits for the janitor.
      await recordVolumeSizes(deps.db, df.value.Volumes ?? []).catch((e: unknown) => problems.push(`volume sizes: ${reason(e)}`));
    }
  } else {
    problems.push(`docker system df: ${reason(df.reason)}`);
  }
  if (cache.status === "fulfilled") next.set("buildCache", buildCacheSlice(cache.value));
  else problems.push(`buildctl du: ${reason(cache.reason)}`);
  if (problems.length) logOf(deps)("disk sample incomplete", { problems });
  if (!next.size) throw new Error(`no disk source answered (${problems.join("; ")})`);

  const fresh = new Set(next.keys());
  for (const [id, s] of prev) if (!next.has(id)) next.set(id, s);
  const slices = ORDER.flatMap((id) => {
    const s = next.get(id);
    return s ? [s] : [];
  });
  // Stamped with the time the readings began, and written only over an older sample: a slow
  // sample that began before a prune must never overwrite the breakdown the prune wrote after it.
  await deps.db.instance.updateMany({
    where: { id: 1, OR: [{ hostDiskAt: null }, { hostDiskAt: { lt: startedAt } }] },
    data: { hostDisk: slices as unknown as Prisma.InputJsonValue, hostDiskAt: startedAt },
  });
  return { slices, fresh };
}

export interface SamplerTimes {
  firstMs: number;
  everyMs: number;
}

/**
 * Samples on a timer, one pass at a time: a slow pass makes the next tick skip, rather than start a
 * second walk of the same volumes. It runs beside the job lanes, so it never holds up a deploy.
 * stop() waits for the pass in flight.
 */
export function startDiskSampler(deps: DiskDeps, times: SamplerTimes = { firstMs: FIRST_SAMPLE_MS, everyMs: SAMPLE_EVERY_MS }): { stop(): Promise<void> } {
  let running: Promise<void> | null = null;
  const tick = (): void => {
    if (running) return;
    running = sampleDisk(deps, { volumes: true })
      .then(
        () => undefined,
        (e: unknown) => logOf(deps)("disk sample failed", { error: reason(e) }),
      )
      .finally(() => {
        running = null;
      });
  };
  const first = setTimeout(tick, times.firstMs);
  const timer = setInterval(tick, times.everyMs);
  first.unref();
  timer.unref();
  return {
    async stop() {
      clearTimeout(first);
      clearInterval(timer);
      await running;
    },
  };
}

// ------------------------------------------------------------------ prune

export const PRUNE_TARGETS = ["images", "buildCache", "logs"] as const;
export type PruneTarget = (typeof PRUNE_TARGETS)[number];

/**
 * The targets a prune job names, in a fixed order. A job that names nothing, or anything else
 * (volumes above all), fails before it touches the disk: the api never queues one like that, so
 * such a payload is a bug or a forgery.
 */
export function parsePruneTargets(payload: unknown): PruneTarget[] {
  const raw = payload && typeof payload === "object" ? (payload as { targets?: unknown }).targets : undefined;
  if (!Array.isArray(raw) || !raw.length) throw new PermanentJobError("A prune must name what to remove");
  for (const t of raw) {
    if (!(PRUNE_TARGETS as readonly unknown[]).includes(t)) throw new PermanentJobError(`A prune never removes ${String(t).slice(0, 40)}`);
  }
  return PRUNE_TARGETS.filter((t) => raw.includes(t));
}

export interface PruneReport {
  reclaimedBytes: number;
  imagesRemoved: number;
  cacheRecordsRemoved: number;
}

/**
 * The prune job. It removes exactly what the payload names, samples the disk again, and leaves its
 * report on its own job row, where the api's server.prune request is waiting for it.
 */
export async function runPrune(deps: DiskDeps, job: { id: string; payload: unknown }): Promise<PruneReport> {
  const targets = parsePruneTargets(job.payload);
  const now = deps.now?.() ?? new Date();

  let imagesRemoved = 0;
  let imagesFreed = 0;
  let imagesBefore: number | null = null;
  if (targets.includes("images")) {
    const [retention, df] = await Promise.all([
      loadRetention(deps.db, deps.config, now, deps.serverId),
      deps.docker.diskUsage(["image"], AbortSignal.timeout(DF_TIMEOUT_MS)),
    ]);
    imagesBefore = imagesSlice(df, []).bytes;
    for (const img of removableImages(df.Images ?? [], ownershipOf(retention), now.getTime())) {
      try {
        await deps.docker.removeImage(img.Id);
        imagesRemoved++;
        imagesFreed += uniqueBytes(img);
      } catch (e) {
        // A container was created from it since the reading, or it is gone already: leave it.
        if (!isConflict(e) && !isNotFound(e)) throw e;
      }
    }
  }

  let cacheRecordsRemoved = 0;
  let cacheFreed = 0;
  if (targets.includes("buildCache")) {
    const pruned = parsePrunedRecords(await deps.builder.pruneCache(PRUNE_TIMEOUT_MS));
    cacheRecordsRemoved = pruned.length;
    cacheFreed = pruned.reduce((n, r) => n + bytes(r.size), 0);
  }
  // "logs" removes nothing: the worker cannot see Docker's log files, so it reports no logs slice either.

  let after: Sample | null = null;
  try {
    after = await sampleDisk(deps, { volumes: false });
  } catch (e) {
    logOf(deps)("disk sample after a prune failed", { error: reason(e) });
  }
  const imagesNow = after?.fresh.has("images") ? after.slices.find((s) => s.id === "images")?.bytes : undefined;
  // Each removed image's own bytes are certainly gone, and the slice shrinking also counts layers
  // only the removed images shared. Unless something else removed images at the same moment,
  // neither figure is more than the prune freed, so the larger one is the better floor.
  const shrunk = imagesBefore !== null && imagesNow !== undefined ? imagesBefore - imagesNow : 0;
  const report: PruneReport = { reclaimedBytes: Math.max(imagesFreed, shrunk) + cacheFreed, imagesRemoved, cacheRecordsRemoved };
  await deps.db.job.update({
    where: { id: job.id },
    data: { payload: { targets, result: { ...report, at: new Date().toISOString() } } as unknown as Prisma.InputJsonValue },
  });
  return report;
}
