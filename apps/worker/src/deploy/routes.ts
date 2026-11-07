/**
 * The deploy pipeline's view of Traefik routes. There is exactly one route writer, the edge
 * module's (edge/routes.ts): one file per app, atomic, byte-stable, moved-host dedupe, and the
 * ingress mode's TLS shape. This file only adapts the swap's call shape to it, so a deploy and an
 * edge_route_sync can never write two different files for one app.
 */
import { EdgeHostError, reservedHosts } from "../edge/hostnames.ts";
import type { EdgeMode } from "../edge/ingress.ts";
import { readRoute, removeRoute as edgeRemove, renderRouteFile, writeAsleepRoute as edgeAsleep, writeRoute as edgeWrite } from "../edge/routes.ts";
import type { RouteStore } from "../server/runtime.ts";

export class ReservedHostError extends Error {}

export interface RouteTarget {
  appId: string;
  hosts: string[];
  port: number;
  /**
   * What the route sends traffic to: the container's own route alias (containers.ts routeAlias), a
   * preview container's name, or, only while a swap replaces a container made before route aliases
   * existed, that container's address. Never a name a tenant could hold.
   */
  backend: string;
  /** Previews in direct mode with DNS-01 configured: one wildcard certificate for the preview domain. */
  wildcard?: { domain: string; certResolver: string };
  /** A preview's route: every request asks the api's gate first (edge/routes.ts gateParts). */
  gateId?: string;
}

/** The DNS-01 resolver for preview wildcards (DOCKIFY_ACME_DNS01=1 with a Cloudflare token for Traefik), or null for HTTP-01 per host. */
export const DNS01_RESOLVER = "ledns";
export function dns01FromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.DOCKIFY_INGRESS?.trim() === "direct_tls" && env.DOCKIFY_ACME_DNS01?.trim() === "1" ? DNS01_RESOLVER : null;
}

const reservedFor = (dashboardHost: string, env: NodeJS.ProcessEnv = process.env) =>
  reservedHosts(dashboardHost || null, (env.DOCKIFY_RESERVED_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const asReserved = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof EdgeHostError) throw new ReservedHostError(e.message);
    throw e;
  }
};

/** The file content, or null when there is nothing to route. Throws on a reserved or bad host. */
export function renderRoute(t: RouteTarget, dashboardHost: string, mode: EdgeMode): string | null {
  return asReserved(() => renderRouteFile({ id: t.appId, port: t.port, hosts: t.hosts }, t.backend, mode, reservedFor(dashboardHost)));
}

/** Points the app's hosts at `backend`. Returns false when the content was already in place. */
export async function writeRoute(routes: RouteStore, t: RouteTarget, dashboardHost: string, mode: EdgeMode): Promise<boolean> {
  try {
    const r = await edgeWrite(routes, { id: t.appId, port: t.port, hosts: t.hosts, ...(t.wildcard ? { wildcard: t.wildcard } : {}), ...(t.gateId ? { gateId: t.gateId } : {}) }, t.backend, mode, reservedFor(dashboardHost));
    return r !== "unchanged";
  } catch (e) {
    if (e instanceof EdgeHostError) throw new ReservedHostError(e.message);
    throw e;
  }
}

/** The "this preview is asleep" page on a sleeping preview's hosts (edge/routes.ts). */
export async function writeAsleepRoute(routes: RouteStore, t: Omit<RouteTarget, "backend">, dashboardHost: string, mode: EdgeMode): Promise<void> {
  await asReserved(() => edgeAsleep(routes, { id: t.appId, port: t.port, hosts: t.hosts, ...(t.wildcard ? { wildcard: t.wildcard } : {}) }, mode, reservedFor(dashboardHost)));
}

export async function removeRoute(routes: RouteStore, appId: string): Promise<void> {
  await edgeRemove(routes, appId);
}

/** The backend currently routed for an app (a name or an address), or null. */
export async function routedBackend(routes: RouteStore, appId: string): Promise<string | null> {
  return (await readRoute(routes, appId))?.backend ?? null;
}

/** The hosts an app's current file routes, for keeping a routed host while its DNS check cannot tell. */
export async function routedHosts(routes: RouteStore, appId: string): Promise<Set<string>> {
  return new Set((await readRoute(routes, appId))?.hosts ?? []);
}
