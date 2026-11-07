import { json, refuse } from "@/lib/http";
import { getInstallUrl } from "@/lib/pages/git";
import { crossSiteRefusal } from "@/lib/same-origin";

/** GET /api/git/install-url: the GitHub App install link, with a fresh state from the API. */
export async function GET(request: Request) {
  const reason = crossSiteRefusal(request.headers);
  if (reason) return refuse(403, reason);
  const { status, body } = await getInstallUrl();
  return json(body, status);
}
