import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { UUID_RE, rollbackUpdate } from "@/lib/pages/server-backups";

/** POST { updateId }: dump again, restore the dump taken before that update, and bring its previous images back. Elevated. */
export async function POST(req: Request) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const { updateId } = await readJsonObject(req);
  if (typeof updateId !== "string" || !UUID_RE.test(updateId)) return refuse(400, "Expected { updateId } of a finished update");
  const r = await rollbackUpdate(updateId);
  return json(r.body, r.status);
}
