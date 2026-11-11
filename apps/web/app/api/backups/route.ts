import { json } from "@/lib/http";
import { getBackups } from "@/lib/pages/server-backups";

export async function GET() {
  return json(await getBackups());
}
