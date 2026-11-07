import { readCreate } from "@/components/new-app/spec";
import { guardWrite, json, readJsonBody, refuse } from "@/lib/http";
import { createApps } from "@/lib/pages/new-app";

/** POST /api/new-app: creates one app, or every app a Compose import mapped to, in a project. */
export async function POST(request: Request) {
  const refused = guardWrite(request);
  if (refused) return refused;
  const body = await readJsonBody(request);
  if (!body.ok) return refuse(body.status, body.error);
  const input = readCreate(body.value);
  if (typeof input === "string") return refuse(400, input);
  const { status, body: answer } = await createApps(input);
  return json(answer, status);
}
