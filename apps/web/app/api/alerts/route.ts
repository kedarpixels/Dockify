import { json } from "@/lib/http";
import { getAlerts } from "@/lib/pages/alerts";

export async function GET() {
  const result = await getAlerts();
  return json(result, result.data ? 200 : result.source === "none" ? 503 : 502);
}
