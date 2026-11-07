import { setTimeout as sleep } from "node:timers/promises";
import type { IncomingMessage } from "node:http";

/**
 * Docker start events for Dockify's own app containers, the fast path of the route resync
 *: a container Docker restarted (a reboot, its restart policy, a power action) gets its
 * route checked at once instead of at the next reconcile. Routes name containers, not addresses,
 * so this mostly finds nothing to change; it repairs whatever drifted.
 *
 * The socket proxy allows exactly this one events query (deploy/socket-proxy/haproxy.cfg), so the
 * worker never sees other containers' events, exec commands included.
 */
export const START_EVENTS_FILTER = JSON.stringify({ type: ["container"], event: ["start"], label: ["dockify.managed=true"] });
export const START_EVENTS_PATH = `/events?filters=${encodeURIComponent(START_EVENTS_FILTER)}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The app a start event belongs to, or null for anything else (a release one-off, a preview, a service helper). */
export function appStarted(line: string): string | null {
  try {
    const e = JSON.parse(line) as { Type?: string; Action?: string; Actor?: { Attributes?: Record<string, string> } };
    if (e.Type !== "container" || e.Action !== "start") return null;
    const a = e.Actor?.Attributes ?? {};
    if (a["dockify.managed"] !== "true" || a["dockify.role"] !== "app") return null;
    const id = a["dockify.app"] ?? "";
    return UUID.test(id) ? id : null;
  } catch {
    return null;
  }
}

export interface StartsSource {
  raw(method: string, path: string, body?: unknown, opts?: { signal?: AbortSignal }): Promise<IncomingMessage>;
}

/**
 * Follows the events stream and calls `onStart` for every app container that starts. Reconnects
 * with backoff (1 s doubling to 60 s) when the stream ends or fails, and logs only when it goes
 * from connected to not and back. Stop ends the stream and waits for the loop.
 */
export function watchStarts(docker: StartsSource, onStart: (appId: string) => Promise<void>, log: (msg: string, extra?: object) => void): { stop(): Promise<void> } {
  const ac = new AbortController();
  let healthy = true;
  const done = (async () => {
    let delay = 1_000;
    while (!ac.signal.aborted) {
      try {
        const res = await docker.raw("GET", START_EVENTS_PATH, undefined, { signal: ac.signal });
        if ((res.statusCode ?? 500) >= 400) {
          res.resume();
          throw new Error(`Docker answered ${res.statusCode} to the events request`);
        }
        if (!healthy) log("following Docker start events again");
        healthy = true;
        delay = 1_000;
        let partial = "";
        for await (const chunk of res) {
          partial += (chunk as Buffer).toString("utf8");
          const lines = partial.split("\n");
          partial = lines.pop() ?? "";
          if (partial.length > 64 * 1024) partial = "";
          for (const line of lines) {
            const appId = appStarted(line);
            if (appId) await onStart(appId).catch((e: unknown) => log("could not queue a route sync after a container start", { appId, error: e instanceof Error ? e.message : String(e) }));
          }
        }
      } catch (e) {
        if (ac.signal.aborted) break;
        if (healthy) log("lost Docker start events; retrying, and the reconcile still resyncs every route", { error: e instanceof Error ? e.message : String(e) });
        healthy = false;
      }
      await sleep(delay, undefined, { signal: ac.signal }).catch(() => {});
      delay = Math.min(delay * 2, 60_000);
    }
  })();
  return {
    async stop() {
      ac.abort();
      await done;
    },
  };
}
