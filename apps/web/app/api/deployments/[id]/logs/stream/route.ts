import { json } from "@/lib/http";
import { isDeploymentId } from "@/lib/pages/deployments";
import { openBuildLogStream } from "@/lib/pages/vercel-logs";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isDeploymentId(id)) return json({ error: "Unknown deployment" }, 404);
  const raw = new URL(request.url).searchParams.get("after") ?? "0";
  if (!/^\d{1,15}$/.test(raw)) return json({ error: "after must be a whole number" }, 400);
  return openBuildLogStream(id, Number(raw), request.headers.get("last-event-id"), request.signal);
}
