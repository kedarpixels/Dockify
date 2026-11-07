/**
 * Anonymous Docker volumes that no container uses any more. Before managed services had named
 * volumes, each redeploy of a database left its data on one of these, and any image can declare one.
 * Dockify removes only the ones it can prove hold nothing of anyone's: empty ones, and an older
 * version's restore test copies (data/leftovers.ts). The janitor lists the rest in the activity log,
 * once each time the set changes, so they are never leaked silently and the owner decides.
 */
import type { Db, Prisma } from "@dockify/db";
import type { DiskUsageVolume } from "@dockify/engine";

/** Docker names an anonymous volume by 64 hex characters, and from 23.0 labels it too. */
const ANONYMOUS_NAME = /^[0-9a-f]{64}$/;
const ANONYMOUS_LABEL = "com.docker.volume.anonymous";
export const UNUSED_VOLUMES_ACTION = "janitor.volumes.unused";

export interface UnusedVolume {
  name: string;
  /** Null when Docker could not size it. */
  sizeBytes: number | null;
}

export const isAnonymousVolume = (v: Pick<DiskUsageVolume, "Name" | "Labels">): boolean => ANONYMOUS_NAME.test(v.Name) || v.Labels?.[ANONYMOUS_LABEL] !== undefined;

/** Anonymous volumes no container, running or stopped, refers to. Sorted by name. */
export function unusedAnonymousVolumes(volumes: readonly DiskUsageVolume[]): UnusedVolume[] {
  return volumes
    .filter((v) => isAnonymousVolume(v) && v.UsageData?.RefCount === 0)
    .map((v) => ({ name: v.Name, sizeBytes: v.UsageData && v.UsageData.Size >= 0 ? v.UsageData.Size : null }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const size = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

/** The names a previous report listed, read back from its changes. */
function reported(changes: Prisma.JsonValue | null | undefined): string {
  if (!Array.isArray(changes)) return "";
  return changes.map((c) => (c && typeof c === "object" && !Array.isArray(c) ? String((c as { key?: unknown }).key ?? "") : "")).join(",");
}

/**
 * Records what each app volume takes on disk (Volume.sizeBytes, the Resources page), from the same
 * read. A volume Docker could not size keeps its last value. Returns how many rows changed.
 */
export async function recordVolumeSizes(db: Db, volumes: readonly DiskUsageVolume[]): Promise<number> {
  const sized = new Map(volumes.filter((v) => v.UsageData && v.UsageData.Size >= 0).map((v) => [v.Name, BigInt(v.UsageData!.Size)]));
  if (!sized.size) return 0;
  const rows = await db.volume.findMany({ where: { name: { in: [...sized.keys()] } }, select: { id: true, name: true, sizeBytes: true } });
  let changed = 0;
  for (const r of rows) {
    const size = sized.get(r.name)!;
    if (r.sizeBytes === size) continue;
    await db.volume.update({ where: { id: r.id }, data: { sizeBytes: size } });
    changed++;
  }
  return changed;
}

/**
 * Writes one activity row when the set of unused anonymous volumes differs from the last report
 * (including when it empties), and nothing otherwise. Returns the set.
 */
export async function reportUnusedVolumes(db: Db, volumes: readonly DiskUsageVolume[], now = new Date()): Promise<UnusedVolume[]> {
  const unused = unusedAnonymousVolumes(volumes);
  const last = await db.activityLog.findFirst({ where: { action: UNUSED_VOLUMES_ACTION }, orderBy: { at: "desc" }, select: { changes: true } });
  const key = unused.map((v) => v.name).join(",");
  if (last ? reported(last.changes) === key : !unused.length) return unused;
  const total = unused.reduce((n, v) => n + (v.sizeBytes ?? 0), 0);
  await db.activityLog.create({
    data: {
      at: now,
      category: "system",
      action: UNUSED_VOLUMES_ACTION,
      actorType: "system",
      actorName: "Dockify",
      verb: unused.length ? `found ${unused.length} unused anonymous volume${unused.length === 1 ? "" : "s"} on` : "found no unused anonymous volumes left on",
      targetType: "server",
      targetLabel: "this server",
      suffix: unused.length
        ? `(${size(total)} in all). Dockify leaves them: one may hold an older service's data. Check what each holds, then remove it with docker volume rm.`
        : null,
      changes: unused.map((v) => ({ key: v.name, before: null, after: v.sizeBytes === null ? "size unknown" : size(v.sizeBytes) })) as Prisma.InputJsonValue,
    },
  });
  return unused;
}
