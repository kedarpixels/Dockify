import { PREVIEW_ASLEEP_PATH, PREVIEW_GATE_CHECK_PATH, PREVIEW_GATE_PATH } from "@dockify/contracts";
import { isIP } from "node:net";
import { DOMAIN_CHECK_PREFIX } from "@dockify/crypto";
import type { RouteChange, RouteStore } from "../server/runtime.ts";
import { assertTenantHost, hostRule, isValidHost, normalizeHost } from "./hostnames.ts";
import type { EdgeMode } from "./ingress.ts";
import { API_PATH_PREFIX, API_UPSTREAM, CLIENT_IP_MIDDLEWARE, WEB_UPSTREAM } from "./ingress.ts";

/**
 * Traefik's file provider watches one folder and routes only what is written here, so a tenant image's
 * traefik.* labels are inert. A backend is a container DNS name, never an address: Docker reassigns
 * addresses on reboot. No empty map, list or null in a file: Traefik then drops every file route.
 */

export function ridFor(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

/** System files start with "__", which ridFor never produces from a uuid. */
export const DASHBOARD_FILE = "__dashboard.yml";
export const EDGE_FILE = "__edge.yml";
export const isSystemRouteFile = (name: string): boolean => name.startsWith("__");
export const DASHBOARD_NEXT_FILE = "__dashboard-next.yml";
export const DASHBOARD_OLD_FILE = "__dashboard-old.yml";

/** The dashboard router outranks every tenant router, whatever its rule length. */
export const DASHBOARD_PRIORITY = 100_000;
/** The api's router on the dashboard host outranks the dashboard router, so its prefix never reaches the web. */
export const DASHBOARD_API_PRIORITY = DASHBOARD_PRIORITY + 1;
/**
 * Above every tenant router (whose priority is its rule's length), so no tenant app ever answers the
 * probe for a name; below the dashboard's, so the dashboard host keeps every path.
 */
export const CHECK_PRIORITY = DASHBOARD_PRIORITY - 1_000;
/** A preview's password form: above its own app, whose router's priority is its rule's length, and below the probe. */
export const GATE_PRIORITY = CHECK_PRIORITY - 1;

interface Router {
  rule: string;
  entryPoints: string[];
  service: string;
  priority?: number;
  tls?: { certResolver: string; domains?: Array<{ main: string }> };
  middlewares?: string[];
}
type Middleware =
  | { redirectScheme: { scheme: string; permanent: boolean } }
  | { headers: { customRequestHeaders: Record<string, string> } }
  | { headers: { customResponseHeaders: Record<string, string> } }
  | { forwardAuth: { address: string; trustForwardHeader: false; authResponseHeaders: string[] } }
  | { redirectRegex: { regex: string; replacement: string; permanent: boolean } }
  | { replacePath: { path: string } };
type Service = { loadBalancer: { servers: { url: string }[]; passHostHeader?: boolean } };

export interface RouteFile {
  http: {
    routers?: Record<string, Router>;
    services?: Record<string, Service>;
    middlewares?: Record<string, Middleware>;
  };
}

export interface RoutableApp {
  id: string;
  port: number | null;
  /** In the order the caller loads them (createdAt), which keeps the render byte-stable. */
  hosts: string[];
  /**
   * Direct mode only: one wildcard certificate through this DNS-01 resolver, so short-lived preview
   * hosts never spend Let's Encrypt's per-domain rate limit.
   */
  wildcard?: { domain: string; certResolver: string };
  /**
   * A preview: every request asks the api first (forwardAuth), which answers from the project's
   * current setting. The id is the preview app's, written here, so no request can name another's.
   */
  gateId?: string;
}

const BACKEND_NAME = /^dk-[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
export const isBackendName = (name: string): boolean => BACKEND_NAME.test(name);

/**
 * A name is written fully qualified (trailing dot), so a stopped container is a plain DNS miss, never
 * a lookup under the host's search domains. An address is still accepted, for the deploy swap.
 */
export function backendUrl(backend: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Route backend port is out of range: ${port}`);
  if (isBackendName(backend)) return `http://${backend}.:${port}`;
  const family = isIP(backend);
  if (!family) throw new Error(`Route backend must be a dk- container name or an IP address, got ${JSON.stringify(backend).slice(0, 60)}`);
  return family === 6 ? `http://[${backend}]:${port}` : `http://${backend}:${port}`;
}

/** Throws on any empty object, empty array or null: Traefik's file provider refuses the whole file for one. */
export function assertNoEmptyValues(value: unknown, path = "$"): void {
  if (value === null || value === undefined) throw new Error(`Route file has no value at ${path}`);
  if (Array.isArray(value)) {
    if (value.length === 0) throw new Error(`Route file has an empty list at ${path}`);
    value.forEach((v, i) => assertNoEmptyValues(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) throw new Error(`Route file has an empty map at ${path}`);
    for (const [k, v] of entries) assertNoEmptyValues(v, `${path}.${k}`);
  }
}

function compact(file: RouteFile): RouteFile {
  const http: RouteFile["http"] = {};
  for (const key of ["routers", "services", "middlewares"] as const) {
    const section = file.http[key];
    if (section && Object.keys(section).length > 0) Object.assign(http, { [key]: section });
  }
  return { http };
}

export function routeFileFor(app: RoutableApp, backend: string, mode: EdgeMode, reserved: Set<string>): RouteFile | null {
  if (app.port === null || app.hosts.length === 0) return null;
  const hosts = [...new Set(app.hosts.map((h) => assertTenantHost(h, reserved)))];
  const rid = ridFor(app.id);
  const rule = hosts.map(hostRule).join(" || ");
  const services: Record<string, Service> = { [rid]: { loadBalancer: { servers: [{ url: backendUrl(backend, app.port) }], passHostHeader: true } } };
  const gate = app.gateId ? gateParts(rid, app.gateId, rule) : null;
  if (gate) services[gate.service] = gate.upstream;

  if (mode.ingress === "cloudflare_tunnel") {
    return {
      http: {
        routers: {
          [rid]: { rule, entryPoints: ["web"], service: rid, ...(gate ? { middlewares: gate.guard } : {}) },
          ...(gate ? { [gate.service]: { rule: gate.rule, entryPoints: ["web"], service: gate.service, priority: GATE_PRIORITY, middlewares: gate.form } } : {}),
        },
        services,
        ...(gate ? { middlewares: gate.middlewares } : {}),
      },
    };
  }
  const strip = `${CLIENT_IP_MIDDLEWARE}@file`;
  const tls = app.wildcard ? { certResolver: app.wildcard.certResolver, domains: [{ main: `*.${app.wildcard.domain}` }] } : { certResolver: mode.certResolver };
  return {
    http: {
      routers: {
        [rid]: { rule, entryPoints: ["websecure"], service: rid, tls, middlewares: [strip, ...(gate?.guard ?? [])] },
        ...(gate ? { [gate.service]: { rule: gate.rule, entryPoints: ["websecure"], service: gate.service, priority: GATE_PRIORITY, tls, middlewares: [strip, ...gate.form] } } : {}),
        [`${rid}-redirect`]: { rule, entryPoints: ["web"], service: rid, middlewares: [`${rid}-https`] },
      },
      services,
      middlewares: { [`${rid}-https`]: { redirectScheme: { scheme: "https", permanent: true } }, ...gate?.middlewares },
    },
  };
}

/**
 * forwardAuth asks the api before the app sees a request; the api removes the gate's own cookie, so a
 * preview's code never sees it. replacePath fixes this preview's id on the form's path. Not basicAuth:
 * a bcrypt per request in the shared proxy, no attempt limit, and it takes the app's Authorization header.
 */
function gateParts(rid: string, gateId: string, rule: string) {
  const service = `${rid}-gate`;
  const auth = `${rid}-gate-auth`;
  const path = `${rid}-gate-path`;
  const noindex = `${rid}-noindex`;
  const id = encodeURIComponent(gateId);
  const middlewares: Record<string, Middleware> = {
    [auth]: { forwardAuth: { address: `${API_UPSTREAM}${PREVIEW_GATE_CHECK_PATH}/${id}`, trustForwardHeader: false, authResponseHeaders: ["Cookie"] } },
    [path]: { replacePath: { path: `${PREVIEW_GATE_PATH}/${id}` } },
    [noindex]: { headers: { customResponseHeaders: { "X-Robots-Tag": "noindex, nofollow" } } },
  };
  return {
    service,
    upstream: { loadBalancer: { servers: [{ url: API_UPSTREAM }], passHostHeader: true } } satisfies Service,
    rule: `(${rule}) && Path(\`${PREVIEW_GATE_PATH}\`)`,
    guard: [noindex, auth],
    form: [noindex, path],
    middlewares,
  };
}

/**
 * Every path becomes the api's one asleep page, so a visitor reaches nothing else on the api. The
 * service has its own name, which the idle clock's counter (service pv-<id>) does not read.
 */
export function renderAsleepRouteFile(app: RoutableApp, mode: EdgeMode, reserved: Set<string>): string | null {
  const file = routeFileFor(app, "dk-asleep", mode, reserved);
  if (!file) return null;
  const rid = ridFor(app.id);
  const service = `${rid}-asleep`;
  const page = `${rid}-asleep-page`;
  const routers = Object.fromEntries(Object.entries(file.http.routers ?? {}).map(([name, r]) => [name, { ...r, service, middlewares: [...(r.middlewares ?? []), page] }]));
  return serialize({
    http: {
      routers,
      services: { [service]: { loadBalancer: { servers: [{ url: API_UPSTREAM }], passHostHeader: true } } },
      middlewares: { ...file.http.middlewares, [page]: { replacePath: { path: PREVIEW_ASLEEP_PATH } } },
    },
  });
}

const serialize = (file: RouteFile): string => {
  assertNoEmptyValues(file);
  return `${JSON.stringify(file, null, 2)}\n`;
};

export function renderRouteFile(app: RoutableApp, backend: string, mode: EdgeMode, reserved: Set<string>): string | null {
  const file = routeFileFor(app, backend, mode, reserved);
  return file ? serialize(file) : null;
}

/** Files carry .yml but hold JSON: Traefik's file provider reads YAML or TOML, and JSON is valid YAML. */
export const routeFileName = (appId: string): string => `${ridFor(appId)}.yml`;

/** A file that is not our JSON is left alone, since it cannot be edited safely. */
async function dedupHosts(routes: RouteStore, ownFile: string, hosts: string[]): Promise<Required<RouteChange>> {
  const change: Required<RouteChange> = { writes: {}, removes: [] };
  const rules = new Set(hosts.map(hostRule));
  for (const [name, raw] of Object.entries(await routes.snapshot())) {
    if (name === ownFile || isSystemRouteFile(name)) continue;
    if (![...rules].some((r) => raw.includes(r))) continue;
    let file: RouteFile;
    try {
      file = JSON.parse(raw) as RouteFile;
      if (!file?.http?.routers) continue;
    } catch {
      continue;
    }
    const routers = file.http.routers;
    for (const [key, router] of Object.entries(routers)) {
      // A preview's form router names its hosts inside a larger rule, and goes with any one of them.
      if (router.rule.includes(" && ")) {
        if ([...rules].some((r) => router.rule.includes(r))) delete routers[key];
        continue;
      }
      const kept = router.rule.split(" || ").filter((d) => !rules.has(d));
      if (kept.length === 0) delete routers[key];
      else router.rule = kept.join(" || ");
    }
    if (Object.keys(routers).length === 0) change.removes.push(name);
    else change.writes[name] = serialize(compact(file));
  }
  return change;
}

export type WriteResult = "written" | "unchanged" | "removed";

/**
 * The hosts come out of any other app's file in the same change, and that rewrite lands first: a short
 * 404 for a moved host is fine, serving it from the wrong app is not.
 */
export async function writeRoute(routes: RouteStore, app: RoutableApp, backend: string, mode: EdgeMode, reserved: Set<string>): Promise<WriteResult> {
  const content = renderRouteFile(app, backend, mode, reserved);
  if (content === null) {
    await removeRoute(routes, app.id);
    return "removed";
  }
  const name = routeFileName(app.id);
  if ((await routes.read(name)) === content) return "unchanged";
  const moved = await dedupHosts(routes, name, app.hosts.map(normalizeHost));
  await routes.apply({ writes: { ...moved.writes, [name]: content }, removes: moved.removes });
  return "written";
}

export async function writeAsleepRoute(routes: RouteStore, app: RoutableApp, mode: EdgeMode, reserved: Set<string>): Promise<void> {
  const content = renderAsleepRouteFile(app, mode, reserved);
  if (content === null) return removeRoute(routes, app.id);
  await routes.apply({ writes: { [routeFileName(app.id)]: content } });
}

export async function removeRoute(routes: RouteStore, appId: string): Promise<void> {
  await routes.apply({ removes: [routeFileName(appId)] });
}

export async function readRoute(routes: RouteStore, appId: string): Promise<{ hosts: string[]; backend: string | null } | null> {
  const raw = await routes.read(routeFileName(appId));
  if (raw === null) return null;
  try {
    const file = JSON.parse(raw) as RouteFile;
    const hosts = new Set<string>();
    for (const r of Object.values(file.http.routers ?? {})) {
      for (const m of r.rule.matchAll(/Host\(`([^`]+)`\)/g)) hosts.add(m[1]!);
    }
    const url = Object.values(file.http.services ?? {})[0]?.loadBalancer.servers[0]?.url;
    const host = url ? /^http:\/\/(?:\[([^\]]+)\]|([^:/]+?))\.?:\d+$/.exec(url) : null;
    return { hosts: [...hosts], backend: host ? (host[1] ?? host[2] ?? null) : null };
  } catch {
    return { hosts: [], backend: null };
  }
}

export async function rekeyRoute(routes: RouteStore, routeId: string, from: string, to: string): Promise<boolean> {
  if (!isBackendName(to) || !isIP(from)) throw new Error(`Cannot re-key a route from ${from} to ${to}`);
  const name = routeFileName(routeId);
  const text = await routes.read(name);
  if (text === null) return false;
  const old = isIP(from) === 6 ? `"http://[${from}]:` : `"http://${from}:`;
  const next = text.split(old).join(`"http://${to}.:`);
  if (next === text) return false;
  assertNoEmptyValues(JSON.parse(next));
  await routes.apply({ writes: { [name]: next } });
  return true;
}

/**
 * System files are never touched. Applied even with nothing to remove: that is also when the store
 * clears what a crash left in its staging.
 */
export async function sweepRoutes(routes: RouteStore, keep: Iterable<string>): Promise<string[]> {
  const wanted = new Set([...keep].map(routeFileName));
  const removed = Object.keys(await routes.snapshot()).filter((name) => !isSystemRouteFile(name) && !wanted.has(name));
  await routes.apply({ removes: removed });
  return removed;
}

/**
 * Direct mode only; in tunnel mode cloudflared splits the dashboard host and Traefik never sees it.
 * API_PATH_PREFIX goes to the api at a higher priority, the rest to the web, both by fixed compose
 * address so no tenant network alias can stand in. The api's internal routes are not under the prefix.
 */
export function renderDashboardRoute(host: string, certResolver: string, upstreams: { web: string; api: string } = { web: WEB_UPSTREAM, api: API_UPSTREAM }): string {
  const h = normalizeHost(host);
  if (!isValidHost(h)) throw new Error(`Dashboard host is not a valid hostname: ${host}`);
  const rule = hostRule(h);
  const file: RouteFile = {
    http: {
      routers: {
        "dashboard-api": {
          rule: `${rule} && PathPrefix(\`${API_PATH_PREFIX}\`)`,
          entryPoints: ["websecure"],
          service: "dashboard-api",
          priority: DASHBOARD_API_PRIORITY,
          tls: { certResolver },
          middlewares: [`${CLIENT_IP_MIDDLEWARE}@file`],
        },
        dashboard: {
          rule,
          entryPoints: ["websecure"],
          service: "dashboard",
          priority: DASHBOARD_PRIORITY,
          tls: { certResolver },
          middlewares: [`${CLIENT_IP_MIDDLEWARE}@file`],
        },
        "dashboard-redirect": {
          rule,
          entryPoints: ["web"],
          service: "dashboard",
          priority: DASHBOARD_PRIORITY,
          middlewares: ["dashboard-https"],
        },
      },
      services: {
        dashboard: { loadBalancer: { servers: [{ url: upstreams.web }], passHostHeader: true } },
        "dashboard-api": { loadBalancer: { servers: [{ url: upstreams.api }], passHostHeader: true } },
      },
      middlewares: { "dashboard-https": { redirectScheme: { scheme: "https", permanent: true } } },
    },
  };
  return serialize(file);
}

/**
 * Traefik removes a request header whose custom value is empty; X-Forwarded-For is not listed because
 * the entry point already replaces it with the TCP peer. The probe routers have no Host rule (an
 * unrouted domain can answer) and no certificate resolver (the probe never asks Let's Encrypt).
 */
export function renderEdgeFile(): string {
  const rule = `PathPrefix(\`${DOMAIN_CHECK_PREFIX}\`)`;
  const strip = [`${CLIENT_IP_MIDDLEWARE}@file`];
  const file: RouteFile = {
    http: {
      routers: {
        "dockify-check": { rule, entryPoints: ["web"], service: "dockify-check", priority: CHECK_PRIORITY, middlewares: strip },
        "dockify-check-tls": { rule, entryPoints: ["websecure"], service: "dockify-check", priority: CHECK_PRIORITY, middlewares: strip },
      },
      services: { "dockify-check": { loadBalancer: { servers: [{ url: API_UPSTREAM }], passHostHeader: true } } },
      middlewares: {
        [CLIENT_IP_MIDDLEWARE]: {
          headers: {
            customRequestHeaders: {
              "CF-Connecting-IP": "",
              "CF-Connecting-IPv6": "",
              "True-Client-IP": "",
              "X-Client-IP": "",
              "X-Cluster-Client-IP": "",
              Forwarded: "",
            },
          },
        },
      },
    },
  };
  return serialize(file);
}

/**
 * Serves only the ownership probe's path on the new name, so nobody signs in on it before the switch.
 * Tunnel mode: this is what lets the probe through. Direct mode: it exists for the certificate, since
 * a router that names a resolver is what makes Traefik ask Let's Encrypt.
 */
export function renderDashboardNext(host: string, mode: EdgeMode): string {
  const h = normalizeHost(host);
  if (!isValidHost(h)) throw new Error(`Dashboard host is not a valid hostname: ${host}`);
  const rule = `${hostRule(h)} && PathPrefix(\`${DOMAIN_CHECK_PREFIX}\`)`;
  const router: Router = mode.ingress === "cloudflare_tunnel"
    ? { rule, entryPoints: ["web"], service: "dashboard-next", priority: CHECK_PRIORITY + 1 }
    : { rule, entryPoints: ["websecure"], service: "dashboard-next", priority: CHECK_PRIORITY + 1, tls: { certResolver: mode.certResolver }, middlewares: [`${CLIENT_IP_MIDDLEWARE}@file`] };
  return serialize({
    http: {
      routers: { "dashboard-next": router },
      services: { "dashboard-next": { loadBalancer: { servers: [{ url: API_UPSTREAM }], passHostHeader: true } } },
    },
  });
}

/**
 * A temporary redirect, so a browser never holds on to it if the owner switches back. The api's prefix
 * is served, not redirected: GitHub does not follow a redirect for a webhook delivery.
 */
export function renderDashboardOld(previous: readonly string[], current: string, mode: EdgeMode): string | null {
  const to = normalizeHost(current);
  const hosts = [...new Set(previous.map(normalizeHost))].filter((h) => isValidHost(h) && h !== to);
  if (!hosts.length || !isValidHost(to)) return null;
  const rule = hosts.map(hostRule).join(" || ");
  const redirect = "dashboard-old-redirect";
  const strip = `${CLIENT_IP_MIDDLEWARE}@file`;
  const routers: Record<string, Router> = mode.ingress === "direct_tls"
    ? {
        "dashboard-old-api": {
          rule: `(${rule}) && PathPrefix(\`${API_PATH_PREFIX}\`)`,
          entryPoints: ["websecure"],
          service: "dashboard-old-api",
          priority: DASHBOARD_API_PRIORITY,
          tls: { certResolver: mode.certResolver },
          middlewares: [strip],
        },
        "dashboard-old": { rule, entryPoints: ["websecure"], service: "dashboard-old-api", priority: DASHBOARD_PRIORITY, tls: { certResolver: mode.certResolver }, middlewares: [strip, redirect] },
      }
    : { "dashboard-old": { rule, entryPoints: ["web"], service: "dashboard-old-api", priority: DASHBOARD_PRIORITY, middlewares: [redirect] } };
  return serialize({
    http: {
      routers,
      services: { "dashboard-old-api": { loadBalancer: { servers: [{ url: API_UPSTREAM }], passHostHeader: true } } },
      middlewares: { [redirect]: { redirectRegex: { regex: "^https?://[^/]+(.*)$", replacement: `https://${to}$1`, permanent: false } } },
    },
  });
}

/** An unchanged file is never rewritten, so Traefik does not reload for nothing. */
async function changedFiles(routes: RouteStore, want: Record<string, string>): Promise<Record<string, string>> {
  const writes: Record<string, string> = {};
  for (const [name, content] of Object.entries(want)) if ((await routes.read(name)) !== content) writes[name] = content;
  return writes;
}

export async function writeDashboardFiles(routes: RouteStore, mode: EdgeMode, o: { current: string; next: string | null; previous: readonly string[] }): Promise<void> {
  const next = o.next ? renderDashboardNext(o.next, mode) : null;
  const old = renderDashboardOld(o.previous, o.current, mode);
  await routes.apply({
    writes: await changedFiles(routes, { ...(next ? { [DASHBOARD_NEXT_FILE]: next } : {}), ...(old ? { [DASHBOARD_OLD_FILE]: old } : {}) }),
    removes: [...(next ? [] : [DASHBOARD_NEXT_FILE]), ...(old ? [] : [DASHBOARD_OLD_FILE])],
  });
}

/**
 * Removed in tunnel mode, so a box switched away from direct TLS keeps no inert websecure router.
 * Applied in either case, so the watched folder exists for Traefik to watch.
 */
export async function ensureSystemRoutes(routes: RouteStore, mode: EdgeMode, dashboardHost: string): Promise<void> {
  if (mode.ingress === "cloudflare_tunnel") {
    await routes.apply({ removes: [DASHBOARD_FILE, EDGE_FILE] });
    return;
  }
  // The middleware file first: the dashboard routers reference it.
  await routes.apply({ writes: await changedFiles(routes, { [EDGE_FILE]: renderEdgeFile(), [DASHBOARD_FILE]: renderDashboardRoute(dashboardHost, mode.certResolver) }) });
}
