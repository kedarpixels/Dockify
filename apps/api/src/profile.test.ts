/**
 * Settings, Profile: time and email preferences, the linked GitHub login, and the security mail
 * those preferences gate. Handlers run against an in-memory fake; nothing touches a database.
 */
import { describe, expect, it, vi } from "vitest";
import { auth, endpoints } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import type { Actor } from "./actor.ts";
import type { Ctx } from "./app.ts";
import { HttpError } from "./errors.ts";
import { POLICIES } from "./policy.ts";
import { RateLimits } from "./ratelimit.ts";
import { accountHandlers, checkAvatar } from "./routes/account.ts";
import { isNewDevice, sendSecurityNotice, wantsSecurityMail } from "./security-notice.ts";
import { testConfig, testRing } from "./test-helpers.ts";

type Row = Record<string, unknown>;
const call = <T>(h: unknown, input: Record<string, unknown>): Promise<T> => (h as (i: unknown) => Promise<T>)(input);
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Mac OS X) Chrome/130.0";
const req = (ua = CHROME_MAC) => ({ clientIp: "203.0.113.9", headers: { "user-agent": ua }, log: { error: vi.fn() } });
const as = (role: "admin" | "viewer", userId = "u1"): Actor => ({ kind: "session", userId, name: "Sam", role, sessionId: "s1", elevated: false });

function user(over: Row = {}): Row {
  return {
    id: "u1", email: "sam@example.com", name: "Sam", avatarUrl: null, totpConfirmedAt: null, emailVerifiedAt: null, disabledAt: null,
    githubLogin: null, githubVerifiedAt: null, timeZone: null, hour12: false, emailDeployFailed: true, emailSecurity: true, member: { role: "admin" }, ...over,
  };
}

