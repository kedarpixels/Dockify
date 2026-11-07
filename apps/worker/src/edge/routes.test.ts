import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertTenantHost, reservedHosts } from "./hostnames.ts";
import { API_PATH_PREFIX, API_UPSTREAM, CLIENT_IP_MIDDLEWARE, EDGE_ADDRESSES, loadEdgeSettings, renderTraefikStatic, WEB_UPSTREAM, type EdgeMode } from "./ingress.ts";
import { DOMAIN_CHECK_PREFIX } from "@dockify/crypto";
import { fileRouteStore, ROUTES_SUBDIR, STAGING_SUBDIR } from "@dockify/engine";
import {
  assertNoEmptyValues, backendUrl, CHECK_PRIORITY, DASHBOARD_API_PRIORITY, DASHBOARD_FILE, DASHBOARD_PRIORITY, EDGE_FILE, ensureSystemRoutes, readRoute, rekeyRoute,
  renderDashboardRoute, renderEdgeFile, renderRouteFile, routeFileName, sweepRoutes, writeRoute,
} from "./routes.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const tunnel: EdgeMode = { ingress: "cloudflare_tunnel" };
const direct: EdgeMode = { ingress: "direct_tls", certResolver: "le" };
const reserved = reservedHosts("dash.example.com");

let dir: string;
const routeConfPath = (root: string, appId: string) => join(root, "conf", routeFileName(appId));
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "edge-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("hostnames", () => {
  it("refuses the dashboard host in any case and with a trailing dot", () => {
    expect(() => assertTenantHost("DASH.example.com.", reserved)).toThrow(/dashboard/);
    expect(assertTenantHost("App.Example.com", reserved)).toBe("app.example.com");
  });
  it("refuses anything that could break out of a Host() rule", () => {
    expect(() => assertTenantHost("a`) || Host(`b.com", reserved)).toThrow();
    expect(() => assertTenantHost("10.0.0.1", reserved)).toThrow();
  });
});

const ALIAS = "dk-route-33333333-3333-4333-8333-333333333333";

describe("route render", () => {
  it("tunnel mode is one plain router on web, to the container's alias as a fully qualified name", () => {
    const out = JSON.parse(renderRouteFile({ id: A, port: 3000, hosts: ["a.example.com", "b.example.com"] }, ALIAS, tunnel, reserved)!);
    expect(out.http.routers[A]).toEqual({ rule: "Host(`a.example.com`) || Host(`b.example.com`)", entryPoints: ["web"], service: A });
    // The trailing dot keeps a stopped container a plain DNS miss, never a search-domain lookup.
    expect(out.http.services[A].loadBalancer.servers[0].url).toBe(`http://${ALIAS}.:3000`);
  });
  it("direct mode adds TLS, a redirect and the client IP middleware", () => {
    const out = JSON.parse(renderRouteFile({ id: A, port: 80, hosts: ["a.example.com"] }, ALIAS, direct, reserved)!);
    expect(out.http.routers[A].tls).toEqual({ certResolver: "le" });
    expect(out.http.routers[A].middlewares).toEqual([`${CLIENT_IP_MIDDLEWARE}@file`]);
    expect(out.http.routers[`${A}-redirect`].entryPoints).toEqual(["web"]);
  });
  it("is null when not routable, and refuses a name a tenant could hold, a never-public host or the dashboard host", () => {
    expect(renderRouteFile({ id: A, port: null, hosts: ["a.example.com"] }, ALIAS, tunnel, reserved)).toBeNull();
    expect(renderRouteFile({ id: A, port: 80, hosts: [] }, ALIAS, tunnel, reserved)).toBeNull();
    // A managed service's alias is its app name, which never starts with dk-.
    for (const name of ["app-a", "web", "api", "postgres"]) expect(() => renderRouteFile({ id: A, port: 80, hosts: ["a.example.com"] }, name, tunnel, reserved), name).toThrow(/dk- container name/);
    expect(() => renderRouteFile({ id: A, port: 80, hosts: ["dash.example.com"] }, ALIAS, tunnel, reserved)).toThrow(/dashboard/);
    expect(() => renderRouteFile({ id: A, port: 80, hosts: ["metadata.google.internal"] }, ALIAS, tunnel, reserved)).toThrow(/internal/);
  });
  it("still takes an address, for the swap's pin on a container made before route aliases", () => {
    const out = JSON.parse(renderRouteFile({ id: A, port: 3000, hosts: ["a.example.com"] }, "172.20.0.5", tunnel, reserved)!);
    expect(out.http.services[A].loadBalancer.servers[0].url).toBe("http://172.20.0.5:3000");
    expect(backendUrl("fd00::5", 80)).toBe("http://[fd00::5]:80");
  });
  it("is byte-stable", () => {
    const app = { id: A, port: 80, hosts: ["a.example.com"] };
    expect(renderRouteFile(app, ALIAS, tunnel, reserved)).toBe(renderRouteFile(app, ALIAS, tunnel, reserved));
  });
});

