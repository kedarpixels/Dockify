import { describe, expect, it } from "vitest";
import type { HttpClient, HttpRequest } from "@dockify/net-guard";
import { CloudflareApi } from "./cloudflare.ts";
import { expectedRecord, judgeHost, putRecord, readHost, zoneFor, type HostReadContext, type ServerTarget } from "./cloudflare-domains.ts";

const ZONE = "a".repeat(32);
const OTHER_ZONE = "c".repeat(32);
const REC = "b".repeat(32);
const REC2 = "d".repeat(32);
const NEW_ID = "e".repeat(32);
const direct: ServerTarget = { ingress: "direct_tls", ipv4: "203.0.113.7", ipv6: null, tunnelTarget: null };
const tunnel: ServerTarget = { ingress: "cloudflare_tunnel", ipv4: null, ipv6: null, tunnelTarget: "abc.cfargotunnel.com" };
const zones = [{ id: ZONE, name: "example.com", status: "active" }, { id: OTHER_ZONE, name: "other.dev", status: "active" }];

type Rec = { id: string; type: string; name: string; content: string; proxied?: boolean };

/** A tiny Cloudflare: no real call is ever made. `deny` lists the paths that answer 403. */
function mock(o: { records?: Rec[]; ssl?: string; always?: string; deny?: RegExp; failCreate?: boolean } = {}) {
  const records = [...(o.records ?? [])];
  const calls: HttpRequest[] = [];
  const http: HttpClient = async (r) => {
    calls.push(r);
    const url = new URL(r.url);
    const body = (status: number, result: unknown, extra: object = {}) => ({ status, headers: {}, body: Buffer.from(JSON.stringify({ success: status < 300, result, ...extra })) });
    if (o.deny?.test(url.pathname)) return body(403, null);
    if (url.pathname.endsWith("/settings/ssl")) return body(200, { value: o.ssl ?? "full" });
    if (url.pathname.endsWith("/settings/always_use_https")) return body(200, { value: o.always ?? "off" });
    const one = /\/dns_records\/(\w+)$/.exec(url.pathname);
    if (one && r.method === "DELETE") {
      records.splice(records.findIndex((x) => x.id === one[1]), 1);
      return body(200, { id: one[1] });
    }
    if (url.pathname.endsWith("/dns_records") && r.method === "POST") {
      if (o.failCreate) return body(400, null, { errors: [{ message: "An identical record already exists." }] });
      const b = JSON.parse(String(r.body)) as Rec;
      records.push({ ...b, id: NEW_ID });
      return body(200, { id: NEW_ID });
    }
    if (url.pathname.endsWith("/dns_records")) return body(200, records.filter((x) => x.name === url.searchParams.get("name")));
    return body(404, null);
  };
  return { api: new CloudflareApi(http, "secret-token"), calls, records };
}

const ctxFor = (api: CloudflareApi, target = direct, managed: string[] = [ZONE]): HostReadContext => ({ api, zones, managed: new Set(managed), target, settings: new Map() });
const read = (c: HostReadContext, host = "app.example.com", o: Partial<{ ownRecordId: string | null; certActive: boolean; dnsOk: boolean }> = {}) =>
  readHost(c, host, { ownRecordId: null, certActive: true, dnsOk: false, ...o });
const codes = (s: { findings: Array<{ code: string }> }) => s.findings.map((f) => f.code);

describe("the record a hostname needs", () => {
  it("is an A record in direct mode, a proxied CNAME in a tunnel", () => {
    expect(expectedRecord(direct)).toEqual({ type: "A", content: "203.0.113.7", proxied: null });
    expect(expectedRecord(tunnel)).toEqual({ type: "CNAME", content: "abc.cfargotunnel.com", proxied: true });
    expect(expectedRecord({ ...direct, ipv4: null, ipv6: "2001:db8::1" })).toEqual({ type: "AAAA", content: "2001:db8::1", proxied: null });
    expect(expectedRecord({ ...direct, ipv4: null })).toBeNull();
  });
  it("finds the zone by its longest name, never a mere suffix of a label", () => {
    const z = [{ name: "example.com" }, { name: "dev.example.com" }];
    expect(zoneFor(z, "a.dev.example.com")?.name).toBe("dev.example.com");
    expect(zoneFor(z, "example.com")?.name).toBe("example.com");
    expect(zoneFor(z, "notexample.com")).toBeNull();
  });
});

