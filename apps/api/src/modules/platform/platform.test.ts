import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { endpoints, type EndpointId } from "@dockify/contracts";
import { hashToken } from "@dockify/crypto";
import type { ActivityLog } from "@dockify/db";
import { buildApp, type Ctx } from "../../app.ts";
import { NO_PEOPLE, peopleOf } from "../../actor-view.ts";
import { HttpError } from "../../errors.ts";
import { describePolicy, POLICIES } from "../../policy.ts";
import { RateLimits } from "../../ratelimit.ts";
import { noDb, testConfig, testRing } from "../../test-helpers.ts";
import { afterCursor, decodeCursor, encodeCursor, parseChanges, toEvent } from "./activity.ts";
import { platformHandlers } from "./index.ts";
import { toPoints } from "./server.ts";
import { auth as A } from "@dockify/contracts";
import { planSettings } from "./settings.ts";

const { DEFAULT_NOTIFY, notifyEvents } = A;
import { loadPlatformEnv } from "./shared.ts";
import { canInvite, inviteUrl, planTeamChanges, teamHandlers, type MemberRef } from "./team.ts";
import { expiryFrom, mintApiToken, scopeAllowed, SHOWN_PREFIX_LEN, tokenHandlers } from "./tokens.ts";
import { storedFeed as storedRelease } from "./updates/handlers.ts";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const members: MemberRef[] = [
  { userId: U(1), name: "Olive", role: "admin" },
  { userId: U(2), name: "Adam", role: "admin" },
  { userId: U(3), name: "Vera", role: "viewer" },
];
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as HttpError).code;
  }
  return null;
};

