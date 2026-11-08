/**
 * The project icon rules against a really migrated Postgres (DATABASE_URL_TEST), since the handler
 * tests fake the database: the icon map lists a project that only borrows a favicon, the most
 * public frontend wins, an explicit pick is stored and served, and deleting the picked app clears it.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, defaultServerId, type Db } from "@dockify/db";
import type { Actor } from "../../actor.ts";
import type { Ctx, Handler } from "../../app.ts";
import { testRing } from "../../test-helpers.ts";
import { iconHandlers } from "./index.ts";

const url = process.env.DATABASE_URL_TEST;
const owner = { kind: "session", userId: "u", name: "Owner", role: "admin", sessionId: "s", elevated: false } as Actor;

function png(side: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(new ArrayBuffer(64));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, side);
  new DataView(b.buffer).setUint32(20, side);
  return b;
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function reply() {
  const r: { status: number; headers: Record<string, string> } = { status: 0, headers: {} };
  const rep = {
    header: (k: string, v: string) => { r.headers[k.toLowerCase()] = v; return rep; },
    code: (c: number) => { r.status = c; return rep; },
    send: async () => rep,
  };
  return { r, rep };
}

describe.skipIf(!url)("project icons against a migrated Postgres", () => {
  let db: Db;
  let ctx: Ctx;
  const slug = `icons-${Date.now()}`;
  const run = (id: keyof typeof iconHandlers, input: { params?: unknown; body?: unknown; query?: unknown } = {}) => {
    const { r, rep } = reply();
    const out = (iconHandlers[id] as Handler<never>)({
      ctx, actor: owner, params: (input.params ?? {}) as never, body: input.body as never, query: (input.query ?? {}) as never,
      req: { clientIp: "203.0.113.1", headers: { "user-agent": "vitest" } } as never, reply: rep as never,
    });
    return { out, r };
  };
  const ids = { dash: "", site: "" };

  beforeAll(async () => {
    db = createDb(url);
    ctx = { db, ring: testRing() } as unknown as Ctx;
    const serverId = await defaultServerId(db);
    const project = await db.project.create({ data: { slug, name: slug } });
    const prod = await db.environment.create({ data: { projectId: project.id, name: "production", branch: "main" } });
    // The admin panel came first, on a free test domain; the public site after it, on its own domain.
    const dash = await db.app.create({ data: { environmentId: prod.id, serverId, name: "dashboard", kind: "frontend", displayName: "Admin panel", createdAt: new Date("2026-01-01") } });
    const site = await db.app.create({ data: { environmentId: prod.id, serverId, name: "frontend", kind: "frontend", createdAt: new Date("2026-01-02") } });
    ids.dash = dash.id;
    ids.site = site.id;
    const host = `${slug}.example.com`;
    const d1 = await db.domain.create({ data: { appId: dash.id, hostname: `dashboard-${slug}.203-0-113-10.sslip.io`, testDomain: true } });
    const d2 = await db.domain.create({ data: { appId: site.id, hostname: host } });
    await db.app.update({ where: { id: dash.id }, data: { primaryDomainId: d1.id } });
    await db.app.update({ where: { id: site.id }, data: { primaryDomainId: d2.id } });
    for (const [appId, data, origin] of [[dash.id, png(40), `https://${d1.hostname}/favicon.png`], [site.id, png(48), `https://${host}/favicon.png`]] as const) {
      await db.iconImage.create({ data: { appId, source: "favicon", mime: "image/png", data, sha256: sha(data), width: 40, height: 40, origin } });
    }
  });

  afterAll(async () => {
    await db?.project.deleteMany({ where: { slug } });
    await db?.$disconnect();
  });

  it("lists a project that only borrows a favicon, with the public site's image, and serves that same image", async () => {
    const map = (await run("icons.list").out) as unknown as { projects: Record<string, { choice: string; image: { version: string } | null; borrow: { auto: string; from: string } }> };
    const state = map.projects[slug];
    expect(state).toMatchObject({ choice: "auto", image: { version: sha(png(48)).slice(0, 12) }, borrow: { auto: ids.site, from: ids.site } });
    const got = run("projects.icon.get", { params: { slug }, query: { v: state!.image!.version } });
    await got.out;
    expect(got.r.status).toBe(200);
    expect(got.r.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(got.r.headers.etag).toBe(`"${sha(png(48))}"`);
  });

  it("stores an explicit pick, serves it, and clears it when the picked app is deleted", async () => {
    const state = await run("projects.icon.put", { params: { slug }, body: { choice: "auto", appId: ids.dash } }).out;
    expect(state).toMatchObject({ image: { version: sha(png(40)).slice(0, 12) }, borrow: { pick: ids.dash, from: ids.dash } });
    expect((await db.project.findUnique({ where: { slug }, select: { iconAppId: true } }))?.iconAppId).toBe(ids.dash);
    const log = await db.activityLog.findFirst({ where: { action: "project.icon", targetLabel: slug }, select: { changes: true } });
    expect(log?.changes).toEqual({ choice: "auto", favicon: { from: "automatic", to: "production/dashboard" } });

    await db.app.delete({ where: { id: ids.dash } });
    expect((await db.project.findUnique({ where: { slug }, select: { iconAppId: true } }))?.iconAppId).toBeNull();
    const map = (await run("icons.list").out) as unknown as { projects: Record<string, { image: { version: string } | null }> };
    expect(map.projects[slug]?.image?.version).toBe(sha(png(48)).slice(0, 12));
  });
});
