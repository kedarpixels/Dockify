import { json } from "@/lib/http";
import { getStatusPage, PUBLIC_CACHE } from "@/lib/pages/status-page";

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await getStatusPage(slug);
  if (result.kind === "ok") return Response.json(result.data, { headers: PUBLIC_CACHE });
  if (result.kind === "missing") return Response.json({ error: "Not found" }, { status: 404, headers: PUBLIC_CACHE });
  return json({ error: "Status is unavailable right now" }, 502);
}
