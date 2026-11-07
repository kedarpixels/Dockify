/**
 * Regression tests from a security review: client address
 * and rate-limit buckets, token project limits, server.get scoping, SSE reauthorization and the
 * Vercel import's secret gate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "./actor.ts";
import { tokensLimitedOnlyTo } from "./actor.ts";
import { AUTH_LIMITED, buildApp, type Handlers } from "./app.ts";
import { createClientResolver } from "./client-ip.ts";
import { createReauthorizer } from "./reauth.ts";
import { snapshotView } from "./modules/platform/server.ts";
import { importableHosts, importChanges, importGate } from "./modules/integrations/vercel.ts";
import { reservedHosts } from "./modules/domains/logic.ts";
import { noDb, testConfig, testRing } from "./test-helpers.ts";

const PROXY = "10.9.9.9";
const session = (elevated: boolean): Actor => ({ kind: "session", userId: "u", name: "Admin", role: "admin", sessionId: "s", elevated });
const token = (projectIds: string[]): Actor => ({ kind: "token", userId: "u", name: "ci", role: "admin", tokenId: "t", scope: "admin", allProjects: false, projectIds, grants: [], elevated: false });

describe("client resolver", () => {
  const r = createClientResolver([PROXY], "direct_tls");

  it("marks a trusted peer that forwards nothing as unknown", () => {
    expect(r(PROXY, {})).toEqual({ ip: PROXY, known: false });
    expect(r(PROXY, { "x-forwarded-for": "garbage" })).toEqual({ ip: PROXY, known: false });
  });

  it("knows the client when the proxy forwards it, or when the peer is the client", () => {
    expect(r(PROXY, { "x-forwarded-for": "203.0.113.4" })).toEqual({ ip: "203.0.113.4", known: true });
    expect(r("198.51.100.8", {})).toEqual({ ip: "198.51.100.8", known: true });
  });

  it("takes the first hop when every hop is trusted (a browser on the proxy's own host)", () => {
    expect(r(PROXY, { "x-forwarded-for": PROXY })).toEqual({ ip: PROXY, known: true });
  });
});

describe("rate-limit buckets behind the web container", () => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  const handlers: Handlers = { "public.status": (async () => ({ project: { name: "x" } })) as unknown as never };

  beforeAll(async () => {
    ({ app } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig({ trustedProxies: [PROXY] }), logger: false, handlers, integrations: false }));
    await app.ready();
  });
  afterAll(() => app.close());

  const get = (url: string, xff?: string) =>
    app.inject({ method: "GET", url, remoteAddress: PROXY, headers: xff ? { "x-forwarded-for": xff } : {} });

  it("refuses a signed-in route when the proxy reports no client address, instead of sharing its bucket", async () => {
    const res = await get("/api/v1/overview");
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("CLIENT_ADDRESS_MISSING");
  });

  it("an anonymous flood from one address cannot 429 another client", async () => {
    let limited = false;
    for (let i = 0; i < 200 && !limited; i++) limited = (await get("/api/v1/overview", "203.0.113.50")).statusCode === 429;
    expect(limited).toBe(true);
    expect((await get("/api/v1/overview", "198.51.100.60")).statusCode).toBe(401);
  });

  it("anonymous routes drain their own bucket, never the signed-in one", async () => {
    let limited = false;
    for (let i = 0; i < 200 && !limited; i++) limited = (await get("/api/v1/public/status/demo", "203.0.113.70")).statusCode === 429;
    expect(limited).toBe(true);
    // The same address still reaches a signed-in route (401: no cookie), not 429.
    expect((await get("/api/v1/overview", "203.0.113.70")).statusCode).toBe(401);
  });

  it("step-up is not in the per-IP auth bucket, so one session cannot lock everyone out", async () => {
    expect(AUTH_LIMITED.has("auth.stepUp")).toBe(false);
    for (let i = 0; i < 15; i++) {
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/step-up", remoteAddress: PROXY, headers: { "x-forwarded-for": "203.0.113.90" }, payload: { code: "000000" } });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("project-limited API tokens", () => {
  it("revokes a token whose only project is being deleted, never one with others left or an unlimited one", () => {
    const tokens = [
      { id: "only", allProjects: false, projects: [{ projectId: "p1" }] },
      { id: "two", allProjects: false, projects: [{ projectId: "p1" }, { projectId: "p2" }] },
      { id: "all", allProjects: true, projects: [] },
    ];
    expect(tokensLimitedOnlyTo(tokens, "p1")).toEqual(["only"]);
  });
});

describe("server.get scoping", () => {
  it("limits a project-scoped token to its own apps and hides host identity from every token", () => {
    expect(snapshotView(token(["p1"]))).toEqual({ appWhere: { environment: { projectId: { in: ["p1"] } } }, hostDetails: false });
    // No project rows is a token that reaches nothing; "every project" is a column, chosen at creation.
    expect(snapshotView(token([]))).toEqual({ appWhere: { environment: { projectId: { in: [] } } }, hostDetails: false });
    expect(snapshotView({ ...token([]), allProjects: true } as Actor)).toEqual({ appWhere: {}, hostDetails: false });
    expect(snapshotView(session(false))).toEqual({ appWhere: {}, hostDetails: true });
  });
});

describe("SSE reauthorization", () => {
  it("re-runs the policy once per interval and stays closed after the first refusal", async () => {
    let ok = true;
    let calls = 0;
    const allowed = createReauthorizer(async () => {
      calls++;
      if (!ok) throw new Error("revoked");
    }, 1_000, 0);
    expect(await allowed(500)).toBe(true);
    expect(calls).toBe(0);
    expect(await allowed(1_500)).toBe(true);
    expect(calls).toBe(1);
    ok = false;
    expect(await allowed(1_600)).toBe(true); // inside the interval
    expect(await allowed(2_600)).toBe(false);
    ok = true;
    expect(await allowed(9_000)).toBe(false);
  });
});

describe("Vercel import", () => {
  const env = { id: "env-1", name: "production" };

  it("needs a step-up for the secret write and refuses tokens outright", () => {
    expect(() => importGate(session(false))(true)).toThrow(/step_up_required/);
    expect(() => importGate(token([]))(true)).toThrow(/API tokens cannot change secrets/);
    expect(() => importGate(session(true))(true)).not.toThrow();
  });

  it("plans adds and changes for the versioned store, skipping values already set", () => {
    const stored = new Map([
      ["environment:env-1:DATABASE_URL", { value: "old" }],
      ["environment:env-1:SAME", { value: "same" }],
    ]);
    const changes = importChanges([{ key: "DATABASE_URL", value: "new" }, { key: "SAME", value: "same" }, { key: "NEW_KEY", value: "v" }], stored, env);
    expect(changes).toEqual([
      { scope: "environment", scopeId: "env-1", environment: "production", key: "DATABASE_URL", op: "change", value: "new" },
      { scope: "environment", scopeId: "env-1", environment: "production", key: "NEW_KEY", op: "add", value: "v", secret: true },
    ]);
  });

  it("drops reserved hostnames, not only the dashboard's own", () => {
    const reserved = reservedHosts(new URL("https://dockify.example.com"), "admin.example.com");
    expect(importableHosts(["shop.com", "Dockify.example.com", "admin.example.com", "shop.com"], reserved)).toEqual(["shop.com"]);
  });
});
