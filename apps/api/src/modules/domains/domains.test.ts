import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { endpoints, type EndpointId } from "@dockify/contracts";
import { domainCheckAnswer, domainCheckToken } from "@dockify/crypto";
import { buildApp, type Ctx } from "../../app.ts";
import { describePolicy, POLICIES } from "../../policy.ts";
import { noDb, testConfig, testRing } from "../../test-helpers.ts";
import { hostOf, registerDomainCheckRoute } from "./check-route.ts";
import { domainHandlers } from "./handlers.ts";
import { isReserved, jobsForCreate, jobsForDelete, reservedHosts, toDomainRow } from "./logic.ts";

const publicUrl = new URL("https://dash.example.com");

describe("reserved hostnames", () => {
  it("reserves the dashboard host and any listed extras, case and trailing dot ignored", () => {
    const r = reservedHosts(publicUrl, " Status.Example.com ,");
    expect(isReserved("DASH.example.com.", r)).toBe(true);
    expect(isReserved("status.example.com", r)).toBe(true);
    expect(isReserved("app.dash.example.com", r)).toBe(false);
  });

  it("create refuses the dashboard host before touching the database", async () => {
    const ctx = { config: { publicUrl, ingress: "cloudflare_tunnel", reservedHosts: [], serverIpv4: null, tunnelTarget: null }, db: new Proxy({}, { get: () => { throw new Error("db touched"); } }) } as unknown as Ctx;
    const actor = { kind: "session", userId: "u", name: "Owner", role: "admin", sessionId: "s", elevated: false } as const;
    await expect(
      domainHandlers["domains.create"]!({ body: { hostname: "dash.example.com", appId: "11111111-1111-4111-8111-111111111111" }, actor, ctx, req: {} as never, reply: {} as never, query: undefined as never, params: undefined as never }),
    ).rejects.toMatchObject({ status: 400, code: "RESERVED_HOSTNAME" });
  });
});

describe("names that can never be public", () => {
  const ctx = { config: { publicUrl, ingress: "direct_tls", reservedHosts: [], serverIpv4: null, tunnelTarget: null }, db: new Proxy({}, { get: () => { throw new Error("db touched"); } }) } as unknown as Ctx;
  const actor = { kind: "session", userId: "u", name: "Owner", role: "admin", sessionId: "s", elevated: true } as const;
  const create = (hostname: string) =>
    domainHandlers["domains.create"]!({ body: { hostname, appId: "11111111-1111-4111-8111-111111111111" }, actor, ctx, req: {} as never, reply: {} as never, query: undefined as never, params: undefined as never });

  it("refuses them before touching the database", async () => {
    for (const h of ["metadata.google.internal", "printer.local", "app.localhost", "x.test", "nas.lan"]) {
      await expect(create(h), h).rejects.toMatchObject({ status: 400, code: "HOSTNAME_NOT_PUBLIC", extra: { field: "hostname" } });
    }
  });

  it("lets a public name through to the app lookup", async () => {
    // The guard database throws on the first query, so reaching it means the name passed.
    await expect(create("shop.example.com")).rejects.toThrow(/db touched/);
  });
});

describe("an app hosted on Vercel", () => {
  const APP = "11111111-1111-4111-8111-111111111111";
  const actor = { kind: "session", userId: "u", name: "Owner", role: "admin", sessionId: "s", elevated: true } as const;
  const noWrite = () => {
    throw new Error("wrote a row");
  };
  const db = {
    instance: { findUnique: async () => null },
    previewDeployment: { findUnique: async () => null },
    app: { findUnique: async () => ({ id: APP, name: "web", kind: "frontend", deployTarget: "vercel", environment: { projectId: "p" } }) },
    domain: { findFirst: async () => null, count: async () => 0, create: noWrite },
    $transaction: noWrite,
  };
  const ctx = { config: { publicUrl, ingress: "direct_tls", reservedHosts: [], serverIpv4: "203.0.113.7", tunnelTarget: null }, db } as unknown as Ctx;
  const call = (id: "domains.create" | "domains.test.create", body: Record<string, unknown>) =>
    domainHandlers[id]!({ body, actor, ctx, req: {} as never, reply: {} as never, query: undefined as never, params: undefined as never } as never);

  it("takes no domain and no test domain, so no route and no certificate request", async () => {
    await expect(call("domains.create", { hostname: "shop.example.com", appId: APP })).rejects.toMatchObject({ status: 400, code: "NOT_ON_SERVER" });
    await expect(call("domains.test.create", { appId: APP })).rejects.toMatchObject({ status: 400, code: "NOT_ON_SERVER" });
  });
});

