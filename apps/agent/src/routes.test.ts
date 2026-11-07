import { describe, expect, it } from "vitest";
import { refuseCollidingNames, RouteRefusal, tenantAddresses, validateRouteFile } from "./routes.ts";

const API = "http://172.30.1.10:3001";
const WEB = "http://172.30.1.20:3000";
const rules = { upstreams: [API, WEB] };

const app = (url = "http://dk-route-1.:3000") => ({
  http: {
    routers: { a: { rule: "Host(`a.example.com`)", entryPoints: ["websecure"], service: "a", tls: { certResolver: "le" }, middlewares: ["dockify-client-ip@file"] } },
    services: { a: { loadBalancer: { servers: [{ url }], passHostHeader: true } } },
  },
});
const check = (doc: unknown, r: Parameters<typeof validateRouteFile>[1] = rules, name?: string) => () => validateRouteFile(typeof doc === "string" ? doc : JSON.stringify(doc), r, name);
/** A file with one router and one service, with parts of it replaced. */
const one = (o: { router?: object; lb?: object; middlewares?: object } = {}) => ({
  http: {
    routers: { r: { rule: "Host(`a.example.com`)", entryPoints: ["web"], service: "s", ...o.router } },
    services: { s: { loadBalancer: { servers: [{ url: "http://dk-a.:1" }], ...o.lb } } },
    ...(o.middlewares ? { middlewares: o.middlewares } : {}),
  },
});

describe("a route file", () => {
  it("a tenant's backend passes, and an address only while a tenant's container holds it", () => {
    expect(check(app())).not.toThrow();
    expect(check(app("http://172.18.0.5:3000"), { ...rules, heldAddresses: new Set(["172.18.0.5"]) })).not.toThrow();
    expect(check(app("http://172.18.0.5:3000"), { ...rules, heldAddresses: new Set(["172.18.0.6"]) })).toThrow(RouteRefusal);
    expect(check(app("http://172.18.0.5:3000"))).toThrow(RouteRefusal);
  });
  it("the dashboard's upstreams pass only where this server holds them", () => {
    expect(check(app(API))).not.toThrow();
    expect(check(app(WEB))).not.toThrow();
    expect(check(app(API), { upstreams: [] })).toThrow(RouteRefusal);
  });
  it.each([
    ["the socket proxy", "http://172.30.4.2:2375"],
    ["Postgres", "http://172.30.3.2:5432"],
    ["the api's control address", "http://172.30.2.10:3001"],
    ["the worker's link", "http://172.30.5.20:3003"],
    ["loopback", "http://127.0.0.1:2375"],
    ["the metadata service", "http://169.254.169.254:80"],
    ["loopback in IPv6", "http://[::1]:80"],
    ["the host through Docker's default bridge", "http://172.17.0.1:22"],
    ["a public address", "http://203.0.113.5:80"],
    ["a name that is not reserved", "http://postgres:5432"],
    ["a public site", "https://evil.example.com"],
    ["a path on a tenant", "http://dk-a.:80/x"],
    ["a file URL", "file:///etc/passwd"],
    // What a legacy address used to reach.
    ["a neighbour on a private network", "http://10.0.0.5:22"],
    ["the host's LAN address", "http://192.168.1.10:80"],
    ["another bridge's container", "http://172.17.0.2:22"],
    ["an IPv6 unique local address", "http://[fd00::1]:22"],
    ["another IPv6 unique local address", "http://[fc00::1]:22"],
    // The proxy's own name publishes its metrics on a tenant's host.
    ["the proxy's metrics", "http://dk-proxy.:8082"],
    ["the proxy's dashboard port", "http://dk-proxy.:8080"],
    ["a control name by its other spelling", "http://DK-PROXY.:8082"],
  ])("refuses a backend at %s", (_label, url) => {
    expect(check(app(url))).toThrow(RouteRefusal);
  });
  it.each([
    "http://172.30.4.2:2375",
    "http://127.0.0.1:2375",
    "http://169.254.169.254:80",
    "http://172.17.0.1:22",
    "http://[fd00::1]:22",
  ])("refuses %s even if something claims a tenant holds it", (url) => {
    const host = url.replace(/^http:\/\/\[?/, "").replace(/\]?:\d+$/, "");
    expect(check(app(url), { ...rules, heldAddresses: new Set([host]) })).toThrow(RouteRefusal);
  });
  it.each<[string, unknown]>([
    ["not JSON", "http:\n  routers: {}\n"],
    ["another top level key", { ...app(), tcp: { routers: {} } }],
    ["tls options", { ...app(), tls: { options: {} } }],
    ["an http section it does not know", { http: { ...app().http, serversTransports: { x: {} } } }],
    ["an empty section", { http: { ...app().http, middlewares: {} } }],
    ["a plugin middleware", { http: { ...app().http, middlewares: { m: { plugin: { x: {} } } } } }],
    ["forwardAuth to anywhere else", { http: { ...app().http, middlewares: { m: { forwardAuth: { address: "http://172.30.4.2:2375/x", trustForwardHeader: false, authResponseHeaders: ["X"] } } } } }],
    ["forwardAuth trusting headers", { http: { ...app().http, middlewares: { m: { forwardAuth: { address: `${API}/x`, trustForwardHeader: true, authResponseHeaders: ["X"] } } } } }],
    ["a router key it does not know", { http: { routers: { a: { ...app().http.routers.a, ruleSyntax: "v2" } }, services: app().http.services } }],
    ["a router naming another file's service", { http: { routers: { a: { ...app().http.routers.a, service: "api@internal" } }, services: app().http.services } }],
    ["a router on an unknown entry point", { http: { routers: { a: { ...app().http.routers.a, entryPoints: ["traefik"] } }, services: app().http.services } }],
    ["an unknown resolver", { http: { routers: { a: { ...app().http.routers.a, tls: { certResolver: "mine" } } }, services: app().http.services } }],
    ["a load balancer with a transport", { http: { routers: app().http.routers, services: { a: { loadBalancer: { servers: [{ url: "http://dk-a.:80" }], serversTransport: "x" } } } } }],
    ["a mirroring service", { http: { routers: app().http.routers, services: { a: { mirroring: { service: "x" } } } } }],
  ])("refuses %s", (_label, doc) => {
    expect(check(doc)).toThrow(RouteRefusal);
  });
});

