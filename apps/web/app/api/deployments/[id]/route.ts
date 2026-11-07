import { json } from "@/lib/http";
import { getDeployment, isDeploymentId } from "@/lib/pages/deployments";

/** GET /api/deployments/:id: one deployment with its steps, for the detail page's refresh. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isDeploymentId(id)) return json({ data: null, notFound: true, error: "Unknown deployment" }, 404);
  const result = await getDeployment(id);
  return json(result, result.notFound ? 404 : result.data ? 200 : result.source === "none" ? 503 : 502);
}