describe("reading a hostname's state", () => {
  it("reports a record that points here, proxied or DNS only, with the zone's SSL mode", async () => {
    const m = mock({ records: [{ id: REC, type: "A", name: "app.example.com", content: "203.0.113.7", proxied: true }], ssl: "full" });
    const s = await read(ctxFor(m.api), "app.example.com", { ownRecordId: REC });
    expect(s).toMatchObject({ zone: { id: ZONE, name: "example.com", status: "active" }, managed: true, correct: true, sslMode: "full", findings: [] });
    expect(s.records[0]).toEqual({ id: REC, type: "A", name: "app.example.com", content: "203.0.113.7", proxied: true, ours: true });
  });

  it("marks only the recorded id as Dockify's", async () => {
    const m = mock({ records: [{ id: REC, type: "A", name: "app.example.com", content: "203.0.113.7" }] });
    expect((await read(ctxFor(m.api))).records[0]!.ours).toBe(false);
  });

  it("says when there is no record", async () => {
    const s = await read(ctxFor(mock().api));
    expect(s.correct).toBe(false);
    expect(codes(s)).toEqual(["no_record"]);
  });

  it("warns about a record that points elsewhere", async () => {
    const m = mock({ records: [{ id: REC, type: "A", name: "app.example.com", content: "198.51.100.9" }] });
    const s = await read(ctxFor(m.api));
    expect(s.correct).toBe(false);
    expect(s.findings[0]).toMatchObject({ code: "wrong_target", tone: "bad" });
    expect(s.findings[0]!.text).toContain("198.51.100.9");
  });

  it("never reads a zone the owner did not switch on: no record or setting call reaches it", async () => {
    const m = mock({ records: [{ id: REC, type: "A", name: "x.other.dev", content: "198.51.100.9" }] });
    const s = await read(ctxFor(m.api), "x.other.dev");
    expect(s).toMatchObject({ managed: false, records: [], sslMode: null });
    expect(codes(s)).toEqual(["not_managed"]);
    expect(m.calls).toEqual([]);
  });

  it("says when no zone the token can see owns the name", async () => {
    const s = await read(ctxFor(mock().api), "app.nowhere.io");
    expect(s.zone).toBeNull();
    expect(codes(s)).toEqual(["no_zone"]);
  });

  it("reads one zone's settings once, however many names share it", async () => {
    const m = mock();
    const c = ctxFor(m.api);
    await Promise.all(["a.example.com", "b.example.com", "c.example.com"].map((h) => read(c, h)));
    expect(m.calls.filter((r) => r.url.endsWith("/settings/ssl"))).toHaveLength(1);
  });

  it("ignores TXT and MX at the same name: they are not in the way", async () => {
    const m = mock({ records: [{ id: REC, type: "TXT", name: "app.example.com", content: "v=spf1" }, { id: REC2, type: "A", name: "app.example.com", content: "203.0.113.7" }] });
    const s = await read(ctxFor(m.api));
    expect(s.records.map((r) => r.type)).toEqual(["A"]);
    expect(s.correct).toBe(true);
  });

  it("says plainly when the token lacks a permission, for DNS and for SSL settings, and never throws", async () => {
    const noDns = await read(ctxFor(mock({ deny: /dns_records/ }).api));
    expect(noDns.findings[0]).toMatchObject({ code: "dns_denied", tone: "bad" });
    expect(noDns.findings[0]!.text).toContain("Zone, DNS");
    const noSsl = await read(ctxFor(mock({ deny: /settings/, records: [{ id: REC, type: "A", name: "app.example.com", content: "203.0.113.7", proxied: true }] }).api));
    expect(noSsl.sslMode).toBeNull();
    expect(noSsl.findings[0]).toMatchObject({ code: "ssl_denied", tone: "info" });
    expect(noSsl.findings[0]!.text).toContain("Zone Settings");
  });

  it("never lets the token into anything it returns", async () => {
    const m = mock({ deny: /dns_records/ });
    expect(JSON.stringify(await read(ctxFor(m.api)))).not.toContain("secret-token");
    expect(m.calls[0]?.headers?.Authorization).toBe("Bearer secret-token");
  });
});

