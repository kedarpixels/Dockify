import { guardWrite, json } from "@/lib/http";
import { testBackup } from "@/lib/pages/server-backups";

/** POST {}: restore this backup into a throwaway container and record what it found. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guardWrite(req);
  if (refused) return refused;
  const r = await testBackup((await params).id);
  return json(r.body, r.status);
}
