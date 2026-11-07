import { json } from "@/lib/http";
import { getServerMetrics, isRange } from "@/lib/pages/server-backups";

/** GET ?range=1h|24h|7d, for the metric cards' range switch. */
export async function GET(req: Request) {
  const range = new URL(req.url).searchParams.get("range");
  if (!isRange(range)) return json({ source: "none", data: null, error: "Range must be 1h, 24h or 7d" }, 400);
  return json(await getServerMetrics(range));
}
