/**
 * There is exactly one route writer (edge/routes.ts). This file only adapts the swap's call shape to it, so a
 * deploy and an edge_route_sync never write two different files for one app.
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
   * The container's route alias, a preview container's name or, only while a swap replaces a container made
   * before route aliases existed, that container's address. Never a name a tenant could hold.
   */
  backend: string;
  wildcard?: { domain: string; certResolver: string };
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

export function renderRoute(t: RouteTarget, dashboardHost: string, mode: EdgeMode): string | null {
  return asReserved(() => renderRouteFile({ id: t.appId, port: t.port, hosts: t.hosts }, t.backend, mode, reservedFor(dashboardHost)));
}

export async function writeRoute(routes: RouteStore, t: RouteTarget, dashboardHost: string, mode: EdgeMode): Promise<boolean> {
  try {
    const r = await edgeWrite(routes, { id: t.appId, port: t.port, hosts: t.hosts, ...(t.wildcard ? { wildcard: t.wildcard } : {}), ...(t.gateId ? { gateId: t.gateId } : {}) }, t.backend, mode, reservedFor(dashboardHost));
    return r !== "unchanged";
  } catch (e) {
    if (e instanceof EdgeHostError) throw new ReservedHostError(e.message);
    throw e;
  }
}

export async function writeAsleepRoute(routes: RouteStore, t: Omit<RouteTarget, "backend">, dashboardHost: string, mode: EdgeMode): Promise<void> {
  await asReserved(() => edgeAsleep(routes, { id: t.appId, port: t.port, hosts: t.hosts, ...(t.wildcard ? { wildcard: t.wildcard } : {}) }, mode, reservedFor(dashboardHost)));
}

export async function removeRoute(routes: RouteStore, appId: string): Promise<void> {
  await edgeRemove(routes, appId);
}

export async function routedBackend(routes: RouteStore, appId: string): Promise<string | null> {
  return (await readRoute(routes, appId))?.backend ?? null;
}

export async function routedHosts(routes: RouteStore, appId: string): Promise<Set<string>> {
  return new Set((await readRoute(routes, appId))?.hosts ?? []);
}
