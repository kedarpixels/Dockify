import { apiRequest } from "@/lib/api";
import { guardWrite, json, readJsonObject, refuse, upstreamStatus } from "@/lib/http";
import { forward, isId } from "@/lib/pages/resources-domains";
import { isPreviewMode } from "@/lib/preview-mode";

/** GET /api/domains/test: whether this server can offer a free test domain. Hidden when it cannot. */
export async function GET() {
  if (process.env.DOCKIFY_API_URL) {
    const r = await apiRequest<unknown>("/api/v1/domains/test-domain");
    return r.ok ? json(r.data) : refuse(upstreamStatus(r.status), r.error, r.code ? { code: r.code } : {});
  }
  if (isPreviewMode()) return json({ available: true, reason: null, suffix: "203-0-113-24.sslip.io" });
  return json({ available: false, reason: null, suffix: null });
}

/** POST /api/domains/test: one test domain for an app, on an explicit press. The API makes up the name. */
export async function POST(request: Request) {
  const refused = guardWrite(request);
  if (refused) return refused;
  const { appId } = await readJsonObject(request);
  if (!isId(appId)) return refuse(400, "Invalid app");
  // The preview applies its writes in local state, and New app creates no real app there.
  if (!process.env.DOCKIFY_API_URL && isPreviewMode()) return json({ ok: true });
  return forward("POST", "/api/v1/domains/test-domain", { appId });
}
