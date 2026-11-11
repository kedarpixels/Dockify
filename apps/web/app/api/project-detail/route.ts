import { guardWrite, json, readJsonBody, refuse, upstreamStatus } from "@/lib/http";
import { runMutation, type Mutation } from "@/lib/pages/project-detail";

/** runMutation maps the typed body onto a fixed API route, so the browser can never reach an arbitrary upstream path. */
export async function POST(request: Request) {
  const refused = guardWrite(request);
  if (refused) return refused;
  const read = await readJsonBody(request);
  if (!read.ok) return refuse(read.status, read.error);
  const m = read.value;
  // null, an array or a bare value would throw inside the mapper; the field checks happen there.
  if (!m || typeof m !== "object" || Array.isArray(m) || !("type" in m) || typeof m.type !== "string") return refuse(400, "That request is not valid");
  const result = await runMutation(m as Mutation);
  return json(result, result.ok ? 200 : upstreamStatus(result.status ?? 400));
}
