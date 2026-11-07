import { describe, expect, it } from "vitest";
import { resources } from "@dockify/contracts";
import type { Ctx } from "../../app.ts";
import { describePolicy, POLICIES } from "../../policy.ts";
import { domainHandlers } from "./handlers.ts";

const IP = "203.0.113.10";
const SUFFIX = "203-0-113-10.sslip.io";
const APP = "11111111-1111-4111-8111-111111111111";
const actor = { kind: "session", userId: "u", name: "Ana", role: "admin", sessionId: "s", elevated: false } as const;
const req = { clientIp: "203.0.113.1", headers: {} } as never;

function world(o: { kind?: string; existing?: Array<{ appId: string; testDomain: boolean; hostname: string }>; taken?: number } = {}) {
  const domains = [...(o.existing ?? [])] as Array<{ id: string; appId: string; hostname: string; testDomain: boolean }>;
  const jobs: Array<{ kind: string }> = [];
  const audits: Array<{ action: string }> = [];
  let collisions = o.taken ?? 0;
  const tx = {
    $executeRaw: async () => 0,
    domain: {
      create: async ({ data }: { data: { appId: string; hostname: string; testDomain?: boolean } }) => {
        if (collisions-- > 0) throw Object.assign(new Error("dup"), { code: "P2002" });
        const row = { id: `d${domains.length + 1}`, appId: data.appId, hostname: data.hostname, testDomain: data.testDomain === true };
        domains.push(row);
        return { id: row.id, appId: row.appId };
      },
      findFirst: async ({ where }: { where: { id?: string; appId?: string; testDomain?: boolean } }) => {
        const d = domains.find((x) => (where.id === undefined || x.id === where.id) && (where.appId === undefined || x.appId === where.appId) && (where.testDomain === undefined || x.testDomain === where.testDomain));
        return d ? rowOf(d) : null;
      },
      count: async () => domains.filter((d) => d.testDomain).length,
    },
    app: {
      findUnique: async () => ({ id: APP, name: "web", kind: o.kind ?? "frontend", serverId: "s1", environment: { projectId: "p" } }),
      findUniqueOrThrow: async () => ({ serverId: "s1" }),
      updateMany: async () => ({ count: 1 }),
    },
    job: { findFirst: async () => null, create: async ({ data }: { data: { kind: string } }) => void jobs.push(data) },
    activityLog: { create: async ({ data }: { data: { action: string } }) => void audits.push(data) },
    instance: { findUnique: async () => ({ dashboardDomain: null, dashboardPreviousHosts: [] }) },
    previewDeployment: { findUnique: async () => null },
  };
  const rowOf = (d: (typeof domains)[number]) => ({
    ...d, tlsStatus: "pending", tlsIssuer: null, tlsExpiresAt: null, dnsStatus: "unchecked", dnsResolved: [], dnsCheckedAt: null, dnsDetail: null, probeStatus: "untried", probeDetail: null, probeCheckedAt: null,
    cfState: "none", cfMessage: null, createdAt: new Date(), app: { id: APP, name: "web", serverId: "s1", environment: { name: "production", project: { slug: "shop", id: "p" } } },
  });
  const db = { ...tx, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return { db, domains, jobs, audits };
}

const ctxOf = (db: unknown, over: object = {}) => ({ db, config: { publicUrl: new URL("https://dash.example.com"), ingress: "direct_tls", reservedHosts: [], serverIpv4: IP, tunnelTarget: null, ...over } }) as unknown as Ctx;
const create = (ctx: Ctx) => domainHandlers["domains.test.create"]!({ body: { appId: APP }, actor, req, ctx, reply: {} as never, query: undefined as never, params: undefined as never });
const typed = (ctx: Ctx, hostname: string) => domainHandlers["domains.create"]!({ body: { hostname, appId: APP }, actor, req, ctx, reply: {} as never, query: undefined as never, params: undefined as never });

describe("a free test domain", () => {
  it("is generated here, marked, and goes down the normal route and DNS path", async () => {
    const w = world();
    const row = await create(ctxOf(w.db));
    expect(row!.hostname).toMatch(new RegExp(`^web-[0-9a-f]{6}\\.${SUFFIX.replace(/\./g, "\\.")}$`));
    expect(row!.test).toBe(true);
    expect(resources.DomainRow.safeParse(row).success).toBe(true);
    expect(w.jobs.map((j) => j.kind)).toEqual(["edge_route_sync", "dns_check"]);
    expect(w.audits[0]).toMatchObject({ action: "domain.test.create" });
  });
  it("tries another name on a collision: the unique index keeps names unique", async () => {
    const w = world({ taken: 1 });
    expect((await create(ctxOf(w.db)))!.test).toBe(true);
    expect(w.domains).toHaveLength(1);
  });
  it("gives up with a plain word after three collisions", async () => {
    await expect(create(ctxOf(world({ taken: 5 }).db))).rejects.toMatchObject({ code: "DOMAIN_TAKEN" });
  });
  it("is one per app, and bounded per server: each is a certificate", async () => {
    await expect(create(ctxOf(world({ existing: [{ appId: APP, testDomain: true, hostname: `web-aaaaaa.${SUFFIX}` }] }).db))).rejects.toMatchObject({ code: "TEST_DOMAIN_EXISTS" });
    const many = Array.from({ length: 20 }, (_, i) => ({ appId: `other-${i}`, testDomain: true, hostname: `x${i}.${SUFFIX}` }));
    await expect(create(ctxOf(world({ existing: many }).db))).rejects.toMatchObject({ code: "TEST_DOMAIN_LIMIT" });
  });
  it("is refused in a tunnel, and with no public address", async () => {
    await expect(create(ctxOf(world().db, { ingress: "cloudflare_tunnel" }))).rejects.toMatchObject({ code: "TEST_DOMAIN_UNAVAILABLE" });
    await expect(create(ctxOf(world().db, { serverIpv4: "10.0.0.5" }))).rejects.toMatchObject({ code: "TEST_DOMAIN_UNAVAILABLE" });
    await expect(create(ctxOf(world().db, { serverIpv4: null }))).rejects.toMatchObject({ code: "TEST_DOMAIN_UNAVAILABLE" });
  });
  it("is only for apps that serve HTTP", async () => {
    await expect(create(ctxOf(world({ kind: "postgres" }).db))).rejects.toMatchObject({ code: "NOT_ROUTABLE" });
  });
  it("the offer says the same, for an Admin", async () => {
    expect(await domainHandlers["domains.test.offer"]!({ actor, ctx: ctxOf(world().db) } as never)).toEqual({ available: true, reason: null, suffix: SUFFIX });
    expect(await domainHandlers["domains.test.offer"]!({ actor, ctx: ctxOf(world().db, { ingress: "cloudflare_tunnel" }) } as never)).toMatchObject({ available: false, suffix: null });
    expect(describePolicy(POLICIES["domains.test.create"])).toBe("session:admin+token:admin");
  });
});

describe("a typed name that spells an address", () => {
  it("is refused when the address is not this server's, before anything is written", async () => {
    for (const h of ["x.1-2-3-4.sslip.io", "1-2-3-4.sslip.io", "x.1.2.3.4.nip.io", `1-2-3-4.${SUFFIX}`]) {
      await expect(typed(ctxOf(new Proxy({}, { get: () => { throw new Error("db touched"); } })), h), h).rejects.toMatchObject({ status: 400, code: "HOSTNAME_FOREIGN_ADDRESS" });
    }
  });
  it("this server's own goes through the ordinary path, unmarked: it is no test domain", async () => {
    const w = world();
    const row = await typed(ctxOf(w.db), `mine.${SUFFIX}`);
    expect(row!.test).toBe(false);
  });
});
