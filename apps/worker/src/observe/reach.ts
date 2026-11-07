/**
 * Reachability of the apps on a published status page. Container state alone can have the status
 * page say Operational while the app answered 502: the container ran, but its route pointed at a dead
 * address. So once a minute the worker sends each such app one request through the proxy, the way a
 * visitor's request goes (the app's hostname as Host and SNI, the app's health path or "/"), and the
 * public status page reads the verdict next to the observed container state.
 *
 * The request only ever goes to the server's own proxy, over its dialer, never to an address a
 * hostname resolves to, so a domain cannot point the probe anywhere else. TLS is not judged here
 * (the edge module checks certificates); a gateway error (502, 503, 504), Traefik's own "no route"
 * 404, a refused connection or a timeout reads as unreachable, and any other answer as reachable.
 */
import type { IncomingMessage } from "node:http";
import { connect as tlsConnect } from "node:tls";
import type { Db } from "@dockify/db";
import { appsHere } from "../server/apps-here.ts";
import { requestOver } from "../server/http-over.ts";
import type { Dialer } from "../server/runtime.ts";

export interface ReachTarget {
  appId: string;
  hostname: string;
  path: string;
}

export type ReachProbe = (t: ReachTarget) => Promise<boolean>;

/** Traefik answers a request no router matched with this body. */
const NO_ROUTE_BODY = "404 page not found";
const GATEWAY = new Set([502, 503, 504]);

/** The verdict for one answer: Traefik's no-route 404 and gateway errors are not the app answering. */
export function reachableFrom(status: number, bodyStart: string): boolean {
  if (GATEWAY.has(status)) return false;
  if (status === 404 && bodyStart.trim() === NO_ROUTE_BODY) return false;
  return true;
}

/**
 * A probe through the proxy: plain http on :80 in tunnel mode (Cloudflare ends TLS before it), https
 * on :443 with the hostname as SNI in direct mode (port 80 only redirects there).
 */
export function proxyProbe(opts: { dial: Dialer; tls: boolean; timeoutMs?: number }): ReachProbe {
  const timeout = opts.timeoutMs ?? 5_000;
  return async (t) => {
    const started = Date.now();
    const socket = await opts.dial({ proxy: opts.tls ? 443 : 80 }, { timeoutMs: timeout }).catch(() => null);
    if (!socket) return false;
    const connection = opts.tls ? tlsConnect({ socket, servername: t.hostname, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] }) : socket;
    return new Promise((resolve) => {
      const done = (ok: boolean) => resolve(ok);
      const onResponse = (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status !== 404) {
          done(reachableFrom(status, ""));
          req.destroy();
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
          if (body.length > 64) res.destroy();
        });
        res.on("close", () => done(reachableFrom(status, body.slice(0, 64))));
      };
      const headers = { Host: t.hostname, "User-Agent": "Dockify status probe", Accept: "*/*" };
      const req = requestOver(connection, { path: t.path, method: "GET", headers, timeoutMs: timeout - (Date.now() - started) }, onResponse);
      req.on("error", () => done(false));
      req.end();
    });
  };
}

const ROUTED = ["frontend", "backend"] as const;

/** The apps worth probing: routed apps of this server listed on a published status page, with a domain. */
export async function reachTargets(db: Db, serverId: string): Promise<ReachTarget[]> {
  const apps = await db.app.findMany({
    where: {
      ...appsHere(serverId),
      deployTarget: "server",
      kind: { in: [...ROUTED] },
      status: { not: "deploying" },
      statusItems: { some: { statusPage: { enabled: true } } },
      domains: { some: {} },
    },
    select: {
      id: true, healthCheckPath: true,
      primaryDomain: { select: { hostname: true } },
      domains: { orderBy: { createdAt: "asc" }, take: 1, select: { hostname: true } },
    },
  });
  return apps.flatMap((a) => {
    const hostname = a.primaryDomain?.hostname ?? a.domains[0]?.hostname;
    const path = a.healthCheckPath?.trim() || "/";
    return hostname ? [{ appId: a.id, hostname, path: path.startsWith("/") ? path : "/" }] : [];
  });
}

/** In-memory verdicts for the uptime minutes, so a day bar counts an unreachable minute as down. */
export type ReachState = Map<string, { ok: boolean; at: number }>;

/** One pass: probe each target in turn and store the verdict on its app row. */
export async function probeReachability(db: Db, serverId: string, probe: ReachProbe, state: ReachState, now = () => Date.now()): Promise<number> {
  const targets = await reachTargets(db, serverId);
  const live = new Set(targets.map((t) => t.appId));
  for (const id of [...state.keys()]) if (!live.has(id)) state.delete(id);
  for (const t of targets) {
    const ok = await probe(t);
    const at = now();
    state.set(t.appId, { ok, at });
    await db.app.updateMany({ where: { id: t.appId }, data: { reachable: ok, reachableAt: new Date(at) } });
  }
  return targets.length;
}
