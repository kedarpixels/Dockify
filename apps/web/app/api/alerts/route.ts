import { json } from "@/lib/http";
import { getAlerts } from "@/lib/pages/alerts";

/** GET /api/alerts: rules, recent events, mutes and channels, for the page's poll. */
export async function GET() {
  const result = await getAlerts();
  return json(result, result.data ? 200 : result.source === "none" ? 503 : 502);
}
