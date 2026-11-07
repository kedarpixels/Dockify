import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { parsePolicyBody, saveUpdatePolicy } from "@/lib/pages/server-backups";

/** PUT { mode, channel, window, timeZone }: how and when Dockify installs updates on its own. Elevated. */
export async function PUT(req: Request) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const parsed = parsePolicyBody(await readJsonObject(req));
  if (!parsed.ok) return refuse(400, parsed.error);
  const r = await saveUpdatePolicy(parsed.body);
  return json(r.body, r.status);
}
