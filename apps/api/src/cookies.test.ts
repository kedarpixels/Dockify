import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { clearCookie, readCookie, setCookie, webFor } from "./cookies.ts";

const WEB = { origin: "https://dash.example.com", secure: true, loopback: "127.0.0.1:3000" };
const TUNNEL = { "x-dockify-loopback-host": "127.0.0.1:3000" };
const req = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;
function reply(headers: Record<string, string> = {}) {
  const set: Record<string, unknown> = {};
  return {
    set,
    request: { headers },
    getHeader: (k: string) => set[k],
    header: (k: string, v: unknown) => void (set[k] = v),
  } as unknown as FastifyReply & { set: Record<string, string[]> };
}

describe("cookies on the SSH tunnel", () => {
  it("a tunnelled browser gets the bare, non-Secure session cookie it can actually keep over http", () => {
    const r = reply(TUNNEL);
    setCookie(r, WEB, "session", "tok", 60_000);
    expect(r.set["set-cookie"]).toEqual(["dockify_sid=tok; Path=/; HttpOnly; SameSite=Strict; Max-Age=60"]);
    clearCookie(r, WEB, "pending");
    expect(r.set["set-cookie"]![1]).toMatch(/^dockify_pending=; /);
    expect(readCookie(req({ ...TUNNEL, cookie: "dockify_sid=tok" }), WEB, "session")).toBe("tok");
  });

  it("everyone else keeps __Host- and Secure", () => {
    const r = reply();
    setCookie(r, WEB, "session", "tok", 60_000);
    expect(r.set["set-cookie"]![0]).toBe("__Host-dockify_sid=tok; Path=/; HttpOnly; SameSite=Strict; Max-Age=60; Secure");
  });

  it("a bare cookie a sibling subdomain planted is not read on the public address", () => {
    expect(readCookie(req({ cookie: "dockify_sid=planted" }), WEB, "session")).toBeUndefined();
    expect(readCookie(req({ cookie: "dockify_sid=planted; __Host-dockify_sid=real" }), WEB, "session")).toBe("real");
  });

  it("the tunnel's cookie reads only on the exact loopback address", () => {
    expect(readCookie(req({ "x-dockify-loopback-host": "127.0.0.1:9999", cookie: "dockify_sid=tok" }), WEB, "session")).toBeUndefined();
    expect(webFor(req({ "x-dockify-loopback-host": "127.0.0.1:9999" }), WEB)).toBe(WEB);
    expect(webFor(req(TUNNEL), { origin: WEB.origin, secure: true })).toMatchObject({ origin: WEB.origin, secure: true });
    expect(webFor(req(TUNNEL), WEB)).toEqual({ origin: "http://127.0.0.1:3000", secure: false });
  });
});
