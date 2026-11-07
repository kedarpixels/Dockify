import { json } from "@/lib/http";
import { getServer } from "@/lib/pages/server-backups";

/** The server snapshot for the page's refresh loop. */
export async function GET() {
  return json(await getServer());
}