describe("team changes", () => {
  it("applies role changes and removals in one plan", () => {
    const p = planTeamChanges(members, [{ id: U(2), role: "viewer" }, { id: U(3), remove: true }], U(1));
    expect(p.roles).toEqual([{ userId: U(2), name: "Adam", from: "admin", to: "viewer" }]);
    expect(p.removals.map((r) => r.userId)).toEqual([U(3)]);
  });
  it("keeps at least one admin, counting the whole batch", () => {
    // Olive is the only admin once Adam is a viewer: she cannot demote herself, nor be removed.
    const solo: MemberRef[] = [members[0]!, { ...members[1]!, role: "viewer" }, members[2]!];
    expect(code(() => planTeamChanges(solo, [{ id: U(1), role: "viewer" }], U(1)))).toBe("LAST_ADMIN");
    expect(code(() => planTeamChanges(solo, [{ id: U(1), remove: true }], U(2)))).toBe("LAST_ADMIN");
    expect(code(() => planTeamChanges(members, [{ id: U(1), role: "viewer" }, { id: U(2), remove: true }], U(3)))).toBe("LAST_ADMIN");
    // With a second admin in the same batch, the demotion goes through.
    const p = planTeamChanges(solo, [{ id: U(2), role: "admin" }, { id: U(1), role: "viewer" }], U(1));
    expect(p.roles).toHaveLength(2);
    expect(planTeamChanges(members, [{ id: U(1), role: "viewer" }], U(1)).roles).toHaveLength(1);
  });
  it("refuses self removal, unknown members and duplicates", () => {
    expect(code(() => planTeamChanges(members, [{ id: U(1), remove: true }], U(1)))).toBe("SELF_REMOVE");
    expect(code(() => planTeamChanges(members, [{ id: U(9), role: "viewer" }], U(1)))).toBe("MEMBER_NOT_FOUND");
    expect(code(() => planTeamChanges(members, [{ id: U(2), role: "viewer" }, { id: U(2), remove: true }], U(1)))).toBe("DUPLICATE_MEMBER");
  });
  it("lets an admin approve or withdraw a member's GitHub login, only once it is linked", () => {
    const linked: MemberRef[] = [{ userId: U(1), name: "A", role: "admin" }, { userId: U(2), name: "B", role: "viewer", githubLogin: "bee", githubVerified: false }];
    expect(planTeamChanges(linked, [{ id: U(2), githubVerified: true }], U(1)).github).toEqual([{ userId: U(2), name: "B", login: "bee", from: false, verified: true }]);
    // No change, no row.
    expect(planTeamChanges(linked, [{ id: U(2), githubVerified: false }], U(1)).github).toEqual([]);
    expect(code(() => planTeamChanges(linked, [{ id: U(1), githubVerified: true }], U(1)))).toBe("NO_GITHUB_LOGIN");
  });
  it("team.change removes another member's GitHub link, verified or not, under step-up, with an audit row", async () => {
    expect(POLICIES["team.change"]).toEqual({ access: "elevated", role: "admin" });
    const users = [
      { id: U(1), name: "Olive", githubLogin: "olive", githubVerifiedAt: new Date() },
      { id: U(2), name: "Adam", githubLogin: "adam", githubVerifiedAt: new Date() },
      { id: U(3), name: "Vera", githubLogin: "vera", githubVerifiedAt: null },
    ];
    const audit: Array<Record<string, unknown>> = [];
    const tx = {
      $executeRaw: async () => 0,
      member: { findMany: async () => users.map((u, i) => ({ userId: u.id, role: i < 2 ? "admin" : "viewer", user: u })) },
      user: { update: async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(users.find((u) => u.id === where.id)!, data) },
      activityLog: { create: async ({ data }: { data: Record<string, unknown> }) => audit.push(data) },
      invite: { findMany: async () => [] },
    };
    const team = () => users.map((u, i) => ({ userId: u.id, role: i < 2 ? "admin" : "viewer", joinedAt: new Date(), user: { ...u, email: `${u.name}@x.dev`, avatarUrl: null } }));
    const db = { ...tx, member: { findMany: async () => team() }, $transaction: async (fn: (t: unknown) => unknown) => fn(tx) };
    const ctx = { db, ring: testRing(), config: testConfig(), web: { origin: "https://dockify.test", secure: true }, limits: new RateLimits() } as unknown as Ctx;
    const actor = { kind: "session", userId: U(1), name: "Olive", role: "admin", sessionId: "s", elevated: true };
    const call = teamHandlers["team.change"] as unknown as (i: unknown) => Promise<{ members: Array<{ id: string; githubLogin: string | null; githubVerified: boolean }> }>;
    const out = await call({ body: { changes: [{ id: U(2), githubLogin: null }, { id: U(3), githubLogin: null }] }, actor, req: { clientIp: "203.0.113.9", headers: {} }, ctx });
    expect(out.members.find((m) => m.id === U(2))).toMatchObject({ githubLogin: null, githubVerified: false });
    expect(users.map((u) => u.githubLogin)).toEqual(["olive", null, null]);
    expect(audit.map((r) => [r.action, r.targetId, r.suffix])).toEqual([
      ["team.github.unlink", U(2), "(adam)"],
      ["team.github.unlink", U(3), "(vera, unverified)"],
    ]);
    // A member with nothing linked is a no-op, not an error.
    expect(planTeamChanges([{ userId: U(4), name: "N", role: "admin" }], [{ id: U(4), githubLogin: null }], U(4)).unlinks).toEqual([]);
  });
  it("never invites above the inviter's own role", () => {
    expect(canInvite("admin", "admin")).toBe(true);
    expect(canInvite("admin", "viewer")).toBe(true);
    expect(canInvite("viewer", "admin")).toBe(false);
    expect(canInvite("viewer", "viewer")).toBe(true);
  });
  it("builds the copy-paste invite link on the public origin", () => {
    expect(inviteUrl("https://dock.example.com/", "tok")).toBe("https://dock.example.com/invite/tok");
  });
});

describe("API tokens", () => {
  it("mints a prefixed secret, stores only its hash and shows only a short prefix", () => {
    const t = mintApiToken();
    expect(t.secret).toMatch(/^dk_[A-Za-z0-9_-]{43}$/);
    expect(t.hash).toBe(hashToken(t.secret));
    expect(t.hash).not.toContain(t.secret);
    expect(t.prefix).toHaveLength(SHOWN_PREFIX_LEN);
    expect(mintApiToken().secret).not.toBe(t.secret);
  });
  it("caps the scope by the creator's role", () => {
    expect(scopeAllowed("viewer", "read")).toBe(true);
    expect(scopeAllowed("viewer", "deploy")).toBe(false);
    expect(scopeAllowed("admin", "admin")).toBe(true);
  });
  it("computes expiry, or none", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(expiryFrom(now, 30)?.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(expiryFrom(now, null)).toBeNull();
  });
  it("refuses a scope above the role in plain English (never 'a admin')", async () => {
    const viewer = { kind: "session", userId: U(3), name: "Vera", role: "viewer", sessionId: "s3", elevated: true };
    const h = tokenHandlers["tokens.create"] as (i: unknown) => Promise<unknown>;
    const msg = (scope: string) =>
      h({ body: { name: "ci", scope, projects: "all", expiresInDays: 30 }, actor: viewer, req: { clientIp: "203.0.113.9", headers: {} }, ctx: {} }).then(
        () => null,
        (e: unknown) => (e as HttpError).message,
      );
    expect(await msg("admin")).toBe("Your role cannot create an admin token");
    expect(await msg("deploy")).toBe("Your role cannot create a deploy token");
  });
});

