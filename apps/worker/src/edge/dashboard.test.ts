import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dashboardDomain as D, SSLIP_DOWN_MESSAGE } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import { syncDashboardTunnel, unwireDomain, type CfClient, type CfIngress } from "./cloudflare.ts";
import { checkDomain } from "./jobs.ts";
import { checkDashboardDomain, dashboardReservedHosts, queueDashboardCheck, syncDashboardEdge, type DashboardDeps } from "./dashboard.ts";
import { reservedHosts } from "./hostnames.ts";
import type { EdgeSettings } from "./ingress.ts";
import { API_UPSTREAM, TUNNEL_SERVICE, WEB_UPSTREAM } from "./ingress.ts";
import { fileRouteStore } from "@dockify/engine";
import { DASHBOARD_NEXT_FILE, DASHBOARD_OLD_FILE, renderDashboardNext, renderDashboardOld } from "./routes.ts";

const direct = { ingress: "direct_tls", certResolver: "le" } as const;
const tunnel = { ingress: "cloudflare_tunnel" } as const;
const HOST = "dash.new.example.com";
const TUNNEL_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-06T12:00:00Z");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dash-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Row {
  dashboardDomain: unknown;
  dashboardPreviousHosts: string[];
  dashboardLastChange: unknown;
}

function fakeDb(row: Row, cloudflare = false) {
  const jobs: Array<{ kind: string; lane: string; payload: unknown; dedupeKey: string }> = [];
  const tx = {
    $executeRaw: async () => 0,
    instance: {
      findUnique: async () => row,
      update: async ({ data }: { data: Partial<Row> }) => void Object.assign(row, data),
    },
    job: {
      findFirst: async ({ where }: { where: { dedupeKey: string } }) => jobs.find((j) => j.dedupeKey === where.dedupeKey) ?? null,
      create: async ({ data }: { data: (typeof jobs)[number] }) => {
        jobs.push(data);
        return { id: `j${jobs.length}` };
      },
    },
    integration: {
      findFirst: async () => (cloudflare ? { secretId: "s", config: { accountId: "acct", tunnelId: TUNNEL_ID, managedZoneIds: [] } } : null),
    },
  };
  const db = { ...tx, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as Db;
  return { db, jobs };
}

const settings = (mode: EdgeSettings["mode"]): EdgeSettings => ({ mode, dashboardHost: "1-2-3-4.sslip.io", serverIpv4: "203.0.113.7", serverIpv6: null, acmeEmail: "ops@example.com", acmeCaServer: null });
const cert = (o: { valid: boolean }) => ({
  cert: (o.valid
    ? { issuer: { O: "Let's Encrypt" }, subject: { CN: HOST }, subjectaltname: `DNS:${HOST}`, valid_to: "Jan 1 00:00:00 2030 GMT" }
    : { issuer: { CN: "TRAEFIK DEFAULT CERT" }, subject: { CN: "TRAEFIK DEFAULT CERT" }, subjectaltname: "DNS:abc.traefik.default", valid_to: "Jan 1 00:00:00 2030 GMT" }) as never,
  authorized: o.valid,
  authorizationError: null,
});

function deps(db: Db, over: Partial<DashboardDeps> & { addresses?: string[]; valid?: boolean } = {}): DashboardDeps {
  const { addresses = ["203.0.113.7"], valid = true, ...rest } = over;
  return {
    db,
    vault: { open: async () => "token" } as never,
    settings: settings(direct),
    routes: fileRouteStore(dir),
    mode: rest.settings?.mode ?? direct,
    dns: {
      resolve4: async (h) => (h === HOST ? addresses : ["203.0.113.7"]),
      resolveCname: async () => [],
    },
    tls: async () => cert({ valid }),
    tunnelLock: (fn) => fn(),
    now: () => NOW,
    ...rest,
  };
}

const row = (over: Partial<D.PendingDomain> = {}): Row => ({
  dashboardDomain: { ...D.freshPendingDomain(HOST, "Ana", new Date(NOW.getTime() - 60_000)), ...over },
  dashboardPreviousHosts: [],
  dashboardLastChange: null,
});
const pendingOf = (r: Row) => D.readPendingDomain(r.dashboardDomain)!;
const confFiles = () => readdir(join(dir, "conf")).catch(() => [] as string[]);

describe("a free test domain, at its DNS check", () => {
  const SERVER = "203.0.113.7";
  const NAME = "web-a1b2c3.203-0-113-7.sslip.io";
  function world(over: { hostname?: string; dnsStatus?: string; testDomain?: boolean } = {}) {
    const row = { id: "d1", hostname: NAME, appId: "a1", dnsStatus: "unchecked", probeStatus: "untried", testDomain: true, ...over };
    const updates: Array<Record<string, unknown>> = [];
    const tx = { $executeRaw: async () => 0, job: { findFirst: async () => null, create: async () => ({ id: "j" }) } };
    const db = {
      ...tx,
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      domain: {
        findUnique: async () => row,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          Object.assign(row, data);
        },
      },
    } as unknown as Db;
    return { db, updates, row };
  }
  const deps = (db: Db, resolve4: (h: string) => Promise<string[]>, probe?: () => Promise<never>) => ({
    db,
    settings: settings(direct),
    dns: { resolve4, resolveCname: async () => [] },
    tls: async () => cert({ valid: true }),
    now: () => NOW,
    ...(probe ? { probe } : {}),
  });

  it("passes through the ordinary DNS check when sslip.io answers with this server", async () => {
    const w = world();
    await checkDomain(deps(w.db, async () => [SERVER]), "d1");
    expect(w.row.dnsStatus).toBe("ok");
  });
  it("says plainly that sslip.io may be down when it gives no answer", async () => {
    const w = world();
    await checkDomain(deps(w.db, async () => { throw Object.assign(new Error("nf"), { code: "ENOTFOUND" }); }), "d1");
    expect(w.row.dnsStatus).toBe("missing");
    expect(w.updates.at(-1)?.dnsDetail).toBe(SSLIP_DOWN_MESSAGE);
  });
  it("says the same when the resolvers fail, and a live one keeps its route", async () => {
    const down = async () => { throw Object.assign(new Error("t"), { code: "ETIMEOUT" }); };
    const waiting = world({ dnsStatus: "missing" });
    await checkDomain(deps(waiting.db, down), "d1");
    expect(waiting.updates.at(-1)?.dnsDetail).toBe(SSLIP_DOWN_MESSAGE);
    const live = world({ dnsStatus: "ok" });
    await checkDomain(deps(live.db, down), "d1");
    expect(live.row.dnsStatus).toBe("ok");
    expect(live.updates.at(-1)?.dnsDetail).toBeUndefined();
  });
  it("never passes when it spells another address, whatever the records say: the server moved", async () => {
    const w = world({ hostname: "web-a1b2c3.198-51-100-9.sslip.io", dnsStatus: "ok" });
    await checkDomain(deps(w.db, async () => [SERVER]), "d1");
    expect(w.row.dnsStatus).toBe("mismatch");
    expect(String(w.updates.at(-1)?.dnsDetail)).toContain("198.51.100.9");
  });
  it("asks no proxy: its records are sslip.io's answer", async () => {
    const w = world();
    await checkDomain(deps(w.db, async (h) => (h === NAME ? ["198.51.100.9"] : [SERVER]), async () => { throw new Error("probed"); }), "d1");
    expect(w.row.dnsStatus).toBe("mismatch");
    expect(w.row.probeStatus).toBe("untried");
  });
  it("an ordinary domain's wording is untouched", async () => {
    const w = world({ hostname: "app.example.com", testDomain: false });
    await checkDomain(deps(w.db, async () => { throw Object.assign(new Error("nf"), { code: "ENOTFOUND" }); }), "d1");
    expect(String(w.updates.at(-1)?.dnsDetail)).toContain("No A or AAAA record");
  });
});