describe("the domain ownership probe's routers", () => {
  const edge = JSON.parse(renderEdgeFile());
  const routers = edge.http.routers as Record<string, { rule: string; entryPoints: string[]; service: string; priority: number; tls?: unknown; middlewares: string[] }>;

  it("send exactly the check path, on any host and both entry points, to the api", () => {
    expect(Object.keys(routers).sort()).toEqual(["dockify-check", "dockify-check-tls"]);
    for (const r of Object.values(routers)) {
      expect(r.rule).toBe(`PathPrefix(\`${DOMAIN_CHECK_PREFIX}\`)`);
      expect(r.rule).not.toMatch(/Host/);
      expect(r.service).toBe("dockify-check");
      expect(r.middlewares).toEqual([`${CLIENT_IP_MIDDLEWARE}@file`]);
    }
    expect(routers["dockify-check"]!.entryPoints).toEqual(["web"]);
    expect(routers["dockify-check-tls"]!.entryPoints).toEqual(["websecure"]);
    expect(edge.http.services["dockify-check"]).toEqual({ loadBalancer: { servers: [{ url: API_UPSTREAM }], passHostHeader: true } });
    expect(DOMAIN_CHECK_PREFIX).toBe("/.well-known/dockify-check/");
  });

  it("outrank every tenant router, so no app can answer for a name, and stay below the dashboard's", () => {
    const longest = renderRouteFile({ id: A, port: 80, hosts: Array.from({ length: 50 }, (_, i) => `host-${i}.a-rather-long-tenant-domain.example.com`) }, ALIAS, direct, reserved)!;
    const rule = JSON.parse(longest).http.routers[A].rule as string;
    // A tenant router has no priority of its own: Traefik ranks it by its rule's length.
    expect(JSON.parse(longest).http.routers[A].priority).toBeUndefined();
    expect(CHECK_PRIORITY).toBeGreaterThan(rule.length);
    expect(CHECK_PRIORITY).toBeLessThan(DASHBOARD_PRIORITY);
    for (const r of Object.values(routers)) expect(r.priority).toBe(CHECK_PRIORITY);
  });

  it("never name a certificate resolver, so the check never asks Let's Encrypt for a name", () => {
    // TLS on websecure comes from the entry point (compose: --entrypoints.websecure.http.tls=true).
    for (const r of Object.values(routers)) expect(r.tls).toBeUndefined();
    expect(renderEdgeFile()).not.toMatch(/certResolver/);
  });

  it("rely on the direct-mode proxy terminating TLS for every websecure router", () => {
    const compose = readFileSync(resolve(import.meta.dirname, "../../../../deploy/docker-compose.yml"), "utf8");
    const direct = /^ {2}proxy-direct:\n([\s\S]*?)(?=^ {2}\S|^\S)/m.exec(compose)?.[1] ?? "";
    expect(direct).toContain("- --entrypoints.websecure.http.tls=true");
    expect(direct).not.toMatch(/--entrypoints\.websecure\.http\.tls\.certresolver/i);
  });
});