describe("activity cursor", () => {
  const row = { at: new Date("2026-10-30T10:00:00.123Z"), id: U(7) };
  it("round trips and fits the contract's cursor alphabet", () => {
    const c = encodeCursor(row);
    expect(c).toMatch(/^[\w.:~=-]+$/);
    expect(decodeCursor(c)).toEqual(row);
  });
  it("rejects forged cursors with a 400", () => {
    for (const bad of ["abc", "1~not-a-uuid", `x~${U(1)}`, `1~${U(1)}~2`, `~${U(1)}`]) expect(code(() => decodeCursor(bad)), bad).toBe("INVALID_CURSOR");
  });
  it("pages strictly after the cursor row, ties broken by id", () => {
    expect(afterCursor(row)).toEqual({ OR: [{ at: { lt: row.at } }, { at: row.at, id: { lt: row.id } }] });
  });
  it("maps rows to events: system rows have no actor, failures are bad, changes parsed", () => {
    const base: ActivityLog = {
      id: U(1), at: row.at, category: "access", action: "token.use", actorType: "token", actorId: U(5), actorName: "ci",
      verb: "used API token", targetType: "route", targetId: null, targetLabel: "apps.deploy", targetHref: null, suffix: null,
      failed: true, ip: "203.0.113.9", userAgent: null, gitAuthor: null, changes: [{ key: "role", before: "admin", after: null }, { nope: 1 }],
    };
    const e = toEvent(base, NO_PEOPLE);
    expect(e.actor).toEqual({ id: U(5), name: "ci", avatarUrl: null, kind: "token" });
    const person = toEvent({ ...base, actorType: "user", actorId: U(6), actorName: "Sam" }, peopleOf([{ id: U(6), name: "Sam", avatarUrl: "data:image/png;base64,AAAA", githubLogin: "sam", githubVerifiedAt: new Date() }]));
    expect(person.actor).toEqual({ id: U(6), name: "Sam", avatarUrl: "data:image/png;base64,AAAA", kind: "user" });
    expect(e.tone).toBe("bad");
    expect(e.changes).toEqual([{ key: "role", before: "admin", after: null }]);
    expect(toEvent({ ...base, actorType: "system", failed: false, changes: null }, NO_PEOPLE).actor).toBeNull();
    const sam = peopleOf([{ id: U(6), name: "Sam", avatarUrl: null, githubLogin: "sam", githubVerifiedAt: new Date() }]);
    const push = { ...base, actorType: "webhook" as const, actorId: null, actorName: "GitHub", failed: false };
    expect(toEvent({ ...push, gitAuthor: "sam" }, sam).actor).toEqual({ id: U(6), name: "Sam", avatarUrl: null, kind: "user" });
    expect(toEvent({ ...push, gitAuthor: "someone-else" }, sam).actor).toBeNull();
    expect(parseChanges("x")).toBeUndefined();
  });
});

