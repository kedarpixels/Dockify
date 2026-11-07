/**
 * The dashboard's new name and resolvers' negative caches, found on the test box: the name was looked
 * up before Dockify made its Cloudflare record, the public resolver cached "no such name" for the
 * zone's negative TTL (30 minutes on Cloudflare), and every check read "No A or AAAA record" that long.
 *
 *   - a name waiting for Dockify to make its record is not looked up at all;
 *   - the check asks the zone's own nameservers first, which hold no cache, and only public ones.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dashboardDomain as D } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import { fileRouteStore } from "@dockify/engine";
import { checkDashboardDomain, queueDashboardCheck, RECORD_FIRST_HOLD_MS, type DashboardDeps } from "./dashboard.ts";
import { checkDnsFresh, zoneServers, type DnsLookup, type ZoneLookup } from "./dns.ts";

const HOST = "dockify-test-x.example.org";
const NOW = new Date("2026-11-07T12:00:00Z");
const SERVER = "203.0.113.7";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dash-dns-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const notFound = (code: string) => Object.assign(new Error(code), { code });

function fakeDb(row: { dashboardDomain: unknown; dashboardPreviousHosts: string[]; dashboardLastChange: unknown }) {
  const jobs: unknown[] = [];
  const tx = {
    $executeRaw: async () => 0,
    instance: { findUnique: async () => row, update: async ({ data }: { data: object }) => void Object.assign(row, data) },
    job: { findFirst: async () => null, create: async ({ data }: { data: unknown }) => (jobs.push(data), { id: "j" }) },
    integration: { findFirst: async () => null },
  };
  return { db: { ...tx, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as Db, jobs };
}

const pending = (over: Partial<D.PendingDomain> = {}) => ({
  dashboardDomain: { ...D.freshPendingDomain(HOST, "Ana", new Date(NOW.getTime() - 60_000)), ...over } as unknown,
  dashboardPreviousHosts: [] as string[],
  dashboardLastChange: null,
});

function deps(db: Db, lookups: string[], publicAnswer: string[], zoneAnswer: string[] | null): DashboardDeps {
  const lookup = (who: string, answer: string[]): DnsLookup => ({
    resolve4: async (h) => {
      lookups.push(`${who}:${h}`);
      if (h !== HOST) return [SERVER];
      if (!answer.length) throw notFound("ENOTFOUND");
      return answer;
    },
    resolveCname: async () => [],
  });
  return {
    db,
    vault: {} as never,
    settings: { mode: { ingress: "direct_tls", certResolver: "le" }, dashboardHost: "1-2-3-4.sslip.io", serverIpv4: SERVER, serverIpv6: null, acmeEmail: "a@example.com", acmeCaServer: null },
    routes: fileRouteStore(dir),
    mode: { ingress: "direct_tls", certResolver: "le" },
    dns: lookup("public", publicAnswer),
    zoneDns: async () => (zoneAnswer ? lookup("zone", zoneAnswer) : null),
    tls: async () => ({ cert: { issuer: { O: "Let's Encrypt" }, subject: { CN: HOST }, subjectaltname: `DNS:${HOST}`, valid_to: "Jan 1 00:00:00 2030 GMT" } as never, authorized: true, authorizationError: null }),
    tunnelLock: (fn) => fn(),
    now: () => NOW,
  };
}

describe("a name waiting for Dockify to make its Cloudflare record", () => {
  it("is not looked up, by a queued check or by the sweep", async () => {
    const r = pending({ recordFirst: true });
    const f = fakeDb(r);
    const lookups: string[] = [];
    await checkDashboardDomain(deps(f.db, lookups, [], []));
    expect(lookups.filter((l) => l.endsWith(HOST))).toEqual([]);
    expect(D.readPendingDomain(r.dashboardDomain)?.dns.checkedAt).toBeNull();
    expect(await queueDashboardCheck(f.db, NOW.getTime())).toBe(false);
  });

  it("is looked up once the record is made (the api clears the flag), or after the wait runs out", async () => {
    const lookups: string[] = [];
    const made = pending();
    await checkDashboardDomain(deps(fakeDb(made).db, lookups, [], [SERVER]));
    expect(D.readPendingDomain(made.dashboardDomain)?.phase).toBe("ready");
    const late = pending({ recordFirst: true, requestedAt: new Date(NOW.getTime() - RECORD_FIRST_HOLD_MS - 1000).toISOString() });
    const f = fakeDb(late);
    expect(await queueDashboardCheck(f.db, NOW.getTime())).toBe(true);
    await checkDashboardDomain(deps(f.db, lookups, [], [SERVER]));
    expect(D.readPendingDomain(late.dashboardDomain)?.dns.status).toBe("ok");
  });

  it("a press of Switch is never held", async () => {
    const r = pending({ recordFirst: true, phase: "switching" });
    const lookups: string[] = [];
    await checkDashboardDomain(deps(fakeDb(r).db, lookups, [], [SERVER]), true);
    expect(lookups).toContain(`zone:${HOST}`);
  });
});

describe("the check asks the zone's own nameservers first", () => {
  it("reads a new record at once, while the public resolver still says there is no such name", async () => {
    const r = pending();
    const lookups: string[] = [];
    await checkDashboardDomain(deps(fakeDb(r).db, lookups, [], [SERVER]));
    const p = D.readPendingDomain(r.dashboardDomain)!;
    expect(p.dns.status).toBe("ok");
    expect(p.phase).toBe("ready");
    expect(lookups).not.toContain(`public:${HOST}`);
  });

  it("falls back to the public resolvers when the zone's servers cannot be found", async () => {
    const at = async (zone: string[] | null) => {
      const lookups: string[] = [];
      const d = deps(fakeDb(pending()).db, lookups, [SERVER], zone);
      const r = await checkDnsFresh(d.dns, d.zoneDns, HOST, "direct_tls", SERVER);
      return { status: r.status, lookups };
    };
    expect(await at(null)).toMatchObject({ status: "ok", lookups: expect.arrayContaining([`public:${HOST}`]) });
    expect(await at(null)).toMatchObject({ status: "ok" });
  });

  it("when the zone says there is no such name, no public resolver is asked: none caches it as missing", async () => {
    const lookups: string[] = [];
    const d = deps(fakeDb(pending()).db, lookups, [], []);
    const r = await checkDnsFresh(d.dns, d.zoneDns, HOST, "direct_tls", SERVER);
    expect(r.status).toBe("missing");
    expect(lookups).toContain(`zone:${HOST}`);
    expect(lookups).not.toContain(`public:${HOST}`);
  });

  it("a name the zone has with no address of its own (a CNAME out of the zone, a delegated name) goes to the public resolvers", async () => {
    const lookups: string[] = [];
    const d = deps(fakeDb(pending()).db, lookups, [SERVER], []);
    const nodata: DnsLookup = { resolve4: async (h) => { lookups.push(`zone:${h}`); throw notFound("ENODATA"); }, resolveCname: async () => [] };
    const r = await checkDnsFresh(d.dns, async () => nodata, HOST, "direct_tls", SERVER);
    expect(r.status).toBe("ok");
    expect(lookups).toContain(`public:${HOST}`);
  });

  it("a record at the zone that names another server is a mismatch, as before", async () => {
    const d = deps(fakeDb(pending()).db, [], [SERVER], ["198.51.100.9"]);
    expect((await checkDnsFresh(d.dns, d.zoneDns, HOST, "direct_tls", SERVER)).status).toBe("mismatch");
  });
});

describe("zoneServers", () => {
  function zone(ns: Record<string, string[] | string>, a: Record<string, string[]>) {
    const asked: string[] = [];
    const lookup: ZoneLookup = {
      resolveNs: async (h) => {
        asked.push(h);
        const v = ns[h] ?? "ENODATA";
        if (typeof v === "string") throw notFound(v);
        return v;
      },
      resolve4: async (h) => a[h] ?? [],
    };
    return { lookup, asked };
  }

  it("finds the deepest zone above the name from the top down, and never asks about the name itself", async () => {
    const z = zone({ "example.org": ["ns1.cf.example.", "ns2.cf.example"] }, { "ns1.cf.example": ["162.159.38.1"], "ns2.cf.example": ["162.159.38.2"] });
    expect(await zoneServers(z.lookup, HOST)).toEqual(["162.159.38.1", "162.159.38.2"]);
    expect(z.asked).toEqual(["example.org"]);
    const deep = zone({ "example.co.uk": ["ns.parent"], "team.example.co.uk": ["ns.child"] }, { "ns.parent": ["162.159.38.3"], "ns.child": ["162.159.38.4"] });
    expect(await zoneServers(deep.lookup, "dash.team.example.co.uk")).toEqual(["162.159.38.4"]);
    expect(deep.asked).toEqual(["co.uk", "example.co.uk", "team.example.co.uk"]);
  });

  it("keeps only public addresses, whatever a zone's owner names as its nameservers", async () => {
    const z = zone(
      { "example.org": ["a.ns", "b.ns", "c.ns", "d.ns", "e.ns"] },
      { "a.ns": ["127.0.0.1", "10.0.0.5"], "b.ns": ["169.254.169.254", "172.30.1.2"], "c.ns": ["192.168.1.1", "100.64.0.1"], "d.ns": ["162.159.38.8"], "e.ns": ["162.159.38.9"] },
    );
    expect(await zoneServers(z.lookup, HOST)).toEqual(["162.159.38.8"]);
  });

  it("gives up, so the public resolvers decide, when there is no zone above the name or a lookup fails", async () => {
    expect(await zoneServers(zone({}, {}).lookup, "example.com")).toEqual([]);
    expect(await zoneServers(zone({ "example.org": "ETIMEOUT" }, {}).lookup, HOST)).toEqual([]);
    const missing = zone({ "b.example.org": "ENOTFOUND", "example.org": ["ns"] }, { ns: ["162.159.38.5"] });
    expect(await zoneServers(missing.lookup, "a.b.example.org")).toEqual(["162.159.38.5"]);
  });
});
