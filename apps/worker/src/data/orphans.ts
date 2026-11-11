/**
 * Runs in the worker because the api mounts the backups volume read-only, so a compromised api cannot destroy
 * local backups. Object keys come from the database rows, never the job. An undeletable file keeps its row.
 */
import { DataError, type DataDeps } from "./context.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BackupDeleteResult {
  deleted: number;
  freedBytes: number;
  /** Rows kept because their file or object could not be deleted. */
  failed: number;
}

export async function deleteOrphanedBackups(deps: Pick<DataDeps, "db" | "storeFor">, jobId: string, payload: unknown): Promise<BackupDeleteResult> {
  const sourceAppId = (payload as { sourceAppId?: unknown } | null)?.sourceAppId;
  if (typeof sourceAppId !== "string" || !UUID.test(sourceAppId)) throw new DataError("backup_delete payload has no valid sourceAppId", true);
  const { db } = deps;
  if (await db.app.findUnique({ where: { id: sourceAppId }, select: { id: true } })) throw new DataError("That app still exists; its backups are not orphaned", true);
  const rows = await db.backup.findMany({ where: { sourceAppId, appId: null, kind: { not: "control_plane" } }, select: { id: true, objectKey: true, expiredAt: true, sizeBytes: true, destinationId: true, status: true } });
  const gone: string[] = [];
  let freedBytes = 0;
  let failed = 0;
  for (const r of rows) {
    if (r.status === "running") continue;
    if (r.objectKey && !r.expiredAt) {
      try {
        const { store } = await deps.storeFor(r.destinationId);
        const bytes = store.sizeOf ? await store.sizeOf(r.objectKey) : Number(r.sizeBytes ?? 0);
        await store.delete(r.objectKey);
        freedBytes += bytes;
      } catch {
        failed++;
        continue;
      }
    }
    gone.push(r.id);
  }
  const deleted = gone.length ? (await db.backup.deleteMany({ where: { id: { in: gone } } })).count : 0;
  const result: BackupDeleteResult = { deleted, freedBytes, failed };
  await db.job.update({ where: { id: jobId }, data: { payload: { sourceAppId, result: { ...result } } } });
  return result;
}
