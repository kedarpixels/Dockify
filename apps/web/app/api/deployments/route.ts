import { getDeploymentsForDay, isDay } from "@/lib/data";
import { json } from "@/lib/http";

/** GET /api/deployments?day=YYYY-MM-DD: one UTC day of deployments for the heatmap day panel. */
export async function GET(request: Request) {
  const day = new URL(request.url).searchParams.get("day") ?? "";
  if (!isDay(day)) return json({ day, data: null, error: "Day must be YYYY-MM-DD" }, 400);
  const result = await getDeploymentsForDay(day);
  return json(result, result.data ? 200 : result.source === "none" ? 503 : 502);
}