describe("edge jobs", () => {
  it("tunnel mode asks for the route, the Cloudflare wiring and a DNS check", () => {
    expect(jobsForCreate({ id: "d", appId: "a" }, "cloudflare_tunnel").map((j) => j.kind)).toEqual(["edge_route_sync", "edge_cf_wire", "dns_check"]);
    expect(jobsForCreate({ id: "d", appId: "a" }, "direct_tls").map((j) => j.kind)).toEqual(["edge_route_sync", "dns_check"]);
  });
  it("checks DNS at once in direct mode, and after the wiring in tunnel mode: the route waits for it", () => {
    const dns = (ingress: "cloudflare_tunnel" | "direct_tls") => jobsForCreate({ id: "d", appId: "a" }, ingress).find((j) => j.kind === "dns_check");
    expect(dns("direct_tls")).toMatchObject({ runAfterMs: 0 });
    expect(dns("cloudflare_tunnel")).toMatchObject({ runAfterMs: 30_000 });
  });
  it("delete unwires Cloudflare only when the row recorded what Dockify made", () => {
    const base = { id: "d", appId: "a", hostname: "x.example.com" };
    expect(jobsForDelete({ ...base, cfZoneId: null, cfRecordId: null }).map((j) => j.kind)).toEqual(["edge_route_sync"]);
    const jobs = jobsForDelete({ ...base, cfZoneId: "z", cfRecordId: "r" });
    expect(jobs[1]).toMatchObject({ kind: "edge_cf_unwire", payload: { hostname: "x.example.com", zoneId: "z", recordId: "r" } });
  });
});

describe("row mapping", () => {
  it("matches the contract", () => {
    const row = toDomainRow({
      id: "11111111-1111-4111-8111-111111111111",
      appId: "a",
      hostname: "x.example.com",
      tlsStatus: "active",
      tlsIssuer: "Let's Encrypt",
      tlsExpiresAt: new Date("2027-01-01T00:00:00Z"), tlsWarnedFor: null,
      dnsStatus: "ok",
      dnsResolved: ["203.0.113.5"],
      dnsCheckedAt: new Date("2026-10-30T00:00:00Z"),
      cfZoneId: null,
      cfRecordId: null,
      cfTunnelId: null,
      cfState: "none",
      cfMessage: null,
      createdAt: new Date("2026-10-01T00:00:00Z"),
      dnsDetail: null,
      probeStatus: "passed",
      probeDetail: "Reached this server through the domain",
      probeCheckedAt: new Date("2026-10-30T00:00:00Z"),
      app: { id: "a", name: "web", environment: { name: "production", project: { slug: "shop" } } },
    });
    expect(endpoints["domains.create"].response.parse(row)).toEqual(row);
    expect(row.probe).toEqual({ status: "passed", detail: "Reached this server through the domain", checkedAt: "2026-10-30T00:00:00.000Z" });
  });

  it("explains a domain that does not point here, and says nothing once it does", () => {
    const base = {
      id: "11111111-1111-4111-8111-111111111111", appId: "a", hostname: "x.example.com", tlsStatus: "pending" as const, tlsIssuer: null, tlsExpiresAt: null, tlsWarnedFor: null,
      dnsResolved: ["198.51.100.7"], dnsCheckedAt: null, cfZoneId: null, cfRecordId: null, cfTunnelId: null, cfState: "none" as const, cfMessage: null,
      createdAt: new Date("2026-10-01T00:00:00Z"), probeStatus: "failed" as const, probeDetail: "No answer", probeCheckedAt: null,
      app: { id: "a", name: "web", environment: { name: "production", project: { slug: "shop" } } },
    };
    expect(toDomainRow({ ...base, dnsStatus: "mismatch", dnsDetail: "x.example.com points at 198.51.100.7" }).dns.detail).toBe("x.example.com points at 198.51.100.7");
    expect(toDomainRow({ ...base, dnsStatus: "ok", dnsDetail: "stale" }).dns.detail).toBeNull();
  });

  it("says when the app has no port, which DNS reading ok does not", () => {
    const base = {
      id: "11111111-1111-4111-8111-111111111111", appId: "a", hostname: "x.example.com", tlsStatus: "pending" as const, tlsIssuer: null, tlsExpiresAt: null, tlsWarnedFor: null,
      dnsStatus: "ok" as const, dnsDetail: null, dnsResolved: [], dnsCheckedAt: null, cfZoneId: null, cfRecordId: null, cfTunnelId: null, cfState: "none" as const, cfMessage: null,
      createdAt: new Date("2026-10-01T00:00:00Z"), probeStatus: "untried" as const, probeDetail: null, probeCheckedAt: null,
    };
    const app = { id: "a", name: "web", environment: { name: "production", project: { slug: "shop" } } };
    const none = toDomainRow({ ...base, app: { ...app, port: null } });
    expect(none.appPort).toBeNull();
    expect(endpoints["domains.create"].response.parse(none)).toEqual(none);
    expect(toDomainRow({ ...base, app: { ...app, port: 80 } }).appPort).toBe(80);
  });
});

