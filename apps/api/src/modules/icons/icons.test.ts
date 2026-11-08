import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { endpoints } from "@dockify/contracts";
import { internalChannelToken, mailIconKey, signMailIcon } from "@dockify/crypto";
import type { Actor } from "../../actor.ts";
import { buildApp, type Ctx, type Handler } from "../../app.ts";
import { describePolicy, POLICIES } from "../../policy.ts";
import { noDb, testConfig, testRing } from "../../test-helpers.ts";
import { ICON_ENDPOINTS, iconHandlers } from "./index.ts";

const APP = "0f0e0d0c-0000-4000-8000-0000000000aa";
const PROJECT = "0f0e0d0c-0000-4000-8000-0000000000cc";
const owner = { kind: "session", userId: "u", name: "Owner", role: "admin", sessionId: "s", elevated: false } as Actor;
const limitedToken = {
  kind: "token", userId: "u", name: "ci", role: "viewer", tokenId: "t", scope: "read", allProjects: false, projectIds: ["other"], grants: [], elevated: false,
} as Actor;

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface Img { id?: string; appId?: string; projectId?: string; source: "favicon" | "upload"; mime: string; data: Buffer; sha256: string; width: number; height: number; origin: string | null; updatedAt: Date }

/** A frontend of the fake project: `primary` is its primary domain (true for a custom one), `domains` its other names. */
interface Front { env: string; id: string; name?: string; displayName?: string; primary?: boolean | string; test?: boolean; domains?: string[]; born?: number; fav?: Img }
const hostOf = (f: Front) => (f.primary === true ? `${f.id}.example.com` : f.primary || null);

function fakeDb(opts: { kind?: string; choice?: "auto" | "upload"; images?: Img[]; appMissing?: boolean; frontends?: Front[]; projectChoice?: "auto" | "upload"; pick?: string | null } = {}) {
  let images = (opts.images ?? []).map((i, n) => ({ ...i, id: i.id ?? `img${n}` }));
  const app = {
    id: APP, name: "web", kind: opts.kind ?? "frontend", iconChoice: opts.choice ?? "auto",
    faviconCheckedAt: null as Date | null, faviconError: null as string | null,
    environment: { name: "production", projectId: PROJECT, project: { slug: "shop" } },
  };
  const project = { id: PROJECT, slug: "shop", iconChoice: (opts.projectChoice ?? "auto") as string, iconAppId: opts.pick ?? (null as string | null) };
  const envs = () => [...new Set((opts.frontends ?? []).map((f) => f.env))].map((name) => ({
    name,
    apps: (opts.frontends ?? []).filter((f) => f.env === name).map((f) => {
      const host = hostOf(f);
      const primaryDomain = host ? { hostname: host, testDomain: !!f.test } : null;
      return {
        id: f.id, name: f.name ?? f.id, displayName: f.displayName ?? null, createdAt: new Date(Date.UTC(2026, 0, 1) + (f.born ?? 0) * 60_000),
        primaryDomain, domains: [...(primaryDomain ? [primaryDomain] : []), ...(f.domains ?? []).map((hostname) => ({ hostname, testDomain: false }))],
        icons: f.fav ? [{ ...f.fav, id: `fav-${f.id}` }] : [],
      };
    }),
  }));
  const jobs: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const finds: Array<Record<string, unknown>> = [];
  const pick = (w: Record<string, { appId?: string; projectId?: string; source: string }>) => {
    const k = (w.appId_source ?? w.projectId_source)!;
    return images.find((i) => (k.appId ? i.appId === k.appId : i.projectId === k.projectId) && i.source === k.source);
  };
  const ofApp = () => images.filter((i) => i.appId === APP);
  const ofProject = () => images.filter((i) => i.projectId === PROJECT);
  const db = {
    $executeRaw: async () => 0,
    app: {
      findUnique: async () => (opts.appMissing ? null : { ...app, icons: ofApp() }),
      findMany: async (q: Record<string, unknown>) => { finds.push(q); return [{ ...app, icons: ofApp() }]; },
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(app, data),
    },
    project: {
      findUnique: async () => ({ ...project, icons: ofProject(), environments: envs() }),
      findMany: async () => [{ ...project, icons: ofProject(), environments: envs() }],
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(project, data),
    },
    iconImage: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const fav = (opts.frontends ?? []).find((f) => `fav-${f.id}` === where.id)?.fav;
        return images.find((i) => i.id === where.id) ?? fav ?? null;
      },
      upsert: async ({ where, create, update }: { where: Record<string, { source: string }>; create: Img; update: Partial<Img> }) => {
        const hit = pick(where);
        if (hit) Object.assign(hit, update, { updatedAt: new Date() });
        else images.push({ ...create, id: `img${images.length + 9}`, updatedAt: new Date() });
      },
      deleteMany: async ({ where }: { where: { appId?: string; projectId?: string; source: string } }) => {
        images = images.filter((i) => !((where.appId ? i.appId === where.appId : i.projectId === where.projectId) && i.source === where.source));
      },
    },
    job: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => { jobs.push(data); return { id: `j${jobs.length}` }; },
    },
    activityLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data; } },
    $transaction: async (fn: (t: unknown) => unknown) => fn(db),
  };
  return { db, app, project, jobs, audits, finds, images: () => images };
}

