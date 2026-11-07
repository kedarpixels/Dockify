/**
 * The authorization core: enforce() applies a route's policy to a request, and checkInternal()
 * authenticates the worker on the control routes. policy.test.ts exercises the session and
 * anonymous paths at the HTTP level; this file unit-tests the token ladder (scope, grant, the
 * owner-role cap, revoked and expired tokens) and the internal channel, none of which that suite
 * reaches, plus the two small header/peer parsers enforce() is built on.
 */
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import type { Db } from "@dockify/db";
import { checkInternal, enforce, peerAddress, readBearer, type InternalAuth } from "./actor.ts";
import { HttpError } from "./errors.ts";
import type { Policy } from "./policy.ts";

const web = { origin: "https://dockify.test", secure: false };
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const now = new Date(NOW);

const req = (headers: Record<string, string | string[] | undefined>, remoteAddress?: string): FastifyRequest =>
  ({ headers, socket: { remoteAddress } }) as unknown as FastifyRequest;
const bearer = (token: string): FastifyRequest => req({ authorization: `Bearer ${token}` });

/** A policy literal, so the ladder is tested independently of the real POLICIES table. */
const policy = (p: Policy): Policy => p;

// ---- token rows and a db that returns one ----

interface TokenOver {
  scope?: "read" | "deploy" | "admin";
  role?: "viewer" | "admin";
  allProjects?: boolean;
  projects?: Array<{ projectId: string }>;
  grants?: string[];
  revokedAt?: Date | null;
  expiresAt?: Date | null;
  disabledAt?: Date | null;
  member?: unknown;
}
const tokenRow = (o: TokenOver = {}) => ({
  id: "tok-1",
  name: "ci-token",
  scope: o.scope ?? "admin",
  allProjects: o.allProjects ?? true,
  projects: o.projects ?? [],
  grants: o.grants ?? [],
  revokedAt: o.revokedAt ?? null,
  expiresAt: o.expiresAt ?? null,
  user: { name: "Owner", disabledAt: o.disabledAt ?? null, member: "member" in o ? o.member : { role: o.role ?? "admin" } },
});
const tokenDb = (row: unknown): Db => ({ apiToken: { findUnique: async () => row } }) as unknown as Db;

const sessionRow = (o: { role?: "viewer" | "admin"; elevatedUntil?: Date | null; revokedAt?: Date | null; disabledAt?: Date | null; member?: unknown } = {}) => ({
  id: "sess-1",
  userId: "u1",
  revokedAt: o.revokedAt ?? null,
  expiresAt: new Date(NOW + 3_600_000),
  absoluteExpiresAt: new Date(NOW + 10 * 24 * 3_600_000),
  lastSeenAt: new Date(NOW),
  elevatedUntil: o.elevatedUntil ?? null,
  user: { name: "Admin", disabledAt: o.disabledAt ?? null, member: "member" in o ? o.member : { role: o.role ?? "admin" } },
});
const sessionDb = (row: unknown): Db => ({ session: { findUnique: async () => row, update: async () => row } }) as unknown as Db;
const withCookie = (token = "sometoken") => req({ cookie: `dockify_sid=${token}` });

