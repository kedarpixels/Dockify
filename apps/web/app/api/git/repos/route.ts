import { json, refuse } from "@/lib/http";
import { cleanQuery, getRepos, isCursor, isGitId } from "@/lib/pages/git";
import { crossSiteRefusal } from "@/lib/same-origin";

export async function GET(request: Request) {
  const reason = crossSiteRefusal(request.headers);
  if (reason) return refuse(403, reason);
  const search = new URL(request.url).searchParams;
  const installation = search.get("installation");
  const cursor = search.get("cursor") || null;
  if (!isGitId(installation)) return refuse(400, "Unknown installation");
  if (cursor !== null && !isCursor(cursor)) return refuse(400, "That cursor is not valid");
  const { status, body } = await getRepos(installation, cleanQuery(search.get("q")), cursor);
  return json(body, status);
}
