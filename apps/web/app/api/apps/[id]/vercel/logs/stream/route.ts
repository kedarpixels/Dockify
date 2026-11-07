import { json } from "@/lib/http";
import { isDeploymentId } from "@/lib/pages/deployments";
import { openVercelRuntimeStream } from "@/lib/pages/vercel-logs";

export const dynamic = "force-dynamic";

/** GET /api/apps/:id/vercel/logs/stream?deployment=<id>: Vercel's runtime logs as server-sent events. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deployment = new URL(request.url).searchParams.get("deployment");
  if (!isDeploymentId(id) || (deployment !== null && !isDeploymentId(deployment))) return json({ error: "Not found" }, 404);
  return openVercelRuntimeStream(id, deployment, request.signal);
}
