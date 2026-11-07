import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { runBackup } from "@/lib/pages/server-backups";

/** POST { resourceId? }: back up one database now, or every enabled one. */
export async function POST(req: Request) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const { resourceId } = await readJsonObject(req);
  // Only a missing id means every database; a malformed one must never widen to all of them.
  if (resourceId !== undefined && (typeof resourceId !== "string" || !resourceId)) return refuse(400, "resourceId must be a non-empty string");
  const r = await runBackup(resourceId);
  return json(r.body, r.status);
}
