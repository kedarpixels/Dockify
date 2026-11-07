import { apiRequest } from "@/lib/api";
import { json, refuse, upstreamStatus } from "@/lib/http";
import { previewCfDomains } from "@/lib/pages/dashboard-domain";
import { isPreviewMode } from "@/lib/preview-mode";

/** GET /api/domains/cloudflare: what Cloudflare says about every domain. Reads only zones the owner switched on. */
export async function GET() {
  if (process.env.DOCKIFY_API_URL) {
    // Every domain is a call to Cloudflare, a few at a time: more than a page's usual read.
    const r = await apiRequest<unknown>("/api/v1/integrations/cloudflare/domains", { timeoutMs: 30_000 });
    return r.ok ? json(r.data) : refuse(upstreamStatus(r.status), r.error, r.code ? { code: r.code } : {});
  }
  return isPreviewMode() ? previewCfDomains() : json({ connected: false, items: [], error: null });
}