describe("the new domain's route", () => {
  it("in direct mode asks for the certificate, and serves only the check path", () => {
    const f = JSON.parse(renderDashboardNext(HOST, direct));
    const r = f.http.routers["dashboard-next"];
    expect(r.rule).toBe("Host(`dash.new.example.com`) && PathPrefix(`/.well-known/dockify-check/`)");
    expect(r.tls.certResolver).toBe("le");
    expect(r.entryPoints).toEqual(["websecure"]);
    expect(Object.keys(f.http.routers)).toEqual(["dashboard-next"]);
  });
  it("in a tunnel names no resolver: Cloudflare holds that certificate", () => {
    const r = JSON.parse(renderDashboardNext(HOST, tunnel)).http.routers["dashboard-next"];
    expect(r.tls).toBeUndefined();
    expect(r.entryPoints).toEqual(["web"]);
  });
  it("refuses anything that is not a plain hostname", () => {
    expect(() => renderDashboardNext("a`) || Host(`b.example.com", direct)).toThrow();
  });
});

describe("the addresses the dashboard left", () => {
  it("in direct mode serve the api path and redirect the rest, path and query kept, temporarily", () => {
    const f = JSON.parse(renderDashboardOld(["old.example.com", "older.example.com"], HOST, direct)!);
    expect(f.http.routers["dashboard-old-api"].rule).toContain("PathPrefix(`/api/v1/`)");
    expect(f.http.routers["dashboard-old-api"].middlewares).toEqual(["dockify-client-ip@file"]);
    expect(f.http.routers["dashboard-old-api"].priority).toBeGreaterThan(f.http.routers["dashboard-old"].priority);
    expect(f.http.routers["dashboard-old"].rule).toBe("Host(`old.example.com`) || Host(`older.example.com`)");
    expect(f.http.routers["dashboard-old"].tls.certResolver).toBe("le");
    const m = f.http.middlewares["dashboard-old-redirect"].redirectRegex;
    expect(m.replacement).toBe(`https://${HOST}$1`);
    expect(m.permanent).toBe(false);
    expect(new RegExp(m.regex).exec("https://old.example.com/a/b?c=1")?.[1]).toBe("/a/b?c=1");
    expect(f.http.services["dashboard-old-api"].loadBalancer.servers[0].url).toBe(API_UPSTREAM);
  });
  it("in a tunnel have only the redirect: cloudflared sends their api path to the api itself", () => {
    const f = JSON.parse(renderDashboardOld(["old.example.com"], HOST, tunnel)!);
    expect(Object.keys(f.http.routers)).toEqual(["dashboard-old"]);
    expect(f.http.routers["dashboard-old"].entryPoints).toEqual(["web"]);
  });
  it("write nothing with no address left, and never redirect the current address to itself", () => {
    expect(renderDashboardOld([], HOST, direct)).toBeNull();
    expect(renderDashboardOld([HOST], HOST, direct)).toBeNull();
  });
});