describe("the combinations that break", () => {
  const proxied = [{ id: REC, type: "A", name: "app.example.com", content: "203.0.113.7", proxied: true, ours: false }];
  const base = { host: "app.example.com", target: direct, records: proxied, zonePending: false, sslMode: "full" as const, sslDenied: false, alwaysUseHttps: false, certActive: true, dnsOk: true };

  it("Full with a proxied record is fine", () => {
    expect(judgeHost(base)).toEqual({ correct: true, findings: [] });
  });
  it("Flexible is a redirect loop", () => {
    const j = judgeHost({ ...base, sslMode: "flexible" });
    expect(j.findings[0]).toMatchObject({ code: "ssl_flexible", tone: "bad" });
    expect(j.findings[0]!.text).toContain("loop");
  });
  it("Off is the same loop", () => {
    expect(judgeHost({ ...base, sslMode: "off" }).findings[0]?.code).toBe("ssl_off");
  });
  it("Full (strict) is a 526 only until this server holds the certificate", () => {
    const j = judgeHost({ ...base, sslMode: "strict", certActive: false });
    expect(j.findings[0]).toMatchObject({ code: "ssl_strict_no_cert", tone: "bad" });
    expect(j.findings[0]!.text).toContain("526");
    expect(judgeHost({ ...base, sslMode: "strict", certActive: true }).findings).toEqual([]);
  });
  it("Always Use HTTPS is worth a word only while the certificate is pending", () => {
    expect(judgeHost({ ...base, alwaysUseHttps: true, certActive: false }).findings[0]?.code).toBe("always_https");
    expect(judgeHost({ ...base, alwaysUseHttps: true, certActive: true }).findings).toEqual([]);
  });
  it("a DNS-only record does not care about the SSL mode", () => {
    expect(judgeHost({ ...base, records: [{ ...proxied[0]!, proxied: false }], sslMode: "flexible" }).findings).toEqual([]);
  });
  it("in a tunnel the mode plays no part, and the record must be a proxied CNAME to the tunnel", () => {
    const cname = [{ id: REC, type: "CNAME", name: "app.example.com", content: "abc.cfargotunnel.com", proxied: true, ours: false }];
    expect(judgeHost({ ...base, target: tunnel, records: cname, sslMode: "flexible" })).toEqual({ correct: true, findings: [] });
    expect(judgeHost({ ...base, target: tunnel, records: [{ ...cname[0]!, proxied: false }] }).findings[0]?.code).toBe("needs_proxy");
    expect(judgeHost({ ...base, target: tunnel, records: proxied }).findings[0]?.code).toBe("wrong_target");
  });
  it("a CNAME in direct mode counts when the DNS check says it leads here", () => {
    const cname = [{ id: REC, type: "CNAME", name: "app.example.com", content: "example.com", proxied: false, ours: false }];
    expect(judgeHost({ ...base, records: cname, dnsOk: true }).correct).toBe(true);
    expect(judgeHost({ ...base, records: cname, dnsOk: false }).findings[0]?.code).toBe("wrong_target");
  });
});

