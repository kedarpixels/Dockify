import { json } from "@/lib/http";
import { getBackups } from "@/lib/pages/server-backups";

/** Runs and schedules for the page's refresh loop. */
export async function GET() {
  return json(await getBackups());
}
