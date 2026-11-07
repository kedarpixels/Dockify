import { guardWrite, json, refuse } from "@/lib/http";
import { isAction, isDeploymentId, runDeploymentAction } from "@/lib/pages/deployments";

/** POST /api/deployments/:id/redeploy | rollback | cancel, forwarded to the Dockify API. The body is empty. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const refused = guardWrite(request, { json: false });
  if (refused) return refused;
  const { id, action } = await params;
  if (!isAction(action)) return refuse(404, "Unknown action");
  if (!isDeploymentId(id)) return refuse(404, "Unknown deployment");
  const { status, body } = await runDeploymentAction(id, action);
  return json(body, status);
}
