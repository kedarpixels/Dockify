import { guardWrite, refuse } from "@/lib/http";
import { forward, isId } from "@/lib/pages/resources-domains";

/** Detaches the domain and drops its certificate. Elevated on the API. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const refused = guardWrite(request, { json: false });
  if (refused) return refused;
  const { id } = await params;
  if (!isId(id)) return refuse(404, "Unknown domain");
  // Dockify removes the Cloudflare record it made for this domain unless the owner chose to keep it.
  const keep = new URL(request.url).searchParams.get("keepRecord") === "1";
  return forward("DELETE", `/api/v1/domains/${id}${keep ? "?keepRecord=1" : ""}`);
}
