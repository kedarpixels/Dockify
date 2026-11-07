import "server-only";
import { apiRequest, apiStream, plainError, UNREADABLE } from "@/lib/api";
import { json, upstreamStatus, type RouteAnswer } from "@/lib/http";
import { isPreviewMode } from "@/lib/preview-mode";

/*
 * A Vercel deployment's logs, through this dashboard's routes. The API reads them from Vercel with the
 * stored token and redacts them; the token never comes this far (packages/contracts/src/endpoints.ts).
 */

export interface VercelRuntimeLine {
  id: string;
  ts: string;
  appId: string;
  stream: "stdout" | "stderr";
  level?: "error" | "warn" | "info" | "debug" | null;
  text: string;
}

export interface VercelLogRetention {
  plan: "pro_or_enterprise" | "unknown";
  minHours: number | null;
  /** One sentence for the page, saying only what Dockify can know. */
  note: string;
  linesPerRequest: number;
}

export interface VercelLogPage {
  lines: VercelRuntimeLine[];
  /** Null when the app has no finished Vercel deployment yet. */
  deployment: { id: string; externalId: string; url: string | null; target: "production" | "preview" | null; createdAt: string } | null;
  retention: VercelLogRetention;
  fetchedAt: string;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

const enc = encodeURIComponent;

const PREVIEW_RETENTION: VercelLogRetention = {
  plan: "unknown",
  minHours: null,
  note: "Vercel keeps runtime logs for 1 hour on Hobby, 1 day on Pro, 3 days on Enterprise and 30 days with Observability Plus, and at most 256 lines per request. Vercel does not tell Dockify the plan.",
  linesPerRequest: 256,
};

const previewLine = (appId: string, at: number, i: number): VercelRuntimeLine => {
  const paths = ["/", "/leaderboard", "/api/session", "/partners", "/rewards"];
  const bad = i % 11 === 7;
  return {
    id: `pv_${at}_${i}`,
    ts: new Date(at).toISOString(),
    appId,
    stream: bad ? "stderr" : "stdout",
    level: bad ? "error" : "info",
    text: bad ? "Error: fetch failed, cause ECONNRESET" : `GET ${paths[i % paths.length]} 200 in ${8 + (i * 13) % 140}ms`,
  };
};

export async function getVercelRuntimeTail(appId: string, deployment: string | null, signal?: AbortSignal): Promise<RouteAnswer<{ data: VercelLogPage | null; error?: string }>> {
  if (process.env.DOCKIFY_API_URL) {
    const r = await apiRequest<VercelLogPage>(`/api/v1/apps/${enc(appId)}/vercel/logs`, { query: { deployment: deployment ?? undefined }, signal });
    if (!r.ok) return { status: upstreamStatus(r.status), body: { data: null, error: plainError(r) } };
    return r.data ? { status: 200, body: { data: r.data } } : { status: 502, body: { data: null, error: UNREADABLE } };
  }
  if (isPreviewMode()) {
    const now = Date.now();
    return {
      status: 200,
      body: {
        data: {
          lines: Array.from({ length: 24 }, (_, i) => previewLine(appId, now - (24 - i) * 4_000, i)),
          deployment: { id: deployment ?? "preview", externalId: "dpl_preview", url: null, target: "production", createdAt: new Date(now - 3_600_000).toISOString() },
          retention: PREVIEW_RETENTION,
          fetchedAt: new Date(now).toISOString(),
        },
      },
    };
  }
  return { status: 503, body: { data: null, error: "No data source" } };
}

/** Pipes an API event stream through untouched, passing the browser's resume point on. */
async function pipe(path: string, lastEventId: string | null, signal: AbortSignal): Promise<Response> {
  const r = await apiStream(path, {
    accept: "text/event-stream",
    signal,
    headers: lastEventId && /^\d{1,15}$/.test(lastEventId) ? { "last-event-id": lastEventId } : undefined,
  });
  if (!r.ok) return json({ error: plainError(r) }, r.status === 400 || r.status === 401 || r.status === 404 || r.status === 409 || r.status === 429 ? r.status : 502);
  return new Response(r.res.body, { headers: SSE_HEADERS });
}

/** The preview's stream: one more line every couple of seconds, until the tab goes. */
function previewRuntime(appId: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  const text = new TextEncoder();
  let i = 40;
  let timer: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream({
    start(c) {
      c.enqueue(text.encode("retry: 3000\n\n"));
      timer = setInterval(() => c.enqueue(text.encode(`event: line\ndata: ${JSON.stringify(previewLine(appId, Date.now(), i++))}\n\n`)), 2_000);
      signal.addEventListener("abort", () => {
        clearInterval(timer);
        try {
          c.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      clearInterval(timer);
    },
  });
}

export async function openVercelRuntimeStream(appId: string, deployment: string | null, signal: AbortSignal): Promise<Response> {
  if (process.env.DOCKIFY_API_URL) return pipe(`/api/v1/apps/${enc(appId)}/vercel/logs/stream${deployment ? `?deployment=${enc(deployment)}` : ""}`, null, signal);
  if (isPreviewMode()) return new Response(previewRuntime(appId, signal), { headers: SSE_HEADERS });
  return json({ error: "No data source" }, 503);
}

export async function openBuildLogStream(id: string, after: number, lastEventId: string | null, signal: AbortSignal): Promise<Response> {
  if (process.env.DOCKIFY_API_URL) return pipe(`/api/v1/deployments/${enc(id)}/logs/stream?after=${after}`, lastEventId, signal);
  return json({ error: "No data source" }, 503);
}
