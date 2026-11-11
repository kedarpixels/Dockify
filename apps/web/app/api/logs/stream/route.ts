import { json } from "@/lib/http";
import { openLogStream, parseLogQuery } from "@/lib/pages/logs";

export const dynamic = "force-dynamic";

/** The browser's reconnect sends Last-Event-ID, which is passed on so no line is lost or repeated. */
export async function GET(request: Request) {
  const parsed = parseLogQuery(new URL(request.url).searchParams, { stream: true });
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  return openLogStream(parsed.query, parsed.since, request.headers.get("last-event-id"), request.signal);
}
