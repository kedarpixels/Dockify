import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { isPruneTarget, pruneServer } from "@/lib/pages/server-backups";

/** POST { targets }: dangling images, build cache and rotated logs. Volumes are refused. */
export async function POST(req: Request) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const body = await readJsonObject(req);
  if (!Array.isArray(body.targets) || !body.targets.every(isPruneTarget)) return refuse(400, "Targets must be images, buildCache or logs");
  const targets = body.targets;
  if (!targets.length) return refuse(400, "Nothing to prune");
  const r = await pruneServer(targets);
  return json(r.body, r.status);
}
