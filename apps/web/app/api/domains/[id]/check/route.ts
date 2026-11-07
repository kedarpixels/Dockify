import { guardWrite, refuse } from "@/lib/http";
import { forward, isId } from "@/lib/pages/resources-domains";

/** POST /api/domains/:id/check: runs a fresh DNS lookup and answers with the updated domain. The body is empty. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guardWrite(request, { json: false });
  if (refused) return refused;
  const { id } = await params;
  if (!isId(id)) return refuse(404, "Unknown domain");
  return forward("POST", `/api/v1/domains/${id}/check`);
}