function fakeReply() {
  const r = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown, sent: false };
  const reply = {
    header: (k: string, v: string) => { r.headers[k.toLowerCase()] = v; return reply; },
    code: (c: number) => { r.status = c; return reply; },
    send: async (b?: unknown) => { r.body = b; r.sent = true; return reply; },
  };
  return { r, reply };
}

function call(id: (typeof ICON_ENDPOINTS)[number], db: unknown, input: { body?: unknown; actor?: Actor; query?: unknown; headers?: Record<string, string>; slug?: boolean; params?: unknown } = {}) {
  const h = iconHandlers[id] as Handler<never>;
  const { r, reply } = fakeReply();
  const out = h({
    params: (input.params ?? (input.slug ? { slug: "shop" } : { id: APP })) as never, body: input.body as never, query: (input.query ?? {}) as never, actor: input.actor ?? owner,
    req: { clientIp: "203.0.113.1", headers: { "user-agent": "vitest", ...input.headers } } as never, reply: reply as never, ctx: { db, ring: testRing() } as unknown as Ctx,
  });
  return { out, r };
}

const favicon = (data = png(32, 32)): Img => ({
  appId: APP, source: "favicon", mime: "image/png", data, sha256: sha(data), width: 32, height: 32, origin: "https://shop.example.com/favicon.png", updatedAt: new Date("2026-10-30T10:00:00Z"),
});

describe("icon routes", () => {
  it("registers every icon endpoint with its policy: viewers and read tokens read, only an Admin session writes", async () => {
    const { app, routes } = await buildApp({ db: noDb(), ring: testRing(), config: testConfig(), logger: false });
    await app.ready();
    for (const id of ICON_ENDPOINTS) {
      const r = routes.find((x) => x.url === endpoints[id].path && x.method === endpoints[id].method);
      expect(r?.policy, id).toBe(describePolicy(POLICIES[id]));
    }
    for (const id of ["icons.list", "apps.icon.get", "projects.icon.get"] as const) expect(describePolicy(POLICIES[id])).toBe("session:viewer+token:read");
    for (const id of ["apps.icon.put", "projects.icon.put"] as const) expect(describePolicy(POLICIES[id])).toBe("session:admin");
    // The mail icon route is anonymous: its signed token is the credential, and a bad one is a plain 404.
    expect(describePolicy(POLICIES["icons.mail.get"])).toBe("anonymous");
    const res = await app.inject({ method: "PUT", url: `/api/v1/apps/${APP}/icon`, payload: { choice: "auto" } });
    expect(res.statusCode).toBe(401);
    const bad = await app.inject({ method: "GET", url: `/api/v1/apps/${APP}/icon?v=../../x` });
    expect([400, 401]).toContain(bad.statusCode);
    const miss = await app.inject({ method: "GET", url: "/api/v1/icons/mail/not-a-token" });
    expect(miss.statusCode).toBe(404);
    await app.close();
  });
});

