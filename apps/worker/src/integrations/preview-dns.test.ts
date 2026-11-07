import { describe, expect, it } from "vitest";
import { CHECK_LABEL, runPreviewDns, staleDnsDomains, wantedPreviewDomains } from "./preview-dns.ts";

function fakeDb(projects: Array<{ previewDomain: string | null }>, instanceDomain: string | null = null) {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    instance: { findUnique: async () => ({ previewDomain: instanceDomain, publicUrl: "https://dash.example.com" }) },
    project: { findMany: async () => projects },
    integration: { findFirst: async () => null },
    previewDomain: {
      upsert: async ({ where, create }: { where: { domain: string }; create: Record<string, unknown> }) => {
        if (!rows.has(where.domain)) rows.set(where.domain, { cfState: "none", dnsStatus: "unchecked", checkedAt: null, ...create });
        return rows.get(where.domain);
      },
      update: async ({ where, data }: { where: { domain: string }; data: Record<string, unknown> }) => Object.assign(rows.get(where.domain)!, data),
      findMany: async () => [...rows.values()],
    },
  };
  return { db: db as never, rows };
}

const settings = (ingress: "direct_tls" | "cloudflare_tunnel") => ({
  mode: ingress === "direct_tls" ? { ingress, certResolver: "le" } : { ingress },
  dashboardHost: "dash.example.com", serverIpv4: "203.0.113.7", routesDir: "/tmp", acmeEmail: null, acmeCaServer: null,
}) as never;

describe("preview domain DNS check", () => {
  it("knows which domains are in use: overrides, then the instance one, then the derived default", async () => {
    const { db } = fakeDb([{ previewDomain: "preview.horseai.com" }, { previewDomain: null }]);
    expect([...(await wantedPreviewDomains(db))].sort()).toEqual(["preview.example.com", "preview.horseai.com"]);
    const withInstance = fakeDb([{ previewDomain: null }], "pv.acme.io");
    expect([...(await wantedPreviewDomains(withInstance.db))]).toEqual(["pv.acme.io"]);
  });

  it("passes only when the wildcard resolves to this server (direct mode)", async () => {
    const { db, rows } = fakeDb([{ previewDomain: null }]);
    const asked: string[] = [];
    const here = { resolve4: async (h: string) => (asked.push(h), ["203.0.113.7"]), resolveCname: async () => [] };
    await runPreviewDns({ db, vault: {} as never, settings: settings("direct_tls"), dns: here }, { domain: "preview.example.com" });
    expect(asked).toEqual([`${CHECK_LABEL}.preview.example.com`]);
    expect(rows.get("preview.example.com")).toMatchObject({ dnsStatus: "ok", cfState: "none", cfMessage: "Cloudflare is not connected." });

    const elsewhere = { resolve4: async () => ["198.51.100.1"], resolveCname: async () => [] };
    await runPreviewDns({ db, vault: {} as never, settings: settings("direct_tls"), dns: elsewhere }, { domain: "preview.example.com" });
    expect(rows.get("preview.example.com")).toMatchObject({ dnsStatus: "mismatch" });

    const missing = { resolve4: async () => Promise.reject(Object.assign(new Error("nx"), { code: "ENOTFOUND" })), resolveCname: async () => [] };
    await runPreviewDns({ db, vault: {} as never, settings: settings("direct_tls"), dns: missing }, { domain: "preview.example.com" });
    expect(rows.get("preview.example.com")).toMatchObject({ dnsStatus: "missing" });
  });

  it("in tunnel mode wants Cloudflare's proxy in front, never the server address", async () => {
    const { db, rows } = fakeDb([{ previewDomain: null }]);
    await runPreviewDns({ db, vault: {} as never, settings: settings("cloudflare_tunnel"), dns: { resolve4: async () => ["104.16.1.1"], resolveCname: async () => [] } }, { domain: "preview.example.com" });
    expect(rows.get("preview.example.com")).toMatchObject({ dnsStatus: "ok" });
    await runPreviewDns({ db, vault: {} as never, settings: settings("cloudflare_tunnel"), dns: { resolve4: async () => ["203.0.113.7"], resolveCname: async () => [] } }, { domain: "preview.example.com" });
    expect(rows.get("preview.example.com")).toMatchObject({ dnsStatus: "mismatch" });
  });

  it("never checks a domain nobody uses, and refuses a bad payload", async () => {
    const { db, rows } = fakeDb([]);
    const dns = { resolve4: async () => { throw new Error("must not resolve"); }, resolveCname: async () => [] };
    await runPreviewDns({ db, vault: {} as never, settings: settings("direct_tls"), dns }, { domain: "preview.example.com" });
    expect(rows.get("preview.example.com")).toMatchObject({ dnsStatus: "unchecked" });
    await runPreviewDns({ db, vault: {} as never, settings: settings("direct_tls"), dns }, { domain: "../etc" });
    expect(rows.size).toBe(1);
  });

  it("re-checks a wanted domain that has not passed, and an unused one Dockify still holds a record for", async () => {
    const { db, rows } = fakeDb([{ previewDomain: null }]);
    expect(await staleDnsDomains(db)).toEqual(["preview.example.com"]);
    rows.set("preview.example.com", { domain: "preview.example.com", dnsStatus: "ok", checkedAt: new Date(), cfState: "none" });
    rows.set("old.example.com", { domain: "old.example.com", dnsStatus: "ok", checkedAt: new Date(), cfState: "managed" });
    expect(await staleDnsDomains(db)).toEqual(["old.example.com"]);
  });
});
