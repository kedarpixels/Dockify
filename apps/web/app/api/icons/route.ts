import { guardWrite, json, readJsonBody, refuse, upstreamStatus } from "@/lib/http";
import { runIconMutation } from "@/lib/pages/icons";

/** POST { target, id | slug, body }. The mapper checks all three, so the browser reaches only the two fixed icon routes. */
export async function POST(request: Request) {
  const refused = guardWrite(request);
  if (refused) return refused;
  const read = await readJsonBody(request);
  if (!read.ok) return refuse(read.status, read.error);
  const result = await runIconMutation(read.value);
  return json(result, result.ok ? 200 : upstreamStatus(result.status ?? 400));
}
