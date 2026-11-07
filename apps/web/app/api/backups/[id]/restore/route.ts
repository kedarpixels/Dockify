import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { NEW_DB_NAME, restoreBackup } from "@/lib/pages/server-backups";
import { hasReservedPrefix, isReservedServiceName, RESERVED_NAME_MESSAGE, RESERVED_SERVICE_MESSAGE } from "@/lib/validation";

/**
 * POST { mode: "new", name } restores into a new database beside the live one.
 * POST { mode: "replace", confirm } replaces the live database; `confirm` is the typed database.
 * Both are elevated on the API.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const body = await readJsonObject(req);
  const { id } = await params;
  if (body.mode === "new") {
    if (typeof body.name !== "string" || !NEW_DB_NAME.test(body.name)) {
      return refuse(400, "Use 2 to 40 lowercase letters, numbers or hyphens, starting with a letter");
    }
    if (hasReservedPrefix(body.name)) return refuse(400, RESERVED_NAME_MESSAGE);
    if (isReservedServiceName(body.name)) return refuse(400, RESERVED_SERVICE_MESSAGE);
    const r = await restoreBackup(id, { mode: "new", name: body.name });
    return json(r.body, r.status);
  }
  if (body.mode === "replace") {
    if (typeof body.confirm !== "string" || !body.confirm) return refuse(400, "Type the database to confirm");
    const r = await restoreBackup(id, { mode: "replace", confirm: body.confirm });
    return json(r.body, r.status);
  }
  return refuse(400, "Mode must be new or replace");
}
