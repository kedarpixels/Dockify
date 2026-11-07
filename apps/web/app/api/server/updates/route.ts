import { json } from "@/lib/http";
import { getUpdates } from "@/lib/pages/server-backups";

/** The update status, polled while an update runs so the page follows it across the restart. */
export async function GET() {
  return json(await getUpdates());
}
