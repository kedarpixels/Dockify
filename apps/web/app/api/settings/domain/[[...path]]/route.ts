import { apiRequest } from "@/lib/api";
import { HOST_RE } from "@/lib/dashboard-domain";
import { guardWrite, json, readJsonObject, refuse, upstreamStatus } from "@/lib/http";
import { previewDashboardDomain } from "@/lib/pages/dashboard-domain";
import { isPreviewMode } from "@/lib/preview-mode";

/* Each body is rebuilt from its checked fields. The API holds the rules: Admin only, step-up to change the address. */

const CF_ID = /^[0-9a-f]{32}$/;
type Ctx = { params: Promise<{ path?: string[] }> };

function recordBody(b: Record<string, unknown>): { proxied?: boolean; replace?: string[] } | null {
  const out: { proxied?: boolean; replace?: string[] } = {};
  if (b.proxied !== undefined) {
    if (typeof b.proxied !== "boolean") return null;
    out.proxied = b.proxied;
  }
  if (b.replace !== undefined) {
    if (!Array.isArray(b.replace) || b.replace.length > 10 || !b.replace.every((x) => typeof x === "string" && CF_ID.test(x))) return null;
    out.replace = b.replace as string[];
  }
  return out;
}

async function upstream(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<Response> {
  const r = await apiRequest<unknown>(`/api/v1/settings/domain${path}`, { method, ...(body === undefined ? {} : { body }), ...(path === "/check" ? { timeoutMs: 25_000 } : {}) });
  if (r.ok) return json(r.data ?? { ok: true }, r.status === 204 ? 200 : r.status);
  return refuse(upstreamStatus(r.status), r.error, r.code ? { code: r.code } : {});
}

const noSource = () => refuse(503, "No data source");

export async function GET(_req: Request, { params }: Ctx) {
  const { path = [] } = await params;
  if (path.length) return refuse(404, "Not found");
  if (process.env.DOCKIFY_API_URL) return upstream("GET", "");
  return isPreviewMode() ? previewDashboardDomain("GET", [], {}) : noSource();
}

export async function POST(request: Request, { params }: Ctx) {
  const refused = guardWrite(request);
  if (refused) return refused;
  const { path = [] } = await params;
  const b = await readJsonObject(request);
  const [leaf, extra] = path;
  if (extra) return refuse(404, "Not found");

  let forwardPath: string;
  let body: Record<string, unknown>;
  if (!leaf) {
    if (typeof b.hostname !== "string" || !HOST_RE.test(b.hostname)) return refuse(400, "Use a hostname such as dockify.example.com");
    forwardPath = "";
    body = { hostname: b.hostname };
  } else if (leaf === "check" || leaf === "switch") {
    forwardPath = `/${leaf}`;
    body = {};
  } else if (leaf === "record") {
    const rec = recordBody(b);
    if (!rec) return refuse(400, "That record request does not read");
    forwardPath = "/record";
    body = rec;
  } else {
    return refuse(404, "Not found");
  }
  if (process.env.DOCKIFY_API_URL) return upstream("POST", forwardPath, body);
  return isPreviewMode() ? previewDashboardDomain("POST", path, body) : noSource();
}

export async function DELETE(request: Request, { params }: Ctx) {
  const refused = guardWrite(request, { json: false });
  if (refused) return refused;
  const { path = [] } = await params;
  const [leaf, host, extra] = path;
  if (extra || (leaf && (leaf !== "previous" || !host || !HOST_RE.test(host)))) return refuse(404, "Not found");
  if (process.env.DOCKIFY_API_URL) return upstream("DELETE", leaf ? `/previous/${encodeURIComponent(host!)}` : "");
  return isPreviewMode() ? previewDashboardDomain("DELETE", path, {}) : noSource();
}
