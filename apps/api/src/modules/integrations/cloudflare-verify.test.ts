import { describe, expect, it } from "vitest";
import type { HttpClient, HttpRequest } from "@dockify/net-guard";
import { CloudflareApi } from "./cloudflare.ts";

const ACCOUNT = { id: "f".repeat(32), name: "Example account" };
const ZONE_ACCOUNT = { id: "9".repeat(32), name: "Zone owner" };

/** A tiny Cloudflare that answers verify()'s reads. No real call is ever made. */
function mock(o: { accounts?: unknown[]; zones?: unknown[]; userVerify?: number; status?: string }) {
  const calls: HttpRequest[] = [];
  const http: HttpClient = async (r) => {
    calls.push(r);
    const path = new URL(r.url).pathname;
    const body = (status: number, result: unknown) => ({ status, headers: {}, body: Buffer.from(JSON.stringify({ success: status < 300, result })) });
    if (path.endsWith("/accounts")) return body(200, o.accounts ?? []);
    if (path.endsWith("/zones")) return body(200, o.zones ?? []);
    if (path.endsWith("/user/tokens/verify")) return body(o.userVerify ?? 200, { status: o.status ?? "active" });
    if (/\/accounts\/\w+\/tokens\/verify$/.test(path)) return body(200, { status: o.status ?? "active" });
    return body(404, null);
  };
  return { api: new CloudflareApi(http, "secret-token"), calls, paths: () => calls.map((c) => new URL(c.url).pathname) };
}

describe("CloudflareApi.verify", () => {
  it("takes the first account the token can list", async () => {
    const m = mock({ accounts: [ACCOUNT], zones: [{ account: ZONE_ACCOUNT }] });
    await expect(m.api.verify()).resolves.toEqual(ACCOUNT);
    expect(m.paths().some((p) => p.endsWith("/zones"))).toBe(false);
  });

  it("takes the account from the first zone when the token lists no account", async () => {
    const m = mock({ accounts: [], zones: [{ id: "a".repeat(32), name: "example.com", account: ZONE_ACCOUNT }] });
    await expect(m.api.verify()).resolves.toEqual(ZONE_ACCOUNT);
    expect(m.paths().some((p) => p.endsWith("/zones"))).toBe(true);
  });

  it("verifies a zone only token at its account when the user check is refused", async () => {
    const m = mock({ accounts: [], zones: [{ account: ZONE_ACCOUNT }], userVerify: 403 });
    await expect(m.api.verify()).resolves.toEqual(ZONE_ACCOUNT);
    expect(m.paths().at(-1)).toBe(`/client/v4/accounts/${ZONE_ACCOUNT.id}/tokens/verify`);
  });

  it("refuses a token that sees no account and no zone, and names the permission", async () => {
    const m = mock({ accounts: [], zones: [] });
    await expect(m.api.verify()).rejects.toMatchObject({ code: "CLOUDFLARE_TOKEN", message: expect.stringContaining("Zone, DNS, Edit") });
  });

  it("refuses a zone without an account", async () => {
    const m = mock({ accounts: [], zones: [{ id: "a".repeat(32), name: "example.com" }] });
    await expect(m.api.verify()).rejects.toMatchObject({ code: "CLOUDFLARE_TOKEN" });
  });

  it("refuses a token that is not active", async () => {
    const m = mock({ accounts: [], zones: [{ account: ZONE_ACCOUNT }], status: "disabled" });
    await expect(m.api.verify()).rejects.toMatchObject({ code: "CLOUDFLARE_TOKEN", message: "This token is disabled" });
  });

  it("never puts the token in a URL", async () => {
    const m = mock({ accounts: [], zones: [{ account: ZONE_ACCOUNT }] });
    await m.api.verify();
    expect(m.calls.every((c) => !c.url.includes("secret-token"))).toBe(true);
  });
});