describe("icons.mail.get", () => {
  const key = mailIconKey(internalChannelToken(testRing()));
  const token = (target: "app" | "project", id: string, version: string) => signMailIcon(key, { target, id, version });
  const v = sha(png(32, 32)).slice(0, 12);

  it("serves the shown image for a signed token, public and immutable, by the same rule as the console icon", async () => {
    const f = fakeDb({ images: [favicon()] });
    const { out, r } = call("icons.mail.get", f.db, { params: { token: token("app", APP, v) } });
    await out;
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(r.headers["content-security-policy"]).toContain("sandbox");
    expect(r.headers.etag).toBe(`"${sha(png(32, 32))}"`);
    expect(Buffer.isBuffer(r.body)).toBe(true);

    // A project's link: the favicon of the app the owner chose, like its console icon; 304 on a matching ETag.
    const p = fakeDb({ pick: "prod-web", frontends: [{ env: "production", id: "prod-web", primary: true, fav: favicon(png(48, 48)) }] });
    const pv = sha(png(48, 48)).slice(0, 12);
    const got = call("icons.mail.get", p.db, { params: { token: token("project", PROJECT, pv) } });
    await got.out;
    expect(got.r.status).toBe(200);
    const same = call("icons.mail.get", p.db, { params: { token: token("project", PROJECT, pv) }, headers: { "if-none-match": `"${sha(png(48, 48))}"` } });
    await same.out;
    expect(same.r.status).toBe(304);
    expect(same.r.body).toBeUndefined();
  });

  it("answers 404, never a hint, for a tampered token, another instance's token, a stale version or a missing owner", async () => {
    const good = token("app", APP, v);
    const bad = [
      `${good.slice(0, -1)}${good.endsWith("A") ? "B" : "A"}`,
      signMailIcon(mailIconKey("someone else"), { target: "app", id: APP, version: v }),
      token("app", APP, "000000000000"),
      token("project", APP, v),
      "nope", "", "../x", `${good}.png`,
    ];
    for (const t of bad) {
      await expect(call("icons.mail.get", fakeDb({ images: [favicon()] }).db, { params: { token: t } }).out, t).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    }
    // The right token for an app that is gone, that shows no image any more, or whose shown image changed.
    await expect(call("icons.mail.get", fakeDb({ appMissing: true }).db, { params: { token: good } }).out).rejects.toMatchObject({ status: 404 });
    await expect(call("icons.mail.get", fakeDb().db, { params: { token: good } }).out).rejects.toMatchObject({ status: 404 });
    await expect(call("icons.mail.get", fakeDb({ choice: "upload", images: [favicon()] }).db, { params: { token: good } }).out).rejects.toMatchObject({ status: 404 });
  });
});

describe("apps.icon.put", () => {
  it("stores a valid upload with its sniffed type, switches the choice and audits without the bytes", async () => {
    const f = fakeDb();
    const img = png(64, 64);
    const { out } = call("apps.icon.put", f.db, { body: { choice: "upload", image: img.toString("base64") } });
    const state = (await out) as unknown as Record<string, unknown>;
    expect(state).toMatchObject({ choice: "upload", image: { version: sha(img).slice(0, 12), source: "upload", width: 64, height: 64 } });
    expect(endpoints["apps.icon.put"].response.safeParse(state).success).toBe(true);
    expect(f.images()).toHaveLength(1);
    expect(f.images()[0]).toMatchObject({ mime: "image/png", source: "upload", width: 64 });
    expect(f.audits[0]).toMatchObject({ action: "app.icon", targetLabel: "shop/production/web", changes: { choice: "upload", bytes: 64, sha256: sha(img) } });
    expect(JSON.stringify(f.audits[0])).not.toContain(img.toString("base64"));
    expect(f.jobs).toHaveLength(0);
  });

  it("refuses SVG, an oblong image, a tiny one and base64 that does not round-trip, storing nothing", async () => {
    for (const image of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64"),
      png(64, 32).toString("base64"),
      png(16, 16).toString("base64"),
      `${png(64, 64).toString("base64").slice(0, -4)}AAB=`,
    ]) {
      const f = fakeDb();
      await expect(call("apps.icon.put", f.db, { body: { choice: "upload", image } }).out).rejects.toMatchObject({ status: 400, code: "INVALID_IMAGE" });
      expect(f.images()).toHaveLength(0);
      expect(f.audits).toHaveLength(0);
    }
  });

  it("goes back to automatic from an upload: the upload is dropped and the favicon kept", async () => {
    const up = png(64, 64);
    const f = fakeDb({ choice: "upload", images: [favicon(), { ...favicon(up), source: "upload", origin: null }] });
    const state = await call("apps.icon.put", f.db, { body: { choice: "auto" } }).out;
    expect(state).toMatchObject({ choice: "auto", image: { source: "favicon" } });
    expect(f.images().map((i) => i.source)).toEqual(["favicon"]);
    expect(f.audits[0]).toMatchObject({ changes: { choice: "auto" } });
  });

  it("refuses the old preset choice at the contract", () => {
    expect(endpoints["apps.icon.put"].body.safeParse({ choice: "preset", preset: "bot" }).success).toBe(false);
  });

  it("goes back to automatic: a frontend shows its favicon and queues a fetch, a backend queues nothing", async () => {
    const f = fakeDb({ choice: "upload", images: [favicon()] });
    const state = await call("apps.icon.put", f.db, { body: { choice: "auto" } }).out;
    expect(state).toMatchObject({ choice: "auto", image: { source: "favicon" }, favicon: { origin: "https://shop.example.com/favicon.png" } });
    expect(f.jobs).toEqual([expect.objectContaining({ kind: "icon_fetch", lane: "maintenance", payload: { appId: APP }, dedupeKey: `icon_fetch:${APP}` })]);

    const b = fakeDb({ kind: "backend", choice: "upload" });
    expect(await call("apps.icon.put", b.db, { body: { choice: "auto" } }).out).toMatchObject({ choice: "auto", image: null, favicon: null });
    expect(b.jobs).toHaveLength(0);
  });

  it("404s an unknown app and refuses a token limited to other projects", async () => {
    await expect(call("apps.icon.put", fakeDb({ appMissing: true }).db, { body: { choice: "auto" } }).out).rejects.toMatchObject({ status: 404 });
    await expect(call("apps.icon.put", fakeDb().db, { body: { choice: "auto" }, actor: limitedToken }).out).rejects.toMatchObject({ status: 403 });
  });
});

