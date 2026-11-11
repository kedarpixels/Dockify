import { json } from "@/lib/http";
import { getLogs, parseLogQuery } from "@/lib/pages/logs";

export async function GET(request: Request) {
  const parsed = parseLogQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return json({ source: "api", data: null, error: parsed.error, fetchedAt: new Date().toISOString() }, 400);
  const result = await getLogs(parsed.query);
  return json(result, result.data ? 200 : result.source === "none" ? 503 : 502);
}
