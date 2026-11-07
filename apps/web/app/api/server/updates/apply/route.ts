import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { VERSION_RE, applyUpdate } from "@/lib/pages/server-backups";

/** POST { version }: dump, update to that signed release, and roll back on any failure. Elevated. */
export async function POST(req: Request) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const { version } = await readJsonObject(req);
  if (typeof version !== "string" || !VERSION_RE.test(version)) return refuse(400, "Expected { version } such as 0.9.2");
  const r = await applyUpdate(version);
  return json(r.body, r.status);
}
