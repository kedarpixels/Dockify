import { guardWrite, json, refuse } from "@/lib/http";
import { deleteOrphans } from "@/lib/pages/server-backups";

/** DELETE {}: every backup of a deleted database. The API refuses it while the database exists. Elevated. */
export async function DELETE(req: Request, { params }: { params: Promise<{ resourceId: string }> }) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const { resourceId } = await params;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(resourceId)) return refuse(400, "Unknown database");
  const r = await deleteOrphans(resourceId);
  return json(r.body, r.status);
}