describe("primary domain", () => {
  type Row = { id: string; appId: string; createdAt: Date };
  /** The rows and pointers the two handlers touch, in one fake transaction. */
  function world(primary: string | null, domains: Row[]) {
    const state = { primary, domains: [...domains] };
    let n = 0;
    const tx = {
      $executeRaw: async () => 0,
      job: { findFirst: async () => null, create: async () => ({ id: "j" }) },
      activityLog: { create: async () => ({}) },
      app: {
        updateMany: async ({ where, data }: { where: { primaryDomainId: null }; data: { primaryDomainId: string } }) => {
          if (where.primaryDomainId === null && state.primary === null) {
            state.primary = data.primaryDomainId;
            return { count: 1 };
          }
          return { count: 0 };
        },
      },
      domain: {
        create: async ({ data }: { data: { appId: string } }) => {
          const row = { id: `new-${++n}`, appId: data.appId, createdAt: new Date() };
          state.domains.push(row);
          return { id: row.id, appId: row.appId };
        },
        deleteMany: async ({ where }: { where: { id: string } }) => {
          const before = state.domains.length;
          state.domains = state.domains.filter((d) => d.id !== where.id);
          // The pointer is ON DELETE SET NULL.
          if (state.primary === where.id) state.primary = null;
          return { count: before - state.domains.length };
        },
        findFirst: async () => [...state.domains].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null,
      },
    };
    return { state, tx };
  }
  const APP = "11111111-1111-4111-8111-111111111111";
  const actor = { kind: "session", userId: "u", name: "Owner", role: "admin", sessionId: "s", elevated: true } as const;
  const req = { clientIp: "203.0.113.9", headers: {} } as never;
  const ctxFor = (tx: object) => ({
    config: { publicUrl, ingress: "direct_tls", reservedHosts: [], serverIpv4: null, tunnelTarget: null },
    db: {
      previewDeployment: { findUnique: async () => null },
      instance: { findUnique: async () => null },
      app: { findUnique: async () => ({ id: APP, name: "web", kind: "frontend", environment: { projectId: "p" } }) },
      domain: {
        findFirst: async ({ where }: { where: { id: string } }) => ({
          id: where.id, appId: APP, hostname: "x.example.com", tlsStatus: "pending", tlsIssuer: null, tlsExpiresAt: null, dnsStatus: "unchecked", dnsResolved: [],
          dnsCheckedAt: null, dnsDetail: null, probeStatus: "untried", probeDetail: null, probeCheckedAt: null, cfZoneId: null, cfRecordId: null, cfTunnelId: null,
          cfState: "none", cfMessage: null, createdAt: new Date(), app: { id: APP, name: "web", environment: { name: "production", project: { slug: "shop", id: "p" } } },
        }),
      },
      $transaction: async (fn: (t: object) => Promise<unknown>) => fn(tx),
    },
  }) as unknown as Ctx;

  it("is set on an app's first domain and left alone after that", async () => {
    const w = world(null, []);
    await domainHandlers["domains.create"]!({ body: { hostname: "first.example.com", appId: APP }, actor, ctx: ctxFor(w.tx), req, reply: {} as never, query: undefined as never, params: undefined as never });
    expect(w.state.primary).toBe("new-1");
    await domainHandlers["domains.create"]!({ body: { hostname: "second.example.com", appId: APP }, actor, ctx: ctxFor(w.tx), req, reply: {} as never, query: undefined as never, params: undefined as never });
    expect(w.state.primary).toBe("new-1");
  });

  it("an app with older domains and no primary gets its oldest, never the name just added", async () => {
    const old = { id: "d-old", appId: APP, createdAt: new Date("2026-01-01T00:00:00Z") };
    const w = world(null, [old]);
    await domainHandlers["domains.create"]!({ body: { hostname: "third.example.com", appId: APP }, actor, ctx: ctxFor(w.tx), req, reply: {} as never, query: undefined as never, params: undefined as never });
    expect(w.state.primary).toBe("d-old");
  });

  it("moves to the oldest remaining domain when the primary is removed, and only then", async () => {
    const old = { id: "d-old", appId: APP, createdAt: new Date("2026-01-01T00:00:00Z") };
    const mid = { id: "d-mid", appId: APP, createdAt: new Date("2026-02-01T00:00:00Z") };
    const w = world("d-mid", [old, mid]);
    await domainHandlers["domains.delete"]!({ params: { id: "d-old" }, actor, ctx: ctxFor(w.tx), req, reply: {} as never, query: undefined as never, body: undefined as never });
    expect(w.state.primary).toBe("d-mid");
    const v = world("d-mid", [old, mid]);
    await domainHandlers["domains.delete"]!({ params: { id: "d-mid" }, actor, ctx: ctxFor(v.tx), req, reply: {} as never, query: undefined as never, body: undefined as never });
    expect(v.state.primary).toBe("d-old");
    const last = world("d-old", [old]);
    await domainHandlers["domains.delete"]!({ params: { id: "d-old" }, actor, ctx: ctxFor(last.tx), req, reply: {} as never, query: undefined as never, body: undefined as never });
    expect(last.state.primary).toBeNull();
  });
});