/** Capture a synchronous HttpError for inspecting its code. */
const caught = (fn: () => unknown): HttpError => {
  try {
    fn();
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("expected a throw");
};

describe("readBearer", () => {
  it("reads the token after a case-insensitive Bearer scheme with any blank run", () => {
    expect(readBearer(req({ authorization: "Bearer abc123" }))).toBe("abc123");
    expect(readBearer(req({ authorization: "bearer\tabc123" }))).toBe("abc123");
    expect(readBearer(req({ authorization: "  BEARER   abc123  " }))).toBe("abc123");
  });
  it("is null when the header is missing, not a string, or not a Bearer token", () => {
    expect(readBearer(req({}))).toBeNull();
    expect(readBearer(req({ authorization: ["Bearer a", "Bearer b"] }))).toBeNull();
    expect(readBearer(req({ authorization: "Basic abc" }))).toBeNull();
    expect(readBearer(req({ authorization: "Bearerabc" }))).toBeNull();
    expect(readBearer(req({ authorization: "Bearer " }))).toBeNull();
  });
  it("rejects a value containing embedded whitespace as malformed (the pattern is fully anchored)", () => {
    expect(readBearer(req({ authorization: "Bearer abc def" }))).toBeNull();
  });
});

describe("peerAddress", () => {
  it("strips the IPv4-mapped prefix and tolerates an absent peer", () => {
    expect(peerAddress("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(peerAddress("::FFFF:172.18.0.3")).toBe("172.18.0.3");
    expect(peerAddress("172.18.0.3")).toBe("172.18.0.3");
    expect(peerAddress(undefined)).toBe("");
  });
});

describe("checkInternal", () => {
  const auth: InternalAuth = { token: "channel-secret", peers: [] };
  it("refuses when internal auth is not configured", () => {
    expect(caught(() => checkInternal(bearer("channel-secret"), undefined)).status).toBe(401);
  });
  it("refuses a missing or wrong channel token", () => {
    expect(caught(() => checkInternal(req({}), auth)).code).toBe("UNAUTHENTICATED");
    expect(caught(() => checkInternal(bearer("wrong"), auth)).code).toBe("UNAUTHENTICATED");
  });
  it("accepts the right token from any peer when no peer list is pinned", () => {
    expect(() => checkInternal(bearer("channel-secret"), auth)).not.toThrow();
  });
  it("enforces the pinned peer list (IPv4-mapped form compared stripped)", () => {
    const pinned: InternalAuth = { token: "channel-secret", peers: ["172.18.0.9"] };
    expect(() => checkInternal(req({ authorization: "Bearer channel-secret" }, "::ffff:172.18.0.9"), pinned)).not.toThrow();
    expect(caught(() => checkInternal(req({ authorization: "Bearer channel-secret" }, "172.18.0.8"), pinned)).code).toBe("FORBIDDEN");
  });
});

describe("enforce: access kinds", () => {
  it("returns null for an anonymous route without touching the db or any credential", async () => {
    await expect(enforce(undefined as unknown as Db, bearer("anything"), web, policy({ access: "anonymous", role: "viewer" }), now)).resolves.toBeNull();
  });
  it("delegates an internal route to the channel check and returns null", async () => {
    const internal: InternalAuth = { token: "chan", peers: [] };
    await expect(enforce(undefined as unknown as Db, bearer("chan"), web, policy({ access: "internal", role: "admin" }), now, internal)).resolves.toBeNull();
    await expect(enforce(undefined as unknown as Db, bearer("nope"), web, policy({ access: "internal", role: "admin" }), now, internal)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

describe("enforce: token ladder", () => {
  const route = (over: Partial<Policy> = {}): Policy => ({ access: "session", role: "viewer", token: "read", ...over });

  it("refuses a bearer on a route that accepts no token, before any db lookup", async () => {
    await expect(enforce(tokenDb(tokenRow()), bearer("t"), web, policy({ access: "session", role: "admin" }), now)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });
  it("refuses a token whose scope is below the route's", async () => {
    await expect(enforce(tokenDb(tokenRow({ scope: "read" })), bearer("t"), web, policy(route({ role: "admin", token: "deploy" })), now)).rejects.toMatchObject({ code: "TOKEN_SCOPE" });
  });
  it("accepts a token whose scope meets or exceeds the route's", async () => {
    const actor = await enforce(tokenDb(tokenRow({ scope: "admin" })), bearer("t"), web, policy(route({ role: "admin", token: "deploy" })), now);
    expect(actor).toMatchObject({ kind: "token", scope: "admin", elevated: false });
  });
  it("requires the explicit grant when the route names one", async () => {
    const envPut = policy({ access: "elevated", role: "admin", token: "admin", grant: "env:write" });
    await expect(enforce(tokenDb(tokenRow({ scope: "admin", grants: [] })), bearer("t"), web, envPut, now)).rejects.toMatchObject({ code: "TOKEN_GRANT" });
    const actor = await enforce(tokenDb(tokenRow({ scope: "admin", grants: ["env:write"] })), bearer("t"), web, envPut, now);
    expect(actor).toMatchObject({ kind: "token", grants: ["env:write"] });
  });
  it("passes a granted token through an elevated route without any step-up (tokens are never elevated)", async () => {
    const envPut = policy({ access: "elevated", role: "admin", token: "admin", grant: "env:write" });
    const actor = await enforce(tokenDb(tokenRow({ scope: "admin", grants: ["env:write"] })), bearer("t"), web, envPut, now);
    expect(actor?.elevated).toBe(false);
  });
  it("caps a token at its owner's role: a viewer holding an admin-scoped token is still only a viewer", async () => {
    // min(owner viewer, scope admin) = viewer, so an admin-role route refuses it.
    await expect(enforce(tokenDb(tokenRow({ role: "viewer", scope: "admin" })), bearer("t"), web, policy(route({ role: "admin", token: "read" })), now)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    const actor = await enforce(tokenDb(tokenRow({ role: "viewer", scope: "admin" })), bearer("t"), web, policy(route()), now);
    expect(actor).toMatchObject({ role: "viewer" });
  });
  it("rejects a revoked token, a disabled owner and a member-less owner as unauthenticated", async () => {
    for (const over of [{ revokedAt: new Date(NOW - 1) }, { disabledAt: new Date(NOW - 1) }, { member: null }]) {
      await expect(enforce(tokenDb(tokenRow(over)), bearer("t"), web, policy(route()), now)).rejects.toMatchObject({ status: 401 });
    }
  });
  it("rejects an expired token with its own code", async () => {
    await expect(enforce(tokenDb(tokenRow({ expiresAt: new Date(NOW - 1) })), bearer("t"), web, policy(route()), now)).rejects.toMatchObject({ status: 401, code: "TOKEN_EXPIRED" });
  });
  it("keeps only recognised grants off the token row", async () => {
    const actor = await enforce(tokenDb(tokenRow({ scope: "admin", grants: ["env:write", "not-a-grant"] })), bearer("t"), web, policy(route()), now);
    expect(actor).toMatchObject({ grants: ["env:write"] });
  });
});

describe("enforce: session ladder", () => {
  const elevatedRoute = policy({ access: "elevated", role: "admin" });
  it("is unauthenticated with no session cookie", async () => {
    await expect(enforce(sessionDb(null), req({}), web, policy({ access: "session", role: "viewer" }), now)).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
  });
  it("refuses a role below the route's", async () => {
    await expect(enforce(sessionDb(sessionRow({ role: "viewer" })), withCookie(), web, policy({ access: "session", role: "admin" }), now)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });
  it("demands a fresh step-up window for an elevated route", async () => {
    await expect(enforce(sessionDb(sessionRow({ role: "admin", elevatedUntil: null })), withCookie(), web, elevatedRoute, now)).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    await expect(enforce(sessionDb(sessionRow({ role: "admin", elevatedUntil: new Date(NOW - 1) })), withCookie(), web, elevatedRoute, now)).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
  });
  it("accepts an elevated admin inside the step-up window", async () => {
    const actor = await enforce(sessionDb(sessionRow({ role: "admin", elevatedUntil: new Date(NOW + 60_000) })), withCookie(), web, elevatedRoute, now);
    expect(actor).toMatchObject({ kind: "session", role: "admin", elevated: true });
  });
});
