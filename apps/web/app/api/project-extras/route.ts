import { guardWrite, json, readJsonBody, refuse, upstreamStatus } from "@/lib/http";
import { getProjectExtras, runExtrasMutation, type ExtrasMutation } from "@/lib/pages/project-detail";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * GET /api/project-extras?slug=<slug>: the project page's env state, env history, previews
 * and status page, in one answer. Each part carries its own error, so one failing
 * upstream route never blanks the others.
 */
export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug") ?? "";
  if (!SLUG.test(slug)) return refuse(400, "That project is not valid");
  const result = await getProjectExtras(slug);
  return json(result, result.notFound ? 404 : 200);
}

/**
 * POST /api/project-extras: every write those sections make. The body is one typed
 * ExtrasMutation; `runExtrasMutation` checks every field and maps it onto a fixed API route, so
 * the browser can never reach an arbitrary upstream path. A refusal keeps the API's status: 401
 * ends the session, 403 with step_up_required asks for a step-up, 409 is a conflict to reload.
 */
export async function POST(request: Request) {
  const refused = guardWrite(request);
  if (refused) return refused;
  const read = await readJsonBody(request);
  if (!read.ok) return refuse(read.status, read.error);
  const m = read.value;
  if (!m || typeof m !== "object" || Array.isArray(m) || !("type" in m) || typeof m.type !== "string") return refuse(400, "That request is not valid");
  const result = await runExtrasMutation(m as ExtrasMutation);
  return json(result, result.ok ? 200 : upstreamStatus(result.status ?? 400));
}
