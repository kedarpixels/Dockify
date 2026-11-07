import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { patchSchedule } from "@/lib/pages/server-backups";

/** PATCH { enabled }: the schedule switch. Elevated on the API. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const body = await readJsonObject(req);
  if (typeof body.enabled !== "boolean") return refuse(400, "Expected { enabled: boolean }");
  const r = await patchSchedule((await params).id, { enabled: body.enabled });
  return json(r.body, r.status);
}
