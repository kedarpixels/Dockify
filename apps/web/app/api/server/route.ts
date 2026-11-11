import { json } from "@/lib/http";
import { getServer } from "@/lib/pages/server-backups";

export async function GET() {
  return json(await getServer());
}
