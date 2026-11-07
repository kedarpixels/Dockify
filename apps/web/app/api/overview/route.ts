import { getOverview } from "@/lib/data";
import { json } from "@/lib/http";

/** GET /api/overview: the overview snapshot the console polls. */
export async function GET() {
  return json(await getOverview());
}