describe("what Traefik would read differently from what was checked", () => {
  const raw = (rule: string) => `{"http":{"services":{"s":{"loadBalancer":{"servers":[{"url":"http://dk-a.:1"}]}}},"routers":{"r":{"entryPoints":["web"],"service":"s","rule":${JSON.stringify(rule)}}}}}`;
  const payload = Buffer.from('"}}},"tcp":{"services":{"t":{"loadBalancer":{"servers":[{"address":"172.30.1.1:22"}]}}},"routers":{"t":{"entryPoints":["web"],"service":"t","rule":"HostSNI(`*`)').toString("base64");
  it.each<[string, string]>([
    ["a template that writes a tcp router to the host's sshd", raw(`Host(\`a\`){{ b64dec \`${payload}\` }}`)],
    ["a template that writes a router on api@internal", raw(`Host(\`a\`){{ b64dec \`${Buffer.from('","service":"api@internal').toString("base64")}\` }}`)],
    ["a bare opening of a template", raw("Host(`a`){{")],
    ["a template in a header", '{"http":{"middlewares":{"m":{"headers":{"customResponseHeaders":{"X-Leak":"{{ env `HOME` }}"}}}},"routers":{"r":{"rule":"Host(`a`)","entryPoints":["web"],"service":"s","middlewares":["m"]}},"services":{"s":{"loadBalancer":{"servers":[{"url":"http://dk-a.:1"}]}}}}}'],
    ["a template spelled in JSON escapes", '{"http":{"middlewares":{"m":{"headers":{"customResponseHeaders":{"X-Leak":"\\u007b\\u007b env `HOME` }}"}}}},"routers":{"r":{"rule":"Host(`a`)","entryPoints":["web"],"service":"s","middlewares":["m"]}},"services":{"s":{"loadBalancer":{"servers":[{"url":"http://dk-a.:1"}]}}}}}'],
    ["a template in a redirect's replacement", '{"http":{"middlewares":{"m":{"redirectRegex":{"regex":"x","replacement":"{{ env `HOME` }}","permanent":false}}},"routers":{"r":{"rule":"Host(`a`)","entryPoints":["web"],"service":"s","middlewares":["m"]}},"services":{"s":{"loadBalancer":{"servers":[{"url":"http://dk-a.:1"}]}}}}}'],
  ])("refuses %s", (_label, text) => {
    expect(() => validateRouteFile(text, rules)).toThrow(RouteRefusal);
  });

  it("what is written is the validator's text: a duplicate key does not survive it", () => {
    const text = '{"http":{"services":{"s":{"loadBalancer":{"servers":[{"url":"http://169.254.169.254:80"}]}},"s":{"loadBalancer":{"servers":[{"url":"http://dk-a.:1"}]}}},"routers":{"r":{"rule":"Host(`a`)","entryPoints":["web"],"service":"s"}}}}';
    const out = validateRouteFile(text, rules);
    expect(out).not.toContain("169.254");
    expect(out).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  });

  it("a file already in the worker's form comes back byte for byte, so nothing rewrites it for nothing", () => {
    const text = `${JSON.stringify(app(), null, 2)}\n`;
    expect(validateRouteFile(text, rules)).toBe(text);
  });
});

