import { readDeployTemplate } from "@/components/new-app/template-spec";
import { guardWrite, json, readJsonBody, refuse } from "@/lib/http";
import { deployTemplate, listTemplates } from "@/lib/pages/new-app";
import { crossSiteRefusal } from "@/lib/same-origin";

/** GET /api/new-app/templates: what the release ships, and exactly what each one runs. */
export async function GET(request: Request) {
  const reason = crossSiteRefusal(request.headers);
  if (reason) return refuse(403, reason);
  const { status, body } = await listTemplates();
  return json(body, status);
}

/** POST /api/new-app/templates: deploys one. The API generates the secrets and checks every field again. */
export async function POST(request: Request) {
  const refused = guardWrite(request);
  if (refused) return refused;
  const body = await readJsonBody(request);
  if (!body.ok) return refuse(body.status, body.error);
  const input = readDeployTemplate(body.value);
  if (typeof input === "string") return refuse(400, input);
  const { status, body: answer } = await deployTemplate(input);
  return json(answer, status);
}
