import { json } from "@/lib/http";
import { getDeployments, isFilter } from "@/lib/pages/deployments";

/** Longer filters are refused rather than forwarded. */
const MAX = 200;

/** GET /api/deployments/feed?cursor&status&project&q: one page of the deployments list. */
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const status = p.get("status");
  const cursor = p.get("cursor");
  const project = p.get("project") ?? undefined;
  const q = p.get("q") ?? undefined;
  if ((status !== null && !isFilter(status)) || [cursor, project, q].some((v) => (v?.length ?? 0) > MAX)) {
    return json({ source: "api", data: null, error: "Invalid filter", fetchedAt: new Date().toISOString() }, 400);
  }
  const result = await getDeployments({ cursor, status: status ?? "all", project, q });
  return json(result, result.data ? 200 : result.source === "none" ? 503 : 502);
}