describe("no empty values in any file Traefik reads", () => {
  /** Every empty map, empty list and null in a document, by path. */
  const empties = (v: unknown, path = "$"): string[] => {
    if (v === null || v === undefined) return [path];
    if (Array.isArray(v)) return v.length === 0 ? [path] : v.flatMap((x, i) => empties(x, `${path}[${i}]`));
    if (typeof v === "object") {
      const e = Object.entries(v as Record<string, unknown>);
      return e.length === 0 ? [path] : e.flatMap(([k, x]) => empties(x, `${path}.${k}`));
    }
    return [];
  };

  it("renders the edge file with the client-IP middleware and nothing empty", () => {
    const edge = JSON.parse(renderEdgeFile());
    expect(Object.keys(edge.http.middlewares)).toEqual([CLIENT_IP_MIDDLEWARE]);
    expect(empties(edge)).toEqual([]);
  });

  it("finds none in any system or tenant file, in either mode", async () => {
    const docs = [
      renderEdgeFile(),
      renderDashboardRoute("dash.example.com", "le"),
      renderRouteFile({ id: A, port: 80, hosts: ["a.example.com"] }, ALIAS, tunnel, reserved)!,
      renderRouteFile({ id: A, port: 80, hosts: ["a.example.com", "b.example.com"] }, ALIAS, direct, reserved)!,
      renderRouteFile({ id: A, port: 80, hosts: ["pr-1.preview.example.com"], wildcard: { domain: "preview.example.com", certResolver: "ledns" } }, ALIAS, direct, reserved)!,
    ];
    for (const d of docs) expect(empties(JSON.parse(d))).toEqual([]);
    // Every file a direct-mode worker leaves in the watched folder, after a host moved between apps.
    await ensureSystemRoutes(fileRouteStore(dir), direct, "dash.example.com");
    await writeRoute(fileRouteStore(dir), { id: B, port: 80, hosts: ["x.example.com", "y.example.com"] }, ALIAS, direct, reserved);
    await writeRoute(fileRouteStore(dir), { id: A, port: 80, hosts: ["x.example.com"] }, ALIAS, direct, reserved);
    const files = await readdir(join(dir, "conf"));
    expect(files.sort()).toEqual([DASHBOARD_FILE, EDGE_FILE, `${A}.yml`, `${B}.yml`].sort());
    for (const f of files) expect(empties(JSON.parse(await readFile(join(dir, "conf", f), "utf8"))), f).toEqual([]);
  });

  it("refuses to serialize a document that has one, so a bug can never take every route down", () => {
    expect(() => assertNoEmptyValues({ http: { routers: {} } })).toThrow(/empty map at \$\.http\.routers/);
    expect(() => assertNoEmptyValues({ http: { routers: { a: { entryPoints: [] } } } })).toThrow(/empty list/);
    expect(() => assertNoEmptyValues({ http: { services: null } })).toThrow(/no value/);
    expect(() => assertNoEmptyValues({ http: { middlewares: { m: { headers: { customRequestHeaders: { X: "" } } } } } })).not.toThrow();
  });
});