describe("a shape Traefik's decoder refuses, which could stop every route on the server", () => {
  it.each<[string, unknown]>([
    ["an entry point in a nested list", one({ router: { entryPoints: [["web"]] } })],
    ["an entry point that is not text", one({ router: { entryPoints: [1] } })],
    ["passHostHeader as text", one({ lb: { passHostHeader: "notabool" } })],
    ["middlewares as a string", one({ router: { middlewares: "m" }, middlewares: { m: { replacePath: { path: "/" } } } })],
    ["a resolver in a list", one({ router: { tls: { certResolver: ["le"] } } })],
    ["a tls domain that is not text", one({ router: { tls: { certResolver: "le", domains: [{ main: 1 }] } } })],
    ["a null anywhere", one({ router: { middlewares: null } })],
    ["an empty list", one({ router: { middlewares: [] } })],
    ["an empty header map", one({ middlewares: { m: { headers: { customRequestHeaders: {} } } } })],
    ["a header value that is not text", one({ middlewares: { m: { headers: { customRequestHeaders: { A: 1 } } } } })],
    ["a header name with a space", one({ middlewares: { m: { headers: { customRequestHeaders: { "A B": "x" } } } } })],
    ["a redirect with a number", one({ middlewares: { m: { redirectRegex: { regex: 1, replacement: "x", permanent: false } } } })],
    ["permanent as text", one({ middlewares: { m: { redirectScheme: { scheme: "https", permanent: "yes" } } } })],
    ["a redirect to another scheme", one({ middlewares: { m: { redirectScheme: { scheme: "gopher", permanent: true } } } })],
    ["two kinds in one middleware", one({ middlewares: { m: { replacePath: { path: "/" }, stripPrefix: { prefixes: ["/"] } } } })],
    ["a priority that is not a whole number", one({ router: { priority: 1.5 } })],
    ["a priority past the ceiling", one({ router: { priority: 1e12 } })],
    ["a matcher Dockify does not write", one({ router: { rule: "HostSNI(`*`)" } })],
    ["a rule with something else in it", one({ router: { rule: "Host(`a`) x" } })],
    ["a rule that is empty", one({ router: { rule: "" } })],
    ["a middleware from another file", one({ router: { middlewares: ["dashboard-https@file"] } })],
    ["an internal middleware", one({ router: { middlewares: ["x@internal"] } })],
    ["two routers one reader would merge", { http: { routers: { r: one().http.routers.r, R: one().http.routers.r }, services: one().http.services } }],
    ["two services one reader would merge, by the Kelvin sign", { http: { routers: { k: { ...one().http.routers.r, service: "k" } }, services: { k: one().http.services.s, "K": one().http.services.s } } }],
  ])("refuses %s", (_label, doc) => {
    expect(check(doc)).toThrow(RouteRefusal);
  });

  it.each<[string, string]>([
    ["a priority of 1e400, which JSON.parse reads as infinity", JSON.stringify(one({ router: { priority: 1 } })).replace('"priority":1', '"priority":1e400')],
    ["a key spelled two ways", JSON.stringify(one()).replace('"routers":', '"Routers":{},"routers":')],
    ["a section nested far past any real file", `{"http":{"routers":${"[".repeat(64)}${"]".repeat(64)}}}`],
  ])("refuses %s, as raw text", (_label, text) => {
    expect(() => validateRouteFile(text, rules)).toThrow(RouteRefusal);
  });
});

