import { json, refuse } from "@/lib/http";
import { getBranches, isGitId } from "@/lib/pages/git";
import { crossSiteRefusal } from "@/lib/same-origin";

/** GET /api/git/repos/:id/branches: the branches of one repository, the default first. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const reason = crossSiteRefusal(request.headers);
  if (reason) return refuse(403, reason);
  const { id } = await params;
  if (!isGitId(id)) return refuse(404, "Unknown repository");
  const { status, body } = await getBranches(id);
  return json(body, status);
}
