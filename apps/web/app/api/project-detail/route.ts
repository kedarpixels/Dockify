import { guardWrite, json, readJsonBody, refuse, upstreamStatus } from "@/lib/http";
import { runMutation, type Mutation } from "@/lib/pages/project-detail";

/**
 * POST /api/project-detail: every write from the project and app pages and the New project popup.
 * The body is one typed Mutation; `runMutation` maps it onto a fixed API route, so the browser can
 * never reach an arbitrary upstream path. A refusal keeps the API's status, so a lapsed session
 * (401) ends the page's session and a step-up refusal (403, code step_up_required) asks for one.
 */
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