describe("the ownership probe's answer", () => {
  const SECRET = "test-internal-token";
  const D1 = { id: "11111111-1111-4111-8111-111111111111", hostname: "shop.example.com" };
  async function server() {
    const before = process.env.DOCKIFY_INTERNAL_TOKEN;
    process.env.DOCKIFY_INTERNAL_TOKEN = SECRET;
    const app = Fastify();
    const ctx = { ring: {} as never, db: { domain: { findUnique: async ({ where }: { where: { hostname: string } }) => (where.hostname === D1.hostname ? D1 : null) }, instance: { findUnique: async () => null } } } as unknown as Ctx;
    // The route reads the shared secret once, when it is registered.
    registerDomainCheckRoute(app, ctx);
    if (before === undefined) delete process.env.DOCKIFY_INTERNAL_TOKEN;
    else process.env.DOCKIFY_INTERNAL_TOKEN = before;
    await app.ready();
    return app;
  }
  const get = (app: Awaited<ReturnType<typeof server>>, token: string, host: string) => app.inject({ method: "GET", url: `/.well-known/dockify-check/${token}`, headers: { host } });

  it("answers a domain's own token on its own host with a value only this server can give", async () => {
    const app = await server();
    const token = domainCheckToken(SECRET, D1.id, D1.hostname);
    for (const host of ["shop.example.com", "Shop.Example.com.", "shop.example.com:443"]) {
      const r = await get(app, token, host);
      expect(r.statusCode, host).toBe(200);
      expect(r.body).toBe(domainCheckAnswer(SECRET, D1.hostname, token));
      // Not an echo of the path: a server that only repeated the token would not pass.
      expect(r.body).not.toBe(token);
    }
    await app.close();
  });

  it("gives the same empty 404 for anything else, so it reveals nothing", async () => {
    const app = await server();
    const token = domainCheckToken(SECRET, D1.id, D1.hostname);
    const misses = [
      [domainCheckToken(SECRET, D1.id, "other.example.com"), "shop.example.com"],
      [token, "other.example.com"],
      [token.toUpperCase(), "shop.example.com"],
      ["x".repeat(64), "shop.example.com"],
      [token, "10.0.0.1"],
      [domainCheckToken("another-secret", D1.id, D1.hostname), "shop.example.com"],
    ] as const;
    for (const [t, h] of misses) {
      const r = await get(app, t, h);
      expect(r.statusCode, `${h} ${t.slice(0, 8)}`).toBe(404);
      expect(r.body).toBe("");
    }
    await app.close();
  });

  it("parses only a plain host name from the Host header", () => {
    expect(hostOf("shop.example.com:8443")).toBe("shop.example.com");
    expect(hostOf("[::1]:443")).toBeNull();
    expect(hostOf("a b.example.com")).toBeNull();
    expect(hostOf(undefined)).toBeNull();
  });
});

describe("plugin", () => {
  it("registers every domain route with its contract path and policy", async () => {
    const { app, routes } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), logger: false });
    await app.ready();
    const seen = (id: EndpointId) => routes.find((r) => r.url === endpoints[id].path && r.method === endpoints[id].method)?.policy;
    for (const id of Object.keys(domainHandlers) as EndpointId[]) expect(seen(id), id).toBe(describePolicy(POLICIES[id]));
    expect(seen("domains.delete")).toMatch(/^elevated/);
    await app.close();
  });
});
