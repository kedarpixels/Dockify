import { json, refuse } from "@/lib/http";
import { restoreProgress } from "@/lib/pages/server-backups";

/** GET how a restore that outlasted its request is going. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  const { id, jobId } = await params;
  const r = await restoreProgress(id, jobId);
  return r.ok ? json(r.data) : refuse(r.status, r.error);
}
