import { json } from "@/lib/http";
import { getDeploymentLogs, isDeploymentId } from "@/lib/pages/deployments";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isDeploymentId(id)) return json({ data: null, error: "Unknown deployment" }, 404);
  // A line number: absent means from the start; anything but a whole number is refused.
  const raw = new URL(request.url).searchParams.get("after") ?? "0";
  if (!/^\d{1,15}$/.test(raw)) return json({ data: null, error: "after must be a whole number" }, 400);
  const { status, body } = await getDeploymentLogs(id, Number(raw));
  return json(body, status);
}
