import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { pauseUpdates } from "@/lib/pages/server-backups";

/** POST { days: 0 | 7 }: pause automatic installs for 7 days, or resume them with 0. */
export async function POST(req: Request) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const { days } = await readJsonObject(req);
  if (days !== 0 && days !== 7) return refuse(400, "Expected { days } of 0 or 7");
  const r = await pauseUpdates(days);
  return json(r.body, r.status);
}
