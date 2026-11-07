import { json, refuse } from "@/lib/http";
import { getNewAppContext } from "@/lib/pages/new-app";
import { crossSiteRefusal } from "@/lib/same-origin";

/** GET /api/new-app/context: the registries and the Vercel account the new app flow can use. */
export async function GET(request: Request) {
  const reason = crossSiteRefusal(request.headers);
  if (reason) return refuse(403, reason);
  const { status, body } = await getNewAppContext();
  return json(body, status);
}
