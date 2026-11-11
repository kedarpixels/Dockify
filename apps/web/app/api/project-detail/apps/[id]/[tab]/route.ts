import { json, refuse } from "@/lib/http";
import { APP_TAB_KEYS, getAppTab, type AppTabKey } from "@/lib/pages/project-detail";

const isTab = (v: string): v is AppTabKey => (APP_TAB_KEYS as readonly string[]).includes(v);

/** The tab is a fixed list and getAppTab checks the id and every query value. Cross-site reads are refused:
 *  some answers carry database rows. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; tab: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return refuse(403, "Cross-site request refused");
  const { id, tab } = await params;
  if (!isTab(tab)) return refuse(404, "Unknown tab");
  const { status, ...body } = await getAppTab(id, tab, new URL(request.url).searchParams);
  return json(body, status);
}