describe("route files", () => {
  it("writes atomically, skips unchanged and leaves nothing in staging", async () => {
    const app = { id: A, port: 80, hosts: ["a.example.com"] };
    expect(await writeRoute(fileRouteStore(dir), app, ALIAS, tunnel, reserved)).toBe("written");
    expect(await writeRoute(fileRouteStore(dir), app, ALIAS, tunnel, reserved)).toBe("unchanged");
    expect(await readdir(join(dir, ".staging"))).toEqual([]);
    expect(await readFile(routeConfPath(dir, A), "utf8")).toContain(`${ALIAS}.:80`);
  });
  it("reads back what a file routes: its hosts and its backend, a name or an address", async () => {
    await writeRoute(fileRouteStore(dir), { id: A, port: 80, hosts: ["a.example.com", "b.example.com"] }, ALIAS, direct, reserved);
    expect(await readRoute(fileRouteStore(dir), A)).toEqual({ hosts: ["a.example.com", "b.example.com"], backend: ALIAS });
    await writeRoute(fileRouteStore(dir), { id: B, port: 80, hosts: ["c.example.com"] }, "fd00::7", tunnel, reserved);
    expect(await readRoute(fileRouteStore(dir), B)).toEqual({ hosts: ["c.example.com"], backend: "fd00::7" });
    expect(await readRoute(fileRouteStore(dir), "nope")).toBeNull();
  });
  it("re-keys a file from an address to a container name and touches nothing else", async () => {
    await writeRoute(fileRouteStore(dir), { id: `pv-${A}`, port: 3000, hosts: ["pr-1.preview.example.com"] }, "10.9.0.5", direct, reserved);
    const before = await readFile(routeConfPath(dir, `pv-${A}`), "utf8");
    expect(await rekeyRoute(fileRouteStore(dir), `pv-${A}`, "10.9.0.5", `dk-pv-${A}-abcd1234`)).toBe(true);
    const after = await readFile(routeConfPath(dir, `pv-${A}`), "utf8");
    expect(after).toBe(before.replace('"http://10.9.0.5:3000"', `"http://dk-pv-${A}-abcd1234.:3000"`));
    expect(await rekeyRoute(fileRouteStore(dir), `pv-${A}`, "10.9.0.5", `dk-pv-${A}-abcd1234`)).toBe(false);
    await expect(rekeyRoute(fileRouteStore(dir), `pv-${A}`, "10.9.0.5", "web")).rejects.toThrow();
  });
  it("moves a host: strips it from the other file and keeps that file's other hosts", async () => {
    await writeRoute(fileRouteStore(dir), { id: B, port: 80, hosts: ["x.example.com", "y.example.com"] }, "10.1.0.3", tunnel, reserved);
    await writeRoute(fileRouteStore(dir), { id: A, port: 80, hosts: ["x.example.com"] }, "10.1.0.2", tunnel, reserved);
    const b = JSON.parse(await readFile(routeConfPath(dir, B), "utf8"));
    expect(b.http.routers[B].rule).toBe("Host(`y.example.com`)");
  });
  it("drops another file left with no host", async () => {
    await writeRoute(fileRouteStore(dir), { id: B, port: 80, hosts: ["x.example.com"] }, "10.1.0.3", tunnel, reserved);
    await writeRoute(fileRouteStore(dir), { id: A, port: 80, hosts: ["x.example.com"] }, "10.1.0.2", tunnel, reserved);
    expect(await readdir(join(dir, "conf"))).toEqual([`${A}.yml`]);
  });
  it("removes the file when the app is no longer routable", async () => {
    await writeRoute(fileRouteStore(dir), { id: A, port: 80, hosts: ["a.example.com"] }, "10.1.0.2", tunnel, reserved);
    expect(await writeRoute(fileRouteStore(dir), { id: A, port: 80, hosts: [] }, "10.1.0.2", tunnel, reserved)).toBe("removed");
    expect(await readdir(join(dir, "conf"))).toEqual([]);
  });
  it("sweeps orphans but never system files", async () => {
    await mkdir(join(dir, "conf"), { recursive: true });
    await writeFile(join(dir, "conf", DASHBOARD_FILE), "{}");
    await writeRoute(fileRouteStore(dir), { id: A, port: 80, hosts: ["a.example.com"] }, "10.1.0.2", tunnel, reserved);
    await writeRoute(fileRouteStore(dir), { id: B, port: 80, hosts: ["b.example.com"] }, "10.1.0.3", tunnel, reserved);
    expect(await sweepRoutes(fileRouteStore(dir), [A])).toEqual([`${B}.yml`]);
    expect((await readdir(join(dir, "conf"))).sort()).toEqual([DASHBOARD_FILE, `${A}.yml`].sort());
  });
  it("system routes exist only in direct mode, with the dashboard outranking tenants", async () => {
    await ensureSystemRoutes(fileRouteStore(dir), direct, "dash.example.com");
    const dash = JSON.parse(await readFile(join(dir, "conf", DASHBOARD_FILE), "utf8"));
    expect(dash.http.routers.dashboard.priority).toBeGreaterThan(10_000);
    expect(dash.http.routers.dashboard.middlewares).toEqual([`${CLIENT_IP_MIDDLEWARE}@file`]);
    const edge = JSON.parse(await readFile(join(dir, "conf", EDGE_FILE), "utf8"));
    expect(edge.http.middlewares[CLIENT_IP_MIDDLEWARE].headers.customRequestHeaders["CF-Connecting-IP"]).toBe("");
    await ensureSystemRoutes(fileRouteStore(dir), tunnel, "dash.example.com");
    expect(await readdir(join(dir, "conf"))).toEqual([]);
  });
  it("creates the watched folder even with nothing to route, so Traefik always has it to watch", async () => {
    await ensureSystemRoutes(fileRouteStore(dir), tunnel, "dash.example.com");
    expect(await readdir(join(dir, "conf"))).toEqual([]);
  });
});

