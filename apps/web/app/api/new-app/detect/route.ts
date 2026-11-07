import { readDetect } from "@/components/new-app/spec";
import { guardWrite, json, readJsonBody, refuse } from "@/lib/http";
import { detectBuild } from "@/lib/pages/new-app";

/** POST /api/new-app/detect: the build a repository branch would get, detected without running it. */
export async function POST(request: Request) {
  const refused = guardWrite(request);
  if (refused) return refused;
  const body = await readJsonBody(request);
  if (!body.ok) return refuse(body.status, body.error);
  const input = readDetect(body.value);
  if (typeof input === "string") return refuse(400, input);
  const { status, body: answer } = await detectBuild(input);
  return json(answer, status);
}