describe("checkDashboardDomain", () => {
  it("a name that leads here with its certificate is ready, and its certificate router is written", async () => {
    const r = row();
    await checkDashboardDomain(deps(fakeDb(r).db));
    const p = pendingOf(r);
    expect(p.phase).toBe("ready");
    expect(p.dns.status).toBe("ok");
    expect(p.tls.status).toBe("active");
    expect(await readFile(join(dir, "conf", DASHBOARD_NEXT_FILE), "utf8")).toContain("certResolver");
  });

  it("a name with no record waits, and no certificate is asked for", async () => {
    const r = row();
    await checkDashboardDomain(deps(fakeDb(r).db, { addresses: [] }));
    expect(pendingOf(r).phase).toBe("waiting");
    expect(pendingOf(r).dns.status).toBe("missing");
    expect(await confFiles()).not.toContain(DASHBOARD_NEXT_FILE);
  });

  it("a name that leads here but has only the default certificate keeps waiting", async () => {
    const r = row();
    await checkDashboardDomain(deps(fakeDb(r).db, { valid: false }));
    expect(pendingOf(r).phase).toBe("waiting");
    expect(pendingOf(r).tls.status).toBe("pending");
  });

  it("a name behind Cloudflare's proxy passes by asking the domain, with the same token path", async () => {
    const r = row();
    const asked: string[] = [];
    await checkDashboardDomain(deps(fakeDb(r).db, {
      addresses: ["104.21.48.12"],
      probe: async (h, id) => {
        asked.push(`${h} ${id}`);
        return { status: "passed", detail: "Asking reached this server." };
      },
    }));
    expect(asked).toEqual([`${HOST} ${D.DASHBOARD_CHECK_ID}`]);
    expect(pendingOf(r).phase).toBe("ready");
    expect(pendingOf(r).probe.status).toBe("passed");
  });

  it("a proxied name that does not answer waits, with both reasons kept", async () => {
    const r = row();
    await checkDashboardDomain(deps(fakeDb(r).db, {
      addresses: ["104.21.48.12"],
      probe: async () => ({ status: "failed", detail: "it redirects in a loop. Behind Cloudflare, set SSL/TLS to Full." }),
    }));
    const p = pendingOf(r);
    expect(p.phase).toBe("waiting");
    expect(p.dns.status).toBe("mismatch");
    expect(p.probe.detail).toContain("loop");
    expect(await confFiles()).not.toContain(DASHBOARD_NEXT_FILE);
  });

  it("a resolver failure keeps the verdict: a live check is not thrown away for a hiccup", async () => {
    const r = row({ phase: "ready", dns: { status: "ok", resolved: ["203.0.113.7"], detail: null, checkedAt: null }, tls: { status: "active", issuer: "x", expiresAt: null, detail: null } });
    const err = Object.assign(new Error("boom"), { code: "ETIMEOUT" });
    await checkDashboardDomain(deps(fakeDb(r).db, { dns: { resolve4: async () => { throw err; }, resolveCname: async () => [] } }));
    expect(pendingOf(r).phase).toBe("ready");
    expect(pendingOf(r).dns.status).toBe("ok");
  });

  it("a press of Switch checks once more, then gives the updater its job", async () => {
    const r = row({ phase: "ready" });
    const f = fakeDb(r);
    await checkDashboardDomain(deps(f.db), true);
    expect(pendingOf(r).phase).toBe("switching");
    expect(f.jobs).toEqual([expect.objectContaining({ kind: "dashboard_domain_apply", lane: "update", payload: { host: HOST, from: "1-2-3-4.sslip.io" } })]);
  });

  it("a press of Switch on a domain that stopped answering stays put and says why: nobody is locked out", async () => {
    const r = row({ phase: "ready" });
    const f = fakeDb(r);
    await checkDashboardDomain(deps(f.db, { addresses: ["198.51.100.9"] }), true);
    expect(pendingOf(r).phase).toBe("waiting");
    expect(pendingOf(r).error).toContain("stopped answering");
    expect(f.jobs).toEqual([]);
  });

  it("a cancel while the check ran wins: the row is not brought back", async () => {
    const r = row();
    const f = fakeDb(r);
    const d = deps(f.db, { tls: async () => { r.dashboardDomain = null; return cert({ valid: true }); } });
    await checkDashboardDomain(d);
    expect(r.dashboardDomain).toBeNull();
  });

  it("in a tunnel the probe's route goes in first, and the rules before the switch", async () => {
    const r = row({ phase: "ready" });
    const puts: CfIngress[][] = [];
    const fetchCf: DashboardDeps["fetch"] = async (url, init) => {
      if (init.method === "PUT") puts.push((JSON.parse(init.body!) as { config: { ingress: CfIngress[] } }).config.ingress);
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, result: { config: { ingress: [{ hostname: "1-2-3-4.sslip.io", service: WEB_UPSTREAM }, { service: TUNNEL_SERVICE }] } } }) };
    };
    const f = fakeDb(r, true);
    let probed = false;
    await checkDashboardDomain(deps(f.db, {
      settings: settings(tunnel),
      addresses: ["104.21.48.12"],
      fetch: fetchCf,
      vault: { open: async () => "token" } as never,
      probe: async () => {
        probed = (await confFiles()).includes(DASHBOARD_NEXT_FILE);
        return { status: "passed", detail: "ok" };
      },
    }), true).catch(() => undefined);
    expect(probed).toBe(true);
  });
});

