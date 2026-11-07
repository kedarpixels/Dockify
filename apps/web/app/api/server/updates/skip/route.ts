import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { VERSION_RE, skipUpdate } from "@/lib/pages/server-backups";

/** POST { version | null }: the scheduler leaves that version alone; null clears the skip. */
export async function POST(req: Request) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const { version } = await readJsonObject(req);
  if (version !== null && (typeof version !== "string" || !VERSION_RE.test(version))) return refuse(400, "Expected { version } such as 0.9.2, or null");
  const r = await skipUpdate(version);
  return json(r.body, r.status);
}