function fakeDb(opts: { email?: boolean; users?: Row[]; sessions?: Row[] } = {}) {
  const users = opts.users ?? [user()];
  const db = {
    users,
    audit: [] as Row[],
    jobs: [] as Row[],
    user: {
      findUnique: async ({ where }: { where: Row }) =>
        users.find((u) => (where.githubLogin !== undefined ? u.githubLogin === where.githubLogin : u.id === where.id)) ?? null,
      findUniqueOrThrow: async ({ where }: { where: Row }) => {
        const u = users.find((x) => x.id === where.id);
        if (!u) throw new Error("not found");
        return u;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        if (typeof data.githubLogin === "string" && users.some((u) => u.id !== where.id && u.githubLogin === data.githubLogin)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        const u = users.find((x) => x.id === where.id)!;
        Object.assign(u, data);
        return u;
      },
    },
    session: { findMany: async () => opts.sessions ?? [] },
    activityLog: { create: async ({ data }: { data: Row }) => db.audit.push(data) },
    integration: {
      findUnique: async () => (opts.email === false ? null : { id: "int1", kind: "email", name: "default", status: "connected", secretId: "k", config: {} }),
    },
    instance: { findUnique: async () => ({ id: 1, name: "Acme Cloud" }) },
    secret: { create: async ({ data }: { data: Row }) => ({ id: "sec", ...data }) },
    job: { create: async ({ data }: { data: Row }) => (db.jobs.push(data), { id: `job-${db.jobs.length}` }) },
    $executeRaw: async () => 0,
    $transaction: async (fn: (t: unknown) => unknown) => fn(db),
  };
  return db;
}

const ctxOf = (db: unknown): Ctx => ({ db: db as Db, ring: testRing(), config: testConfig(), web: { origin: "https://dockify.test", secure: true }, limits: new RateLimits() });

async function rejects(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("expected a rejection");
}

describe("profile writes are in the policy table", () => {
  it("lets any signed-in member change their own profile, never a token", () => {
    expect(POLICIES["me.preferences"]).toEqual({ access: "session", role: "viewer" });
    expect(POLICIES["me.github"]).toEqual({ access: "session", role: "viewer" });
    expect(endpoints["me.preferences"]).toMatchObject({ method: "PATCH", path: "/api/v1/me/preferences" });
    expect(endpoints["me.github"]).toMatchObject({ method: "PUT", path: "/api/v1/me/github" });
  });
});

describe("validation", () => {
  it("takes GitHub usernames by GitHub's rules, lowercased", () => {
    const ok = (v: string) => auth.GitHubLoginBody.safeParse({ login: v });
    expect(ok("Sam-Dev").data).toEqual({ login: "sam-dev" });
    expect(ok("a".repeat(39)).success).toBe(true);
    for (const bad of ["", "-sam", "sam-", "sa--m", "sa_m", "a".repeat(40), "sam dev", "s@m"]) expect(ok(bad).success, bad).toBe(false);
    expect(auth.GitHubLoginBody.safeParse({ login: null }).success).toBe(true);
  });
  it("takes real IANA zones or null, and refuses an empty change", () => {
    const p = (b: unknown) => auth.PreferencesBody.safeParse(b).success;
    expect(p({ timeZone: "Europe/Berlin" })).toBe(true);
    expect(p({ timeZone: "UTC", hour12: true })).toBe(true);
    expect(p({ timeZone: null })).toBe(true);
    expect(p({ timeZone: "Mars/Olympus" })).toBe(false);
    expect(p({ timeZone: "../../etc" })).toBe(false);
    expect(p({ notify: { deployFailed: false } })).toBe(true);
    expect(p({})).toBe(false);
    expect(p({ notify: {} })).toBe(false);
    expect(p({ theme: "dark" })).toBe(false);
  });
});

describe("me.preferences", () => {
  it("stores the zone, clock and email choices with one audit row naming each change", async () => {
    const db = fakeDb({ users: [user({ member: { role: "viewer" } })] });
    const me = await call<auth.Me>(accountHandlers["me.preferences"], {
      body: { timeZone: "Europe/Berlin", hour12: true, notify: { deployFailed: false, security: false } }, actor: as("viewer"), req: req(), ctx: ctxOf(db),
    });
    expect(me).toMatchObject({ timeZone: "Europe/Berlin", hour12: true, notify: { deployFailed: false, security: false } });
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({ action: "me.preferences", actorId: "u1", ip: "203.0.113.9" });
    expect((db.audit[0]!.changes as Row[]).map((c) => c.key).sort()).toEqual(["emailDeployFailed", "emailSecurity", "hour12", "timeZone"]);
  });
  it("keeps security mail on for an admin whatever the body says", async () => {
    const db = fakeDb();
    const me = await call<auth.Me>(accountHandlers["me.preferences"], { body: { notify: { security: false } }, actor: as("admin"), req: req(), ctx: ctxOf(db) });
    expect(me.notify.security).toBe(true);
    expect(db.users[0]!.emailSecurity).toBe(true);
    expect(db.audit).toHaveLength(0);
  });
  it("writes nothing when nothing changed, and null goes back to the browser zone", async () => {
    const db = fakeDb({ users: [user({ timeZone: "UTC" })] });
    await call(accountHandlers["me.preferences"], { body: { hour12: false }, actor: as("admin"), req: req(), ctx: ctxOf(db) });
    expect(db.audit).toHaveLength(0);
    const me = await call<auth.Me>(accountHandlers["me.preferences"], { body: { timeZone: null }, actor: as("admin"), req: req(), ctx: ctxOf(db) });
    expect(me.timeZone).toBeNull();
    expect(db.audit[0]!.changes).toEqual([{ key: "timeZone", before: "UTC", after: "browser" }]);
  });
});

describe("me.github", () => {
  it("links and unlinks the login with an audit row each", async () => {
    const db = fakeDb();
    const linked = await call<auth.Me>(accountHandlers["me.github"], { body: { login: "sam" }, actor: as("admin"), req: req(), ctx: ctxOf(db) });
    expect(linked.githubLogin).toBe("sam");
    const gone = await call<auth.Me>(accountHandlers["me.github"], { body: { login: null }, actor: as("admin"), req: req(), ctx: ctxOf(db) });
    expect(gone.githubLogin).toBeNull();
    expect(db.audit.map((a) => a.action)).toEqual(["me.github.link", "me.github.unlink"]);
  });
  it("refuses a login another member already linked and had verified", async () => {
    const db = fakeDb({ users: [user(), user({ id: "u2", email: "lena@example.com", githubLogin: "lena", githubVerifiedAt: new Date() })] });
    const e = await rejects(call(accountHandlers["me.github"], { body: { login: "lena" }, actor: as("admin"), req: req(), ctx: ctxOf(db) }));
    expect(e).toMatchObject({ status: 409, code: "GITHUB_TAKEN" });
    expect(db.users[0]!.githubLogin).toBeNull();
    expect(db.audit).toHaveLength(0);
  });

  it("verifies an admin's own link at once and leaves a viewer's unverified", async () => {
    const db = fakeDb({ users: [user(), user({ id: "u2", email: "lena@example.com", member: { role: "viewer" } })] });
    const mine = await call<auth.Me>(accountHandlers["me.github"], { body: { login: "sam" }, actor: as("admin"), req: req(), ctx: ctxOf(db) });
    expect(mine).toMatchObject({ githubLogin: "sam", githubVerified: true });
    const theirs = await call<auth.Me>(accountHandlers["me.github"], { body: { login: "lena" }, actor: as("viewer", "u2"), req: req(), ctx: ctxOf(db) });
    expect(theirs).toMatchObject({ githubLogin: "lena", githubVerified: false });
    expect(db.audit[1]).toMatchObject({ action: "me.github.link", suffix: "(unverified until an admin approves it)" });
  });

  it("a viewer can neither squat a login nor take one from anybody", async () => {
    const db = fakeDb({ users: [user({ githubLogin: "sam", githubVerifiedAt: new Date() }), user({ id: "u2", member: { role: "viewer" } }), user({ id: "u3", githubLogin: "tomas", member: { role: "viewer" } })] });
    for (const login of ["sam", "tomas"]) {
      const e = await rejects(call(accountHandlers["me.github"], { body: { login }, actor: as("viewer", "u2"), req: req(), ctx: ctxOf(db) }));
      expect(e).toMatchObject({ status: 409, code: "GITHUB_TAKEN" });
    }
    expect(db.users.map((u) => u.githubLogin)).toEqual(["sam", null, "tomas"]);
  });

  it("an admin takes their login back from a viewer's unverified claim, with an audit row naming the viewer", async () => {
    const db = fakeDb({ users: [user(), user({ id: "u2", name: "Lena", githubLogin: "sam", member: { role: "viewer" } })] });
    const me = await call<auth.Me>(accountHandlers["me.github"], { body: { login: "sam" }, actor: as("admin"), req: req(), ctx: ctxOf(db) });
    expect(me).toMatchObject({ githubLogin: "sam", githubVerified: true });
    expect(db.users[1]).toMatchObject({ githubLogin: null, githubVerifiedAt: null });
    expect(db.audit.map((a) => a.action)).toEqual(["team.github.reclaim", "me.github.link"]);
    expect(db.audit[0]).toMatchObject({ targetId: "u2", targetLabel: "Lena" });
  });

  it("relinking the same login never drops a verification, and an admin's relink adds one", async () => {
    const db = fakeDb({ users: [user({ githubLogin: "lena", githubVerifiedAt: new Date(), member: { role: "viewer" } })] });
    const same = await call<auth.Me>(accountHandlers["me.github"], { body: { login: "lena" }, actor: as("viewer"), req: req(), ctx: ctxOf(db) });
    expect(same.githubVerified).toBe(true);
    expect(db.audit).toHaveLength(0);
    db.users[0]!.githubVerifiedAt = null;
    expect((await call<auth.Me>(accountHandlers["me.github"], { body: { login: "lena" }, actor: as("viewer"), req: req(), ctx: ctxOf(db) })).githubVerified).toBe(false);
    expect((await call<auth.Me>(accountHandlers["me.github"], { body: { login: "lena" }, actor: as("admin"), req: req(), ctx: ctxOf(db) })).githubVerified).toBe(true);
  });
});

describe("me.patch avatar", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 64, 0, 0, 0, 64]), Buffer.alloc(8)]);
  it("keeps a picture whose bytes are the image its data URL names", () => {
    expect(() => checkAvatar(`data:image/png;base64,${PNG.toString("base64")}`)).not.toThrow();
  });
  it("refuses markup or a mismatched type behind an image prefix", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString("base64");
    for (const url of [`data:image/png;base64,${svg}`, `data:image/webp;base64,${PNG.toString("base64")}`]) {
      expect(() => checkAvatar(url)).toThrow(HttpError);
    }
  });
});

