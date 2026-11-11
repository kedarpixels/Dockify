import { apiRequest } from "@/lib/api";
import { HOST_RE } from "@/lib/dashboard-domain";
import { json, refuse, upstreamStatus } from "@/lib/http";
import { previewCfLookup } from "@/lib/pages/dashboard-domain";
import { isPreviewMode } from "@/lib/preview-mode";

export async function GET(request: Request) {
  const hostname = new URL(request.url).searchParams.get("hostname") ?? "";
  if (!HOST_RE.test(hostname)) return refuse(400, "Use a hostname such as app.example.com");
  if (process.env.DOCKIFY_API_URL) {
    const r = await apiRequest<unknown>("/api/v1/integrations/cloudflare/lookup", { query: { hostname } });
    return r.ok ? json(r.data) : refuse(upstreamStatus(r.status), r.error, r.code ? { code: r.code } : {});
  }
  return isPreviewMode() ? previewCfLookup(hostname) : json({ connected: false, state: null, error: null });
}
