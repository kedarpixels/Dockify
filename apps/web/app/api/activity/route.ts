import { json } from "@/lib/http";
import { CATEGORIES, getActivity, type ActivityCategory } from "@/lib/pages/activity-settings";

const isCategory = (v: string): v is ActivityCategory => CATEGORIES.some((c) => c === v);

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const category = p.get("category") || null;
  if (category !== null && !isCategory(category)) return json({ data: null, error: "Unknown category" }, 400);
  const result = await getActivity({
    cursor: p.get("cursor")?.slice(0, 200) ?? null,
    category,
    actor: p.get("actor")?.slice(0, 200) ?? null,
    q: p.get("q")?.slice(0, 200) ?? null,
  });
  return json(result);
}