describe("security notices", () => {
  it("go to admins always and to viewers who kept them on", () => {
    expect(wantsSecurityMail({ emailSecurity: false, disabledAt: null, member: { role: "admin" } })).toBe(true);
    expect(wantsSecurityMail({ emailSecurity: true, disabledAt: null, member: { role: "viewer" } })).toBe(true);
    expect(wantsSecurityMail({ emailSecurity: false, disabledAt: null, member: { role: "viewer" } })).toBe(false);
    expect(wantsSecurityMail({ emailSecurity: true, disabledAt: new Date(), member: { role: "admin" } })).toBe(false);
    expect(wantsSecurityMail({ emailSecurity: true, disabledAt: null, member: null })).toBe(false);
  });
  it("queue one sealed message while email is on, and nothing without email or consent", async () => {
    const on = fakeDb();
    expect(await sendSecurityNotice(ctxOf(on), "u1", "password", req() as never)).toBe(true);
    expect(on.jobs).toHaveLength(1);
    expect(on.jobs[0]).toMatchObject({ kind: "email_send" });
    const off = fakeDb({ email: false });
    expect(await sendSecurityNotice(ctxOf(off), "u1", "password", req() as never)).toBe(false);
    const declined = fakeDb({ users: [user({ member: { role: "viewer" }, emailSecurity: false })] });
    expect(await sendSecurityNotice(ctxOf(declined), "u1", "mfaOff", req() as never)).toBe(false);
    expect([...off.jobs, ...declined.jobs]).toHaveLength(0);
  });
  it("treat a sign in as new only from a browser and system not seen recently", async () => {
    const known = fakeDb({ sessions: [{ userAgent: CHROME_MAC }] });
    expect(await isNewDevice(known as never, "u1", "s2", CHROME_MAC)).toBe(false);
    expect(await isNewDevice(known as never, "u1", "s2", "Mozilla/5.0 (Windows NT 10.0) Firefox/131.0")).toBe(true);
  });
});
