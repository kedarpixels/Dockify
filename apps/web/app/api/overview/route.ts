import { getOverview } from "@/lib/data";
import { json } from "@/lib/http";

export async function GET() {
  return json(await getOverview());
}
