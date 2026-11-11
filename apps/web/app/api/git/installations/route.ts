import { json, refuse } from "@/lib/http";
import { getInstallations } from "@/lib/pages/git";
import { crossSiteRefusal } from "@/lib/same-origin";

export async function GET(request: Request) {
  const reason = crossSiteRefusal(request.headers);
  if (reason) return refuse(403, reason);
  const { status, body } = await getInstallations();
  return json(body, status);
}