describe("the system files", () => {
  const edge = { http: { services: { "dockify-check": { loadBalancer: { servers: [{ url: API }] } } }, routers: { "dockify-check": { rule: "PathPrefix(`/x`)", entryPoints: ["web"], service: "dockify-check" } } } };
  it("take only their own names and only the control plane's backends", () => {
    expect(check(edge, rules, "__edge.yml")).not.toThrow();
    expect(check(edge, rules, "__other.yml")).toThrow(RouteRefusal);
    expect(check(app(), rules, "__dashboard.yml")).toThrow(RouteRefusal);
    expect(check(app(API), rules, "__dashboard.yml")).not.toThrow();
  });
  it("no other file may use their names", () => {
    expect(check(edge, rules, "0f0e0d0c.yml")).toThrow(RouteRefusal);
    expect(check({ http: { routers: { dashboard: one().http.routers.r }, services: one().http.services } }, rules, "0f0e0d0c.yml")).toThrow(RouteRefusal);
  });
});

describe("a name in two files", () => {
  const file = (router: string) => JSON.stringify({ http: { routers: { [router]: { rule: "Host(`a.example.com`)", entryPoints: ["web"], service: router } }, services: { [router]: { loadBalancer: { servers: [{ url: "http://dk-a.:1" }] } } } } });
  it("is refused, in either case", () => {
    expect(() => refuseCollidingNames({ "a.yml": file("one") }, { "b.yml": file("one") }, [])).toThrow(RouteRefusal);
    expect(() => refuseCollidingNames({ "a.yml": file("one") }, { "b.yml": file("ONE") }, [])).toThrow(RouteRefusal);
    expect(() => refuseCollidingNames({}, { "a.yml": file("one"), "b.yml": file("one") }, [])).toThrow(RouteRefusal);
  });
  it("is fine when it is the same file, when the other one goes in the same change, or when a file on disk cannot be read", () => {
    expect(() => refuseCollidingNames({ "a.yml": file("one") }, { "a.yml": file("one") }, [])).not.toThrow();
    expect(() => refuseCollidingNames({ "a.yml": file("one") }, { "b.yml": file("one") }, ["a.yml"])).not.toThrow();
    expect(() => refuseCollidingNames({ "x.yml": "not json" }, { "b.yml": file("one") }, [])).not.toThrow();
  });
});

describe("the addresses tenants hold", () => {
  it("reads tenant networks only", () => {
    const held = tenantAddresses([
      { NetworkSettings: { Networks: { "dockify-env-a": { IPAddress: "172.18.0.5" }, dockify_control: { IPAddress: "172.30.2.9" } } } },
      { NetworkSettings: { Networks: { "dockify-pv-x": { IPAddress: "172.19.0.2" }, "dockify-helpers": { IPAddress: "172.20.0.2" } } } },
      { NetworkSettings: { Networks: { "dockify-env-b": { IPAddress: "" } } } },
      { NetworkSettings: null },
      {},
    ]);
    expect([...held].sort()).toEqual(["172.18.0.5", "172.19.0.2", "172.20.0.2"]);
  });
});