describe("creating a record", () => {
  const put = (m: ReturnType<typeof mock>, o: Partial<Parameters<typeof putRecord>[0]> = {}) =>
    putRecord({ api: m.api, zones, managed: new Set([ZONE]), target: direct, host: "app.example.com", proxied: false, replace: [], ...o });
  const writes = (m: ReturnType<typeof mock>) => m.calls.filter((c) => c.method !== "GET");

  it("creates the A record with the comment that marks it as Dockify's", async () => {
    const m = mock();
    expect(await put(m, { proxied: true })).toEqual({ zoneId: ZONE, recordId: NEW_ID, removed: [], created: true });
    expect(JSON.parse(String(writes(m)[0]!.body))).toEqual({ type: "A", name: "app.example.com", content: "203.0.113.7", ttl: 1, proxied: true, comment: "Managed by Dockify" });
  });

  it("makes a tunnel's record proxied whatever was asked", async () => {
    const m = mock();
    await put(m, { target: tunnel, proxied: false });
    expect(JSON.parse(String(writes(m)[0]!.body))).toMatchObject({ type: "CNAME", content: "abc.cfargotunnel.com", proxied: true });
  });

  it("never overwrites: a record already there stops it, and nothing is written", async () => {
    const m = mock({ records: [{ id: REC, type: "A", name: "app.example.com", content: "198.51.100.9" }] });
    await expect(put(m)).rejects.toMatchObject({ code: "RECORD_EXISTS", status: 409 });
    expect(writes(m)).toEqual([]);
  });

  it("replaces only with a go-ahead naming exactly what is there", async () => {
    const records = [{ id: REC, type: "A", name: "app.example.com", content: "198.51.100.9" }, { id: REC2, type: "AAAA", name: "app.example.com", content: "2001:db8::9" }];
    const partial = mock({ records });
    await expect(put(partial, { replace: [REC] })).rejects.toMatchObject({ code: "RECORD_CHANGED" });
    expect(writes(partial)).toEqual([]);
    const stale = mock({ records });
    await expect(put(stale, { replace: [REC, "f".repeat(32)] })).rejects.toMatchObject({ code: "RECORD_CHANGED" });
    expect(writes(stale)).toEqual([]);
    const m = mock({ records });
    const out = await put(m, { replace: [REC, REC2] });
    expect(out.removed.map((r) => r.id)).toEqual([REC, REC2]);
    expect(writes(m).map((c) => c.method)).toEqual(["DELETE", "DELETE", "POST"]);
    expect(m.records.map((r) => r.id)).toEqual([NEW_ID]);
  });

  it("puts the old records back when the new one is refused", async () => {
    const m = mock({ records: [{ id: REC, type: "A", name: "app.example.com", content: "198.51.100.9", proxied: true }], failCreate: true });
    await expect(put(m, { replace: [REC] })).rejects.toMatchObject({ code: "UPSTREAM" });
    const posts = writes(m).filter((c) => c.method === "POST").map((c) => JSON.parse(String(c.body)) as Rec);
    expect(posts.at(-1)).toMatchObject({ content: "198.51.100.9", proxied: true });
  });

  it("leaves a record that is already right alone, and does not claim it", async () => {
    const m = mock({ records: [{ id: REC, type: "A", name: "app.example.com", content: "203.0.113.7", proxied: false }] });
    expect(await put(m)).toEqual({ zoneId: ZONE, recordId: null, removed: [], created: false });
    expect(writes(m)).toEqual([]);
  });

  it("never writes to a zone the owner did not switch on, or one the token cannot see", async () => {
    const m = mock();
    await expect(put(m, { host: "x.other.dev" })).rejects.toMatchObject({ code: "ZONE_NOT_MANAGED" });
    await expect(put(m, { host: "x.nowhere.io" })).rejects.toMatchObject({ code: "CLOUDFLARE_NO_ZONE" });
    expect(m.calls).toEqual([]);
  });

  it("says which permission a refused write lacks", async () => {
    const m = mock({ deny: /^(?!.*dns_records$)/ });
    const denied = mock();
    const http: HttpClient = async (r) => (r.method === "POST" ? { status: 403, headers: {}, body: Buffer.from("{}") } : { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ success: true, result: [] })) });
    await expect(putRecord({ api: new CloudflareApi(http, "t"), zones, managed: new Set([ZONE]), target: direct, host: "app.example.com", proxied: false, replace: [] })).rejects.toMatchObject({ code: "CLOUDFLARE_PERMISSION", message: expect.stringContaining("Zone, DNS, Edit") });
    expect(m.calls).toEqual([]);
    expect(denied.calls).toEqual([]);
  });

  it("refuses when the server's address is not known", async () => {
    await expect(put(mock(), { target: { ...direct, ipv4: null } })).rejects.toMatchObject({ code: "SERVER_ADDRESS_UNKNOWN" });
  });
});
