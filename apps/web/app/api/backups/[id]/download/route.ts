import { downloadBackup } from "@/lib/pages/server-backups";

/** Streams one backup file from the API. Elevated: the page confirms it is you before it links here. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return downloadBackup((await params).id, req.signal);
}
