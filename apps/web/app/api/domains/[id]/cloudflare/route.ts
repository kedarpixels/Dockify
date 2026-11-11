import { apiRequest } from "@/lib/api";
import { guardWrite, json, readJsonObject, refuse, upstreamStatus } from "@/lib/http";
import { previewCfRecord } from "@/lib/pages/dashboard-domain";
import { isId, previewDomainsForCloudflare } from "@/lib/pages/resources-domains";
import { isPreviewMode } from "@/lib/preview-mode";

const CF_ID = /^[0-9a-f]{32}$/;

/** Creates the record this domain needs. `replace` is the go-ahead to remove exactly those records first. Elevated on the API. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guardWrite(request);
  if (refused) return refused;
  const { id } = await params;
  if (!isId(id)) return refuse(404, "Unknown domain");
  const b = await readJsonObject(request);
  const body: { proxied?: boolean; replace?: string[] } = {};
  if (typeof b.proxied === "boolean") body.proxied = b.proxied;
  if (b.replace !== undefined) {
    if (!Array.isArray(b.replace) || b.replace.length > 10 || !b.replace.every((x) => typeof x === "string" && CF_ID.test(x))) return refuse(400, "That record request does not read");
    body.replace = b.replace as string[];
  }
  if (process.env.DOCKIFY_API_URL) {
    const r = await apiRequest<unknown>(`/api/v1/integrations/cloudflare/domains/${id}/record`, { method: "POST", body });
    return r.ok ? json(r.data) : refuse(upstreamStatus(r.status), r.error, r.code ? { code: r.code } : {});
  }
  if (!isPreviewMode()) return refuse(503, "No data source");
  const d = previewDomainsForCloudflare().find((x) => x.id === id);
  return d ? previewCfRecord(d.hostname, body) : refuse(404, "Unknown domain");
}