describe("the folder Traefik watches is the folder the worker writes", () => {
  const root = resolve(import.meta.dirname, "../../../..");
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  const service = (name: string) => new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|^\\S)`, "m").exec(compose)?.[1] ?? "";
  /** host:container bind mounts of the ./proxy folder in a service. */
  const proxyMount = (svc: string) => {
    const m = /["\s-]\.\/proxy:(\/[\w/.-]+?)(?::ro)?["\s,\]]/.exec(service(svc));
    return m?.[1] ?? null;
  };
  /** The host path (relative to the install folder) a container path lands on through ./proxy. */
  const onHost = (svc: string, p: string) => {
    const at = proxyMount(svc);
    if (!at || (p !== at && !p.startsWith(`${at}/`))) return null;
    return `./proxy${p.slice(at.length)}`;
  };
  const env = (svc: string, key: string) => new RegExp(`${key}: (\\S+)`).exec(service(svc))?.[1] ?? null;

  it("both proxy services watch ./proxy/conf, exactly where the agent lands the worker's routes", () => {
    const routesDir = env("agent", "DOCKIFY_PROXY_DIR");
    expect(routesDir).not.toBeNull();
    const written = onHost("agent", posix.join(routesDir!, ROUTES_SUBDIR));
    expect(written).toBe("./proxy/conf");
    for (const svc of ["proxy", "proxy-direct"]) {
      const watched = /--providers\.file\.directory=(\S+)/.exec(service(svc))?.[1];
      expect(watched, svc).toBeDefined();
      expect(onHost(svc, watched!), svc).toBe(written);
      expect(service(svc), svc).toContain("--providers.file.watch=true");
    }
  });

  it("keeps staging on the same mount but outside the watched folder, so a rename is atomic and unseen", () => {
    const routesDir = env("agent", "DOCKIFY_PROXY_DIR")!;
    const staging = onHost("agent", posix.join(routesDir, STAGING_SUBDIR));
    expect(staging).toBe("./proxy/.staging");
    expect(staging!.startsWith("./proxy/conf/")).toBe(false);
  });

  it("has the installer create the watched folder, which Traefik needs to exist when it starts, and write no route itself", () => {
    const install = readFileSync(join(root, "installer/install.sh"), "utf8");
    expect(install).toContain('install -d -m 0750 -o 1000 -g 1000 "$DIR/proxy/conf"');
    // On a fresh install and on --upgrade alike.
    expect(install.match(/^\s*make_route_folder$/gm)?.length).toBe(2);
    expect(install).not.toMatch(/> "\$DIR\/proxy\/[^"]*\.yml"/);
  });
});

describe("the api on the dashboard host (direct mode)", () => {
  type Router = { rule: string; entryPoints: string[]; service: string; priority: number; tls?: unknown; middlewares?: string[] };
  const file = () => JSON.parse(renderDashboardRoute("Dash.Example.com", "le")) as {
    http: { routers: Record<string, Router>; services: Record<string, { loadBalancer: { servers: Array<{ url: string }> } }> };
  };

  it("sends /api/v1/ to the api ahead of the web, over TLS, through the client-IP middleware", () => {
    const { routers, services } = file().http;
    const api = routers["dashboard-api"]!;
    expect(api.rule).toBe("Host(`dash.example.com`) && PathPrefix(`/api/v1/`)");
    expect(api.entryPoints).toEqual(["websecure"]);
    expect(api.tls).toEqual({ certResolver: "le" });
    expect(api.middlewares).toEqual([`${CLIENT_IP_MIDDLEWARE}@file`]);
    expect(api.priority).toBe(DASHBOARD_API_PRIORITY);
    expect(api.priority).toBeGreaterThan(routers.dashboard!.priority);
    expect(services[api.service]!.loadBalancer.servers).toEqual([{ url: API_UPSTREAM }]);
    expect(services[routers.dashboard!.service]!.loadBalancer.servers).toEqual([{ url: WEB_UPSTREAM }]);
    expect(routers.dashboard!.priority).toBe(DASHBOARD_PRIORITY);
  });

  it("names both backends by their fixed address, so no tenant alias can answer for them", () => {
    expect(API_UPSTREAM).toBe(`http://${EDGE_ADDRESSES.api}:3001`);
    expect(WEB_UPSTREAM).toBe(`http://${EDGE_ADDRESSES.web}:3000`);
    for (const s of Object.values(file().http.services)) expect(s.loadBalancer.servers[0]!.url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
  });

  it("routes only the api prefix: the internal and health routes never match it", () => {
    const prefix = API_PATH_PREFIX;
    for (const path of ["/internal/secrets/open", "/healthz", "/readyz", "/api/v1x/overview", "/api/status"]) expect(path.startsWith(prefix), path).toBe(false);
    for (const path of ["/api/v1/webhooks/github", "/api/v1/webhooks/vercel", "/api/v1/git/setup", "/api/v1/git/app/callback", "/api/v1/projects"]) expect(path.startsWith(prefix), path).toBe(true);
  });

  it("keeps the redirect for plain http on the whole host", () => {
    const r = file().http.routers["dashboard-redirect"]!;
    expect(r.rule).toBe("Host(`dash.example.com`)");
    expect(r.entryPoints).toEqual(["web"]);
  });
});