describe("reserved hosts and the waiting check", () => {
  it("a tenant can claim neither a domain being set up nor an address the dashboard left", async () => {
    const r = { ...row(), dashboardPreviousHosts: ["old.example.com"] };
    expect(await dashboardReservedHosts(fakeDb(r).db)).toEqual(["old.example.com", HOST]);
  });
  it("a database that does not answer never takes an app's route away", async () => {
    const db = new Proxy({}, { get: () => { throw new Error("down"); } }) as unknown as Db;
    expect(await dashboardReservedHosts(db)).toEqual([]);
  });
  it("rechecks on the backoff, and leaves a two-day-old domain to the owner", async () => {
    const fresh = row();
    const f = fakeDb(fresh);
    expect(await queueDashboardCheck(f.db, NOW.getTime())).toBe(true);
    expect(f.jobs[0]).toMatchObject({ kind: "dashboard_domain", lane: "maintenance" });
    const recent = row({ dns: { status: "missing", resolved: [], detail: null, checkedAt: NOW.toISOString() } });
    expect(await queueDashboardCheck(fakeDb(recent).db, NOW.getTime() + 1000)).toBe(false);
    const old = row({ requestedAt: new Date(NOW.getTime() - 3 * 86_400_000).toISOString() });
    expect(await queueDashboardCheck(fakeDb(old).db, NOW.getTime())).toBe(false);
    const switching = row({ phase: "switching" });
    expect(await queueDashboardCheck(fakeDb(switching).db, NOW.getTime())).toBe(false);
  });
  it("syncs the route files from the row, and removes them when nothing is left", async () => {
    const r = { ...row(), dashboardDomain: null, dashboardPreviousHosts: ["old.example.com"] };
    await syncDashboardEdge(deps(fakeDb(r).db));
    expect(await confFiles()).toEqual([DASHBOARD_OLD_FILE]);
    r.dashboardPreviousHosts = [];
    await syncDashboardEdge(deps(fakeDb(r).db));
    expect(await confFiles()).toEqual([]);
  });
});

