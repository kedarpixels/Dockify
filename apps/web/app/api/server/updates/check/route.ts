import { guardWrite, json } from "@/lib/http";
import { checkUpdates } from "@/lib/pages/server-backups";

/** POST {}: ask the signed release feed again. */
export async function POST(req: Request) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const r = await checkUpdates();
  return json(r.body, r.status);
}
