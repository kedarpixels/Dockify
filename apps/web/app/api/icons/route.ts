import { guardWrite, json, readJsonBody, refuse, upstreamStatus } from "@/lib/http";
import { runIconMutation } from "@/lib/pages/icons";

/**
 * POST /api/icons: the Icon control's one write, `{ target, id | slug, body }`. The mapper checks
 * the id, slug and body, so the browser can only ever reach the two fixed icon routes. A refusal
 * keeps the API's status, so a lapsed session (401) ends the page's session.
 */
export async function POST(request: Request) {
  const refused = guardWrite(request);
  if (refused) return refused;
  const read = await readJsonBody(request);
  if (!read.ok) return refuse(read.status, read.error);
  const result = await runIconMutation(read.value);
  return json(result, result.ok ? 200 : upstreamStatus(result.status ?? 400));
}