describe("syncDashboardTunnel", () => {
  function cf(ingress: CfIngress[]) {
    const puts: CfIngress[][] = [];
    const client: CfClient = {
      async call<T>(_p: string, req: { method?: string; body?: unknown } = {}): Promise<T> {
        if (req.method === "PUT") {
          const next = (req.body as { config: { ingress: CfIngress[] } }).config.ingress;
          puts.push(next);
          return {} as T;
        }
        return { config: { ingress, warp: true } } as T;
      },
    };
    return { client, puts };
  }
  const base = { accountId: "acct", tunnelId: TUNNEL_ID, withTunnelLock: <T,>(fn: () => Promise<T>) => fn() };
  const OLD = "old.example.com";
  const before: CfIngress[] = [
    { hostname: OLD, path: "^/api/v1/", service: API_UPSTREAM },
    { hostname: OLD, service: WEB_UPSTREAM },
    { hostname: "app.example.com", service: TUNNEL_SERVICE },
    { service: TUNNEL_SERVICE },
  ];

  it("adds the new host at the top, sends the old one to the redirect and keeps its api path", async () => {
    const { client, puts } = cf(before);
    expect(await syncDashboardTunnel({ ...base, cf: client, dashboardHost: HOST, previous: [OLD], addCurrent: true })).toBe("changed");
    expect(puts[0]).toEqual([
      { hostname: HOST, path: "^/api/v1/", service: API_UPSTREAM },
      { hostname: HOST, service: WEB_UPSTREAM },
      { hostname: OLD, path: "^/api/v1/", service: API_UPSTREAM },
      { hostname: OLD, service: TUNNEL_SERVICE },
      { hostname: "app.example.com", service: TUNNEL_SERVICE },
      { service: TUNNEL_SERVICE },
    ]);
  });

  it("writes nothing when the rules are right, and leaves other hosts and hand-made rules alone", async () => {
    const done: CfIngress[] = [
      { hostname: HOST, path: "^/api/v1/", service: API_UPSTREAM },
      { hostname: HOST, service: WEB_UPSTREAM },
      { hostname: OLD, service: "http://my-own-thing:8080" },
      { service: TUNNEL_SERVICE },
    ];
    const { client, puts } = cf(done);
    expect(await syncDashboardTunnel({ ...base, cf: client, dashboardHost: HOST, previous: [OLD], addCurrent: true })).toBe("unchanged");
    expect(puts).toEqual([]);
  });

  it("does not add the current host's rules unless a change of address asks: a hand-edited tunnel stays", async () => {
    const { client, puts } = cf([{ service: TUNNEL_SERVICE }]);
    expect(await syncDashboardTunnel({ ...base, cf: client, dashboardHost: HOST, previous: [], addCurrent: false })).toBe("unchanged");
    expect(puts).toEqual([]);
  });

  it("forgets an old address's rules, and only rules Dockify could have written", async () => {
    const { client, puts } = cf([...before.slice(0, 2), { hostname: OLD, path: "^/hand/", service: "http://mine:1" }, { service: TUNNEL_SERVICE }]);
    await syncDashboardTunnel({ ...base, cf: client, dashboardHost: HOST, previous: [], forget: [OLD], addCurrent: false });
    expect(puts[0]).toEqual([{ hostname: OLD, path: "^/hand/", service: "http://mine:1" }, { service: TUNNEL_SERVICE }]);
  });

  it("switching back serves the dashboard on the host again", async () => {
    const { client, puts } = cf([{ hostname: OLD, path: "^/api/v1/", service: API_UPSTREAM }, { hostname: OLD, service: TUNNEL_SERVICE }, { service: TUNNEL_SERVICE }]);
    await syncDashboardTunnel({ ...base, cf: client, dashboardHost: OLD, previous: [HOST], addCurrent: true });
    expect(puts[0]![1]).toEqual({ hostname: OLD, service: WEB_UPSTREAM });
  });
});

