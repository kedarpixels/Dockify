/**
 * /api/v1/ on the dashboard host reaches the api straight from Traefik (direct mode) and
 * from cloudflared (tunnel mode), as well as through the web. The api must read the client address
 * each of those hops reports, by the trust list docker-compose.yml gives it, and its internal routes
 * must stay closed to every one of them, whatever they send.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { internalChannelToken } from "@dockify/crypto";
import { buildApp } from "./app.ts";
import { createClientResolver } from "./client-ip.ts";
import { noDb, testConfig, testRing } from "./test-helpers.ts";

const compose = readFileSync(path.resolve(import.meta.dirname, "../../../deploy/docker-compose.yml"), "utf8");
const listOf = (key: string) => new RegExp(`${key}: ([\\d.,]+)`).exec(compose)?.[1]?.split(",") ?? [];
const TRUSTED = listOf("DOCKIFY_TRUSTED_PROXIES");
const PEERS = listOf("DOCKIFY_INTERNAL_PEERS");
const WEB = "172.30.1.20";
const TRAEFIK = "172.30.1.30";
const CLOUDFLARED = "172.30.1.40";
const CLIENT = "198.51.100.7";

describe("client address through the edge hops", () => {
  it("trusts the web, Traefik and cloudflared by address, and nothing else", () => {
    expect([...TRUSTED].sort()).toEqual([WEB, TRAEFIK, CLOUDFLARED].sort());
  });

  it("tunnel mode: reads cloudflared's CF-Connecting-IP", () => {
    const r = createClientResolver(TRUSTED, "cloudflare_tunnel");
    expect(r(CLOUDFLARED, { "cf-connecting-ip": CLIENT, "x-forwarded-for": CLIENT })).toEqual({ ip: CLIENT, known: true });
  });

  it("direct mode: reads Traefik's X-Forwarded-For and never a client-set CF-Connecting-IP", () => {
    const r = createClientResolver(TRUSTED, "direct_tls");
    expect(r(TRAEFIK, { "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": CLIENT })).toEqual({ ip: CLIENT, known: true });
    // A hop the client prepended loses to the one Traefik appended.
    expect(r(TRAEFIK, { "x-forwarded-for": `1.1.1.1, ${CLIENT}` }).ip).toBe(CLIENT);
  });

  it("treats any other peer on the edge network as the client itself", () => {
    const r = createClientResolver(TRUSTED, "direct_tls");
    expect(r(WEB, { "x-forwarded-for": CLIENT }).ip).toBe(CLIENT);
    expect(r("172.30.1.10", { "x-forwarded-for": CLIENT }).ip).toBe("172.30.1.10");
    expect(r("172.30.1.99", { "x-forwarded-for": CLIENT }).ip).toBe("172.30.1.99");
  });
});

describe("internal routes stay closed to the edge hops", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    ({ app } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig({ trustedProxies: TRUSTED, internalPeers: PEERS }), logger: false }));
    await app.ready();
  });
  afterAll(() => app.close());

  it("pins the internal routes to the worker's control address", () => {
    expect(PEERS).toEqual(["172.30.2.20"]);
  });

  it("refuses the secret routes from every edge hop, even with the channel token", async () => {
    const authorization = `Bearer ${internalChannelToken(testRing())}`;
    for (const peer of [TRAEFIK, CLOUDFLARED, WEB]) {
      for (const url of ["/internal/secrets/open", "/internal/secrets/seal", "/internal/secrets/escrow"]) {
        const res = await app.inject({ method: "POST", url, remoteAddress: peer, headers: { authorization, "x-forwarded-for": CLIENT, "cf-connecting-ip": CLIENT }, payload: {} });
        expect(res.statusCode, `${peer} ${url}`).toBe(403);
      }
    }
  });

  it("answers a token call on the api prefix from Traefik like any other caller", async () => {
    // No database here: a bearer on a route that takes none is refused before any lookup, which
    // shows the request reached the api's own policy check rather than the web.
    const res = await app.inject({ method: "GET", url: "/api/v1/projects/demo/env", remoteAddress: TRAEFIK, headers: { authorization: "Bearer abc", "x-forwarded-for": CLIENT } });
    expect(res.statusCode).toBe(403);
  });
});
