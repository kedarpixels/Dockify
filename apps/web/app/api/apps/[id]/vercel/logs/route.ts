import { json } from "@/lib/http";
import { isDeploymentId } from "@/lib/pages/deployments";
import { getVercelRuntimeTail } from "@/lib/pages/vercel-logs";

export const dynamic = "force-dynamic";

/**
 * GET /api/apps/:id/vercel/logs?deployment=<id>: what a short read of Vercel's runtime logs brought.
 * The browser's signal goes on to the API, so a tab that leaves mid read frees its read slot at once.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deployment = new URL(request.url).searchParams.get("deployment");
  if (!isDeploymentId(id) || (deployment !== null && !isDeploymentId(deployment))) return json({ data: null, error: "Not found" }, 404);
  const { status, body } = await getVercelRuntimeTail(id, deployment, request.signal);
  return json(body, status);
}