describe("unwireDomain in direct mode", () => {
  const ZONE = "a".repeat(32);
  const REC = "b".repeat(32);
  function cf(record: { type: string; name: string; content: string } | null) {
    const calls: string[] = [];
    const client: CfClient = {
      async call<T>(path: string, req: { method?: string } = {}): Promise<T> {
        calls.push(`${req.method ?? "GET"} ${path}`);
        if (!record) throw Object.assign(new Error("nf"), { status: 404, name: "CfError" });
        return { id: REC, ...record } as T;
      },
    };
    return { client, calls };
  }
  const base = { accountId: "acct", host: "app.example.com", zoneId: ZONE, recordId: REC, tunnelId: null, reserved: reservedHosts("dash.example.com"), withTunnelLock: <T,>(fn: () => Promise<T>) => fn(), serverAddresses: ["203.0.113.7"] };

  it("removes the A record Dockify made, still naming this server", async () => {
    const { client, calls } = cf({ type: "A", name: "app.example.com", content: "203.0.113.7" });
    const out = await unwireDomain({ ...base, cf: client });
    expect(out.ok).toBe(true);
    expect(out.record).toBe("deleted");
    expect(calls).toContain(`DELETE /zones/${ZONE}/dns_records/${REC}`);
  });
  it("leaves a record someone repointed since", async () => {
    const { client, calls } = cf({ type: "A", name: "app.example.com", content: "198.51.100.9" });
    const out = await unwireDomain({ ...base, cf: client });
    expect(out.record).toBe("changed");
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });
});
