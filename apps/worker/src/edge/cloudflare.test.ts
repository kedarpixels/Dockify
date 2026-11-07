import { describe, expect, it } from "vitest";
import { CfError, unwireDomain, wireDomain, withRule, type CfClient, type CfIngress } from "./cloudflare.ts";
import { checkDns, type DnsLookup } from "./dns.ts";
import { reservedHosts } from "./hostnames.ts";
import { TUNNEL_SERVICE } from "./ingress.ts";
import { checkTls, type TlsProbe } from "./tls.ts";

const ZONE = "a".repeat(32);
const REC = "b".repeat(32);
const TUNNEL = "33333333-3333-4333-8333-333333333333";
const OTHER_TUNNEL = "44444444-4444-4444-8444-444444444444";
const reserved = reservedHosts("dash.example.com");

interface Record_ { id: string; type: string; name: string; content: string }

/** A tiny in-memory Cloudflare: zones, records and one tunnel config per tunnel id. */
function fakeCf(init: { records?: Record_[]; ingress?: CfIngress[]; failCreate?: boolean } = {}) {
  const records = [...(init.records ?? [])];
  const configs: Record<string, { ingress: CfIngress[]; warp?: boolean }> = {
    [TUNNEL]: { ingress: init.ingress ?? [{ hostname: "dash.example.com", service: "http://web:3000" }, { service: "http_status:404" }], warp: true },
  };
  const puts: unknown[] = [];
  const client: CfClient = {
    async call<T>(path: string, req: { method?: string; body?: unknown } = {}): Promise<T> {
      const method = req.method ?? "GET";
      const u = new URL(`https://x${path}`);
      if (u.pathname === "/zones") {
        return (u.searchParams.get("name") === "example.com" ? [{ id: ZONE, name: "example.com", status: "active" }] : []) as T;
      }
      const rec = /^\/zones\/\w+\/dns_records(?:\/(\w+))?$/.exec(u.pathname);
      if (rec) {
        if (rec[1]) {
          const i = records.findIndex((r) => r.id === rec[1]);
          if (i < 0) throw new CfError("not found", 404);
          if (method === "DELETE") return records.splice(i, 1)[0] as T;
          return records[i] as T;
        }
        if (method === "POST") {
          if (init.failCreate) throw new CfError("boom", 500);
          const b = req.body as Record_;
          const r = { id: REC, type: b.type, name: b.name, content: b.content };
          records.push(r);
          return r as T;
        }
        return records.filter((r) => r.name === u.searchParams.get("name")) as T;
      }
      const tun = /\/cfd_tunnel\/([\w-]+)\/configurations$/.exec(u.pathname);
      if (tun) {
        if (method === "PUT") {
          puts.push(req.body);
          configs[tun[1]!] = (req.body as { config: { ingress: CfIngress[] } }).config;
          return {} as T;
        }
        return { config: configs[tun[1]!] ?? { ingress: [] } } as T;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { client, records, configs, puts };
}

const lock = <T>(fn: () => Promise<T>) => fn();
const wireArgs = (cf: CfClient, extra: Partial<Parameters<typeof wireDomain>[0]> = {}) => ({
  cf, accountId: "acc", tunnelId: TUNNEL, host: "app.example.com", reserved,
  managedZoneIds: new Set([ZONE]), withTunnelLock: lock, resumingRule: false, markRuleIntent: async () => {}, ...extra,
});

describe("cloudflare wire", () => {
  it("adds the rule before the catch-all, keeps every other key and rule, and creates a proxied CNAME", async () => {
    const f = fakeCf();
    const out = await wireDomain(wireArgs(f.client));
    expect(out).toMatchObject({ state: "managed", zoneId: ZONE, recordId: REC });
    expect(f.configs[TUNNEL]!.ingress).toEqual([
      { hostname: "dash.example.com", service: "http://web:3000" },
      { hostname: "app.example.com", service: TUNNEL_SERVICE },
      { service: "http_status:404" },
    ]);
    expect(f.configs[TUNNEL]!.warp).toBe(true);
    expect(f.records[0]!.content).toBe(`${TUNNEL}.cfargotunnel.com`);
  });
  it("never adopts a hand-made record", async () => {
    const f = fakeCf({ records: [{ id: "c".repeat(32), type: "A", name: "app.example.com", content: "1.2.3.4" }] });
    expect((await wireDomain(wireArgs(f.client))).state).toBe("external");
    expect(f.puts).toEqual([]);
  });
  it("never overwrites a hand-made tunnel rule", async () => {
    const f = fakeCf({ ingress: [{ hostname: "app.example.com", service: "http://elsewhere:8080" }, { service: "http_status:404" }] });
    expect((await wireDomain(wireArgs(f.client))).state).toBe("external");
    expect(f.puts).toEqual([]);
    expect(f.records).toEqual([]);
  });
  it("refuses the dashboard host and unmanaged zones", async () => {
    const f = fakeCf();
    await expect(wireDomain(wireArgs(f.client, { host: "dash.example.com" }))).rejects.toThrow(/dashboard/);
    expect((await wireDomain(wireArgs(f.client, { managedZoneIds: new Set() }))).state).toBe("external");
  });
  it("rolls back its own rule when the record create fails", async () => {
    const f = fakeCf({ failCreate: true });
    expect((await wireDomain(wireArgs(f.client))).state).toBe("failed");
    expect(f.configs[TUNNEL]!.ingress.some((r) => r.hostname === "app.example.com")).toBe(false);
  });
  it("on a retry recognises the rule it added before a crash", async () => {
    const f = fakeCf({ ingress: [{ hostname: "app.example.com", service: TUNNEL_SERVICE }, { service: "http_status:404" }] });
    expect((await wireDomain(wireArgs(f.client, { resumingRule: true }))).state).toBe("managed");
  });
  it("withRule appends a catch-all when the list has none", () => {
    expect(withRule([], { hostname: "a.b.com", service: "s" })).toEqual([{ hostname: "a.b.com", service: "s" }, { service: "http_status:404" }]);
  });
});

describe("cloudflare unwire", () => {
  const args = (cf: CfClient, extra = {}) => ({
    cf, accountId: "acc", host: "app.example.com", zoneId: ZONE, recordId: REC, tunnelId: TUNNEL, reserved, withTunnelLock: lock, ...extra,
  });
  it("deletes exactly the recorded record and our rule", async () => {
    const f = fakeCf();
    await wireDomain(wireArgs(f.client));
    const out = await unwireDomain(args(f.client));
    expect(out).toMatchObject({ ok: true, record: "deleted", rule: "removed" });
    expect(f.records).toEqual([]);
    expect(f.configs[TUNNEL]!.ingress).toEqual([{ hostname: "dash.example.com", service: "http://web:3000" }, { service: "http_status:404" }]);
  });
  it("leaves a record that was repointed by hand, and a rule that was edited", async () => {
    const f = fakeCf({
      records: [{ id: REC, type: "CNAME", name: "app.example.com", content: `${OTHER_TUNNEL}.cfargotunnel.com` }],
      ingress: [{ hostname: "app.example.com", service: "http://custom:9000" }, { service: "http_status:404" }],
    });
    const out = await unwireDomain(args(f.client));
    expect(out).toMatchObject({ ok: false, record: "changed", rule: "foreign" });
    expect(f.records).toHaveLength(1);
    expect(f.puts).toEqual([]);
  });
  it("is fine when everything is already gone, and refuses the dashboard host", async () => {
    const f = fakeCf();
    expect(await unwireDomain(args(f.client))).toMatchObject({ ok: true, record: "absent", rule: "absent" });
    expect((await unwireDomain(args(f.client, { host: "dash.example.com" }))).ok).toBe(false);
    expect(f.configs[TUNNEL]!.ingress).toHaveLength(2);
  });
});

const lookup = (a: string[] | Error, cname: string[] = []): DnsLookup => ({
  resolve4: async () => {
    if (a instanceof Error) throw a;
    return a;
  },
  resolveCname: async () => cname,
});
const err = (code: string) => Object.assign(new Error(code), { code });

describe("dns check", () => {
  it("direct: ok only when every A is the server", async () => {
    expect((await checkDns(lookup(["203.0.113.5"]), "a.example.com", "direct_tls", "203.0.113.5")).status).toBe("ok");
    const m = await checkDns(lookup(["203.0.113.5", "198.51.100.1"]), "a.example.com", "direct_tls", "203.0.113.5");
    expect(m.status).toBe("mismatch");
    expect(m.detail).toContain("198.51.100.1");
  });
  it("direct: a proxied record is a mismatch with a clear reason", async () => {
    const r = await checkDns(lookup(["104.21.3.4"]), "a.example.com", "direct_tls", "203.0.113.5");
    expect(r.status).toBe("mismatch");
    expect(r.detail).toMatch(/proxied/);
  });
  it("tunnel: proxied is ok, the bare server IP is a mismatch", async () => {
    expect((await checkDns(lookup(["104.21.3.4", "172.67.1.1"]), "a.example.com", "cloudflare_tunnel", "203.0.113.5")).status).toBe("ok");
    expect((await checkDns(lookup(["203.0.113.5"]), "a.example.com", "cloudflare_tunnel", "203.0.113.5")).status).toBe("mismatch");
  });
  it("missing vs unchecked, and the CNAME shows in resolved", async () => {
    expect((await checkDns(lookup(err("ENOTFOUND")), "a.example.com", "direct_tls", "203.0.113.5")).status).toBe("missing");
    expect((await checkDns(lookup(err("ETIMEOUT")), "a.example.com", "direct_tls", "203.0.113.5")).status).toBe("unchecked");
    const r = await checkDns(lookup(["203.0.113.5"], ["Edge.Example.net."]), "a.example.com", "direct_tls", "203.0.113.5");
    expect(r.resolved).toEqual(["cname:edge.example.net", "203.0.113.5"]);
  });
});

describe("tls check", () => {
  const cert = (o: Record<string, unknown>) => ({ subject: { CN: "a.example.com" }, subjectaltname: "DNS:a.example.com", issuer: { O: "Let's Encrypt" }, valid_to: "Jan  1 00:00:00 2030 GMT", ...o });
  const probe = (c: unknown, authorized = true): TlsProbe => async () => ({ cert: c as never, authorized, authorizationError: authorized ? null : "SELF_SIGNED" });
  const now = new Date("2026-10-30T00:00:00Z");

  it("active with issuer and expiry", async () => {
    const r = await checkTls(probe(cert({})), "a.example.com", ["203.0.113.5"], "203.0.113.5", now);
    expect(r).toMatchObject({ status: "active", issuer: "Let's Encrypt" });
    expect(r.expiresAt?.getUTCFullYear()).toBe(2030);
  });
  it("pending while Traefik serves its default cert, failed when expired", async () => {
    const traefik = cert({ subject: { CN: "TRAEFIK DEFAULT CERT" }, subjectaltname: "DNS:x.traefik.default", issuer: { CN: "TRAEFIK DEFAULT CERT" } });
    expect((await checkTls(probe(traefik, false), "a.example.com", ["203.0.113.5"], "203.0.113.5", now)).status).toBe("pending");
    expect((await checkTls(probe(cert({ valid_to: "Jan  1 00:00:00 2020 GMT" })), "a.example.com", ["203.0.113.5"], null, now)).status).toBe("failed");
  });
  it("never probes an internal address", async () => {
    let called = false;
    const spy: TlsProbe = async () => {
      called = true;
      throw new Error("no");
    };
    expect((await checkTls(spy, "a.example.com", ["10.0.0.5", "169.254.169.254"], "203.0.113.5", now)).status).toBe("pending");
    expect(called).toBe(false);
  });
});