describe("apps.icon.get", () => {
  it("serves the shown image with its stored type, immutable when the version matches", async () => {
    const f = fakeDb({ images: [favicon()] });
    const v = sha(png(32, 32)).slice(0, 12);
    const { out, r } = call("apps.icon.get", f.db, { query: { v } });
    await out;
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(r.headers["content-security-policy"]).toContain("sandbox");
    expect(Buffer.isBuffer(r.body)).toBe(true);

    const stale = call("apps.icon.get", f.db, { query: { v: "000000000000" } });
    await stale.out;
    expect(stale.r.headers["cache-control"]).toBe("private, no-cache");
  });

  it("answers 304 for a matching ETag and 404 when the icon has no image", async () => {
    const f = fakeDb({ images: [favicon()] });
    const hit = call("apps.icon.get", f.db, { headers: { "if-none-match": `"${sha(png(32, 32))}"` } });
    await hit.out;
    expect(hit.r.status).toBe(304);
    expect(hit.r.body).toBeUndefined();

    await expect(call("apps.icon.get", fakeDb().db).out).rejects.toMatchObject({ status: 404 });
    // An upload choice with no stored upload never falls back to serving the favicon.
    await expect(call("apps.icon.get", fakeDb({ choice: "upload", images: [favicon()] }).db).out).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a token limited to other projects", async () => {
    await expect(call("apps.icon.get", fakeDb({ images: [favicon()] }).db, { actor: limitedToken }).out).rejects.toMatchObject({ status: 403 });
  });
});

