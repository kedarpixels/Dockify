import { guardWrite, json, refuse } from "@/lib/http";
import { deleteInstallation, isGitId } from "@/lib/pages/git";

/** DELETE /api/git/installations/:id: disconnects one GitHub account. Elevated on the API. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guardWrite(request, { json: false });
  if (refused) return refused;
  const { id } = await params;
  if (!isGitId(id)) return refuse(404, "Unknown installation");
  const { status, body } = await deleteInstallation(id);
  return json(body, status);
}