describe("compose and edge agree on the control plane's addresses", () => {
  const root = resolve(import.meta.dirname, "../../../..");
  const compose = readFileSync(join(root, "deploy/docker-compose.yml"), "utf8");
  const service = (name: string) => new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}\\S|^\\S)`, "m").exec(compose)?.[1] ?? "";
  const edgeAddress = (name: string) => /edge: \{ ipv4_address: ([\d.]+) \}/.exec(service(name))?.[1];

  it("pins every address the routes and the api's trust list name", () => {
    expect(edgeAddress("api")).toBe(EDGE_ADDRESSES.api);
    expect(edgeAddress("web")).toBe(EDGE_ADDRESSES.web);
    expect(edgeAddress("proxy-direct")).toBe(EDGE_ADDRESSES.proxyDirect);
    expect(edgeAddress("cloudflared")).toBe(EDGE_ADDRESSES.cloudflared);
  });

  it("lets the api trust exactly the three hops that reach it: the web, Traefik and cloudflared", () => {
    const trusted = /DOCKIFY_TRUSTED_PROXIES: ([\d.,]+)/.exec(service("api"))?.[1]?.split(",");
    expect(trusted?.sort()).toEqual([EDGE_ADDRESSES.web, EDGE_ADDRESSES.proxyDirect, EDGE_ADDRESSES.cloudflared].sort());
    // The api's internal routes stay pinned to the worker's control address, never an edge hop.
    expect(service("api")).toMatch(/DOCKIFY_INTERNAL_PEERS: 172\.30\.2\.20\n/);
  });
});

describe("the web never serves the api prefix", () => {
  const web = resolve(import.meta.dirname, "../../../web");
  it("has no route under app/api/v1, so the api owns every /api/v1/ path", () => {
    expect(existsSync(join(web, "app"))).toBe(true);
    expect(existsSync(join(web, "app/api/v1"))).toBe(false);
  });
});

describe("ingress", () => {
  const base = { DOCKIFY_PUBLIC_URL: "https://dash.example.com" };
  it("defaults to the tunnel and reads the dashboard host from the public URL", () => {
    const s = loadEdgeSettings(base);
    expect(s.mode).toEqual({ ingress: "cloudflare_tunnel" });
    expect(s.dashboardHost).toBe("dash.example.com");
  });
  it("direct mode needs an ACME email and refuses a bad server address", () => {
    expect(() => loadEdgeSettings({ ...base, DOCKIFY_INGRESS: "direct_tls" })).toThrow(/ACME/);
    expect(() => loadEdgeSettings({ ...base, DOCKIFY_SERVER_IPV4: "::1" })).toThrow();
    expect(loadEdgeSettings({ ...base, DOCKIFY_INGRESS: "direct_tls", DOCKIFY_ACME_EMAIL: "ops@example.com" }).mode).toEqual(direct);
  });
  it("direct static config trusts no forwarded header and has no docker provider", () => {
    const s = JSON.parse(renderTraefikStatic({ mode: direct, acmeEmail: "ops@example.com" }));
    expect(s.entryPoints.web.forwardedHeaders).toEqual({ insecure: false });
    expect(s.entryPoints.websecure.forwardedHeaders).toEqual({ insecure: false });
    expect(s.providers.docker).toBeUndefined();
    expect(s.certificatesResolvers.le.acme.httpChallenge.entryPoint).toBe("web");
    expect(s.api.dashboard).toBe(false);
  });
  it("tunnel static config has no public TLS entry point", () => {
    const s = JSON.parse(renderTraefikStatic({ mode: tunnel, tunnelPeers: ["172.18.0.9"] }));
    expect(s.entryPoints.websecure).toBeUndefined();
    expect(s.entryPoints.web.forwardedHeaders.trustedIPs).toEqual(["172.18.0.9"]);
    expect(() => renderTraefikStatic({ mode: tunnel, tunnelPeers: ["cloudflared"] })).toThrow();
  });
});