describe("projects.icon.put and icons.list", () => {
  it("uploads a project icon and lists it beside the apps, keyed by slug", async () => {
    const f = fakeDb({ images: [favicon()] });
    const img = png(128, 128);
    const state = await call("projects.icon.put", f.db, { slug: true, body: { choice: "upload", image: img.toString("base64") } }).out;
    expect(state).toMatchObject({ choice: "upload", image: { source: "upload", width: 128 }, favicon: null });
    expect(f.audits[0]).toMatchObject({ action: "project.icon", targetLabel: "shop" });

    const map = (await call("icons.list", f.db).out) as unknown as { apps: Record<string, unknown>; projects: Record<string, unknown> };
    expect(endpoints["icons.list"].response.safeParse(map).success).toBe(true);
    expect(Object.keys(map.apps)).toEqual([APP]);
    expect(map.projects.shop).toMatchObject({ choice: "upload" });
  });

  it("shows the folder by default, whatever favicons its frontends have", async () => {
    const f = fakeDb({
      frontends: [
        { env: "development", id: "0f0e0d0c-0000-4000-8000-0000000000e1", primary: true, fav: favicon(png(32, 32)) },
        { env: "production", id: "0f0e0d0c-0000-4000-8000-0000000000e2", primary: true, fav: favicon(png(48, 48)) },
      ],
    });
    const map = (await call("icons.list", f.db).out) as unknown as { projects: Record<string, { image: unknown; favicon: unknown; borrow: { mode: string; pick: unknown; from: unknown } }> };
    // Even the mail link has nothing to name: the email shows the folder.
    await expect(call("icons.mail.get", f.db, { params: { token: signMailIcon(mailIconKey(internalChannelToken(testRing())), { target: "project", id: PROJECT, version: sha(png(48, 48)).slice(0, 12) }) } }).out).rejects.toMatchObject({ status: 404 });
    expect(endpoints["icons.list"].response.safeParse(map).success).toBe(true);
    expect(map.projects.shop).toMatchObject({ image: null, favicon: null, borrow: { mode: "folder", pick: null, from: null } });
    await expect(call("projects.icon.get", f.db, { slug: true }).out).rejects.toMatchObject({ status: 404 });
  });

  // A common shape: an admin panel made first on a test domain, the public site on a custom one, and its dev copy.
  const DASH = "0f0e0d0c-0000-4000-8000-0000000000d1";
  const SITE = "0f0e0d0c-0000-4000-8000-0000000000d2";
  const DEV = "0f0e0d0c-0000-4000-8000-0000000000d3";
  const dashFav = favicon(png(40, 40));
  const siteFav = favicon(png(48, 48));
  const v = (b: Buffer) => sha(b).slice(0, 12);
  const siteShape = (extra: Parameters<typeof fakeDb>[0] = {}) => fakeDb({
    frontends: [
      { env: "production", id: DASH, name: "dashboard", displayName: "Admin panel", primary: "dashboard-4f5e6d.203-0-113-10.sslip.io", test: true, born: 0, fav: dashFav },
      { env: "production", id: SITE, name: "frontend", primary: "brand.example", born: 1, fav: siteFav },
      { env: "development", id: DEV, name: "frontend", primary: "dev.brand.example", born: 2, fav: favicon(png(36, 36)) },
    ],
    ...extra,
  });
  type Listed = { projects: Record<string, { image: { version: string } | null; favicon: { origin: string | null } | null; borrow?: { mode: string; pick: string | null; from: string | null; apps: Array<{ id: string; name: string; host: string | null }> } }> };

  it("lists the frontends to choose from, the most public first, while the project shows the folder", async () => {
    const f = siteShape();
    const map = (await call("icons.list", f.db).out) as unknown as Listed;
    expect(endpoints["icons.list"].response.safeParse(map).success).toBe(true);
    expect(map.projects.shop?.image).toBeNull();
    expect(map.projects.shop?.borrow).toEqual({
      mode: "folder", pick: null, from: null,
      apps: [
        { id: SITE, name: "frontend", environment: "production", host: "shop.example.com" },
        { id: DEV, name: "frontend", environment: "development", host: "shop.example.com" },
        { id: DASH, name: "Admin panel", environment: "production", host: "shop.example.com" },
      ],
    });
  });

  it("treats an sslip name as a test domain even when its row was never flagged", async () => {
    const f = fakeDb({
      frontends: [
        { env: "production", id: DASH, primary: "admin-1a2b3c.203-0-113-10.sslip.io", born: 0, fav: dashFav },
        { env: "production", id: SITE, primary: "brand.example", born: 1, fav: siteFav },
      ],
    });
    const map = (await call("icons.list", f.db).out) as unknown as Listed;
    expect(map.projects.shop?.borrow?.apps.map((a) => a.id)).toEqual([SITE, DASH]);
  });

  it("shows the app the owner chose, stores it on the project and audits the change", async () => {
    const f = siteShape();
    const state = await call("projects.icon.put", f.db, { slug: true, body: { choice: "app", appId: DASH } }).out;
    expect(endpoints["projects.icon.put"].response.safeParse(state).success).toBe(true);
    expect(state).toMatchObject({ choice: "auto", image: { version: v(png(40, 40)), source: "favicon" }, borrow: { mode: "app", pick: DASH, from: DASH } });
    expect(f.project.iconAppId).toBe(DASH);
    expect(f.audits[0]).toMatchObject({ action: "project.icon", targetLabel: "shop", changes: { choice: "app", from: "folder", to: "production/dashboard" } });

    // Every reader follows the choice: the map, the image route and the mail rule.
    const map = (await call("icons.list", f.db).out) as unknown as Listed;
    expect(map.projects.shop?.image?.version).toBe(v(png(40, 40)));
    const got = call("projects.icon.get", f.db, { slug: true, query: { v: v(png(40, 40)) } });
    await got.out;
    expect(got.r.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(got.r.headers.etag).toBe(`"${sha(png(40, 40))}"`);

    // Back to the folder.
    const back = await call("projects.icon.put", f.db, { slug: true, body: { choice: "folder" } }).out;
    expect(back).toMatchObject({ choice: "auto", image: null, favicon: null, borrow: { mode: "folder", pick: null, from: null } });
    expect(f.project.iconAppId).toBeNull();
    expect(f.audits[1]).toMatchObject({ changes: { choice: "folder", from: "production/dashboard", to: "folder" } });
    await expect(call("projects.icon.get", f.db, { slug: true }).out).rejects.toMatchObject({ status: 404 });
  });

  it("refuses an app that is not one of the project's frontends with a favicon, writing nothing", async () => {
    for (const appId of ["0f0e0d0c-0000-4000-8000-0000000000ff", APP]) {
      const f = siteShape({ frontends: [{ env: "production", id: SITE, primary: "brand.example", fav: siteFav }, { env: "production", id: APP }] });
      await expect(call("projects.icon.put", f.db, { slug: true, body: { choice: "app", appId } }).out).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST", extra: { field: "appId" } });
      expect(f.project.iconAppId).toBeNull();
      expect(f.audits).toHaveLength(0);
    }
    // Only a project names an app; an app's automatic is its own favicon. A project has no automatic.
    expect(endpoints["apps.icon.put"].body.safeParse({ choice: "auto", appId: SITE }).success).toBe(false);
    expect(endpoints["projects.icon.put"].body.safeParse({ choice: "app", appId: SITE }).success).toBe(true);
    expect(endpoints["projects.icon.put"].body.safeParse({ choice: "auto" }).success).toBe(false);
    expect(endpoints["projects.icon.put"].body.safeParse({ choice: "auto", appId: SITE }).success).toBe(false);
    expect(endpoints["projects.icon.put"].body.safeParse({ choice: "app", appId: "dashboard" }).success).toBe(false);
  });

  it("shows the folder when the chosen frontend no longer has a favicon, and never another app's", async () => {
    const f = siteShape({ pick: DEV, frontends: [{ env: "production", id: SITE, primary: "brand.example", fav: siteFav }, { env: "development", id: DEV }] });
    const map = (await call("icons.list", f.db).out) as unknown as Listed;
    expect(map.projects.shop?.image).toBeNull();
    expect(map.projects.shop?.borrow).toMatchObject({ mode: "app", pick: DEV, from: null });
    await expect(call("projects.icon.get", f.db, { slug: true }).out).rejects.toMatchObject({ status: 404 });
  });

  it("an upload clears the chosen app, and leaving the upload for a frontend drops it", async () => {
    const f = siteShape({ pick: DASH });
    const img = png(64, 64);
    const up = await call("projects.icon.put", f.db, { slug: true, body: { choice: "upload", image: img.toString("base64") } }).out;
    expect(up).toMatchObject({ choice: "upload", image: { source: "upload" }, favicon: null, borrow: { mode: "upload", pick: null, from: null } });
    expect(f.project.iconAppId).toBeNull();
    expect(f.audits[0]).toMatchObject({ changes: { choice: "upload", from: "production/dashboard" } });
    const to = await call("projects.icon.put", f.db, { slug: true, body: { choice: "app", appId: DEV } }).out;
    expect(to).toMatchObject({ choice: "auto", image: { version: v(png(36, 36)) }, borrow: { mode: "app", pick: DEV, from: DEV } });
    expect(f.images().filter((i) => i.projectId === PROJECT)).toHaveLength(0);
    expect(f.audits[1]).toMatchObject({ changes: { choice: "app", from: "upload", to: "development/frontend" } });
  });

  it("limits the map to a token's projects", async () => {
    const f = fakeDb();
    await call("icons.list", f.db, { actor: limitedToken }).out;
    expect(JSON.stringify(f.finds[0])).toContain('"in":["other"]');
  });
});