describe("settings", () => {
  const row = { name: "Box", publicUrl: "https://dockify.test", defaultBranch: "main", buildConcurrency: 1, logRetentionDays: 30, notifyEvents: {}, previewDomain: null as string | null, terminalEnabled: true };
  it("defaults every notification on and ignores junk", () => {
    expect(notifyEvents(null)).toEqual(DEFAULT_NOTIFY);
    expect(notifyEvents({ appDown: false, extra: true, tlsExpiring: "no" })).toEqual({ ...DEFAULT_NOTIFY, appDown: false });
  });
  it("diffs only real changes", () => {
    const p = planSettings(row, { instanceName: "Box", buildConcurrency: 2, notifications: { events: { appDown: false } } }, "https://dockify.test");
    expect(p.changes.map((c) => c.key)).toEqual(["buildConcurrency", "notify.appDown"]);
    expect(p.data).toMatchObject({ buildConcurrency: 2 });
  });
  it("refuses a public URL that differs from DOCKIFY_PUBLIC_URL", () => {
    expect(code(() => planSettings(row, { publicUrl: "https://other.test" }, "https://dockify.test"))).toBe("PUBLIC_URL_FROM_ENV");
    expect(planSettings(row, { publicUrl: "https://dockify.test/" }, "https://dockify.test").changes).toEqual([]);
  });
});

describe("server metrics", () => {
  it("turns cumulative tx counters into Mbps and clamps a counter reset to 0", () => {
    const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
    const pts = toPoints([
      { at: t(0), cpuPct: 12.34, memoryBytes: 512n, diskBytes: 250n, netTxBytes: 0n },
      { at: t(10), cpuPct: 50, memoryBytes: 1024n, diskBytes: 500n, netTxBytes: 12_500_000n },
      { at: t(20), cpuPct: 50, memoryBytes: 1024n, diskBytes: null, netTxBytes: 0n },
    ], { memoryBytes: 2048, diskBytes: 1000 });
    expect(pts.map((p) => p.network)).toEqual([0, 10, 0]);
    expect(pts[0]).toMatchObject({ cpu: 12.3, memory: 25, disk: 25 });
    expect(pts[2]?.disk).toBe(0);
  });
});

describe("stored release", () => {
  it("accepts only a full verified manifest", () => {
    expect(storedRelease(null)).toBeNull();
    expect(storedRelease({ version: "1.0.0" })).toBeNull();
  });
});

describe("platform routes", () => {
  it("registers every platform route with its contract path and the policy table's policy", async () => {
    const { app, routes } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), logger: false });
    await app.ready();
    for (const id of Object.keys(platformHandlers(loadPlatformEnv({}))) as EndpointId[]) {
      const r = routes.find((x) => x.url === endpoints[id].path && x.method === endpoints[id].method);
      expect(r?.policy, id).toBe(describePolicy(POLICIES[id]));
    }
    await app.close();
  });

  it("is reachable only through the policy hook: no session is a 401, a token cannot mint tokens", async () => {
    const { app } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), handlers: platformHandlers(loadPlatformEnv({})), logger: false });
    const anon = await app.inject({ method: "GET", url: "/api/v1/tokens" });
    expect(anon.statusCode).toBe(401);
    const viaToken = await app.inject({
      method: "POST", url: "/api/v1/tokens", headers: { authorization: "Bearer dk_x" },
      payload: { name: "ci", scope: "admin", expiresInDays: 30 },
    });
    expect(viaToken.statusCode).toBe(403);
    const audit = await app.inject({ method: "GET", url: "/api/v1/activity", headers: { authorization: "Bearer dk_x" } });
    expect(audit.statusCode).toBe(403);
    await app.close();
  });
});

describe("deploy images", () => {
  it("pins every image in the production compose and the Dockerfile by digest", async () => {
    const { readFile } = await import("node:fs/promises");
    const root = new URL("../../../../../", import.meta.url);
    const compose = await readFile(new URL("deploy/docker-compose.yml", root), "utf8");
    const images = [...compose.matchAll(/^\s+image:\s*(?:&\w+\s+)?(\S+)/gm)].map((m) => m[1] ?? "");
    expect(images.length).toBeGreaterThan(5);
    for (const img of images) {
      if (img.startsWith("*")) continue;
      expect(img.startsWith("${DOCKIFY_") || /@sha256:[a-f0-9]{64}$/.test(img), img).toBe(true);
    }
    const dockerfile = await readFile(new URL("deploy/Dockerfile", root), "utf8");
    expect(dockerfile).toMatch(/ARG NODE_IMAGE=\S+@sha256:[a-f0-9]{64}/);
    for (const m of dockerfile.matchAll(/^FROM (\S+)/gm)) expect(m[1], m[1]).toMatch(/^\$\{NODE_IMAGE\}|^[a-z-]+$/);
  });
});
