import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { runBackup } from "@/lib/pages/server-backups";

/** POST { resourceId?, tier? }: one database, or every enabled one. Without a tier, each writes to every tier that is on. */
export async function POST(req: Request) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const { resourceId, tier } = await readJsonObject(req);
  // Only a missing id means every database; a malformed one must never widen to all of them.
  if (resourceId !== undefined && (typeof resourceId !== "string" || !resourceId)) return refuse(400, "resourceId must be a non-empty string");
  if (tier !== undefined && tier !== "local" && tier !== "offsite" && tier !== "both") return refuse(400, "tier must be local, offsite or both");
  const r = await runBackup(resourceId, tier);
  return json(r.body, r.status);
}
