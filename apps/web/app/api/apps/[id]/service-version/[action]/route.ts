import { guardWrite, json, readJsonObject, refuse } from "@/lib/http";
import { forward, isId } from "@/lib/pages/resources-domains";
import { previewServiceVersion } from "@/lib/pages/project-detail";
import { isPreviewMode } from "@/lib/preview-mode";

/** POST /api/apps/:id/service-version/switch or /back: the owner's confirmation, typed. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const refused = guardWrite(request);
  if (refused) return refused;
  const { id, action } = await params;
  if (!isId(id) || (action !== "switch" && action !== "back")) return refuse(400, "Invalid request");
  const { confirm } = await readJsonObject(request);
  if (typeof confirm !== "string" || confirm.length > 64) return refuse(400, "Invalid request");
  if (!process.env.DOCKIFY_API_URL && isPreviewMode()) return json(previewServiceVersion(id, action));
  return forward("POST", `/api/v1/apps/${id}/service-version/${action}`, { confirm });
}
