import { apiRequest } from "@/lib/api";
import { guardWrite, json, readJsonObject, refuse, upstreamStatus } from "@/lib/http";
import { forward, isId } from "@/lib/pages/resources-domains";
import { previewServiceVersion } from "@/lib/pages/project-detail";
import { isPreviewMode } from "@/lib/preview-mode";

type Ctx = { params: Promise<{ id: string }> };
const VERSION = /^[\w.-]{1,20}$/;

/** GET /api/apps/:id/service-version: what a managed service runs and may move to. */
export async function GET(_request: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isId(id)) return refuse(400, "Invalid app");
  if (process.env.DOCKIFY_API_URL) {
    const r = await apiRequest<unknown>(`/api/v1/apps/${id}/service-version`);
    return r.ok ? json(r.data) : refuse(upstreamStatus(r.status), r.error, r.code ? { code: r.code } : {});
  }
  return isPreviewMode() ? json(previewServiceVersion(id)) : refuse(503, "The API is not configured");
}

/** POST /api/apps/:id/service-version: starts a change. Typed name in the body, step-up at the API. */
export async function POST(request: Request, { params }: Ctx) {
  const refused = guardWrite(request);
  if (refused) return refused;
  const { id } = await params;
  if (!isId(id)) return refuse(400, "Invalid app");
  const { version, confirm } = await readJsonObject(request);
  if (typeof version !== "string" || !VERSION.test(version) || typeof confirm !== "string" || confirm.length > 64) return refuse(400, "Invalid request");
  if (!process.env.DOCKIFY_API_URL && isPreviewMode()) return json(previewServiceVersion(id, "change"));
  return forward("POST", `/api/v1/apps/${id}/service-version`, { version, confirm });
}
