import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0022 on a real Postgres (PGlite, in process): every migration before it, then the rows an
 * existing install has, then the migration itself. A copy of a real dump stays an on-box check.
 */
const DIR = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
const NAME = "0022_servers";
const script = (name: string) => readFileSync(`${DIR}${name}/migration.sql`, "utf8");

async function before(): Promise<PGlite> {
  const db = new PGlite();
  for (const name of readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    if (name < NAME) await db.exec(script(name));
  }
  return db;
}

const job = (db: PGlite, id: string, kind: string, lane: string, done = false, serverId?: string) =>
  db.exec(`INSERT INTO jobs (id, kind, lane, payload, "completedAt"${serverId ? `, "serverId"` : ""}) VALUES ('${id}', '${kind}', '${lane}', '{}', ${done ? "now()" : "NULL"}${serverId ? `, '${serverId}'` : ""})`);

describe("0023 on an install that has rows", () => {
  it("leaves every existing project without production access for its previews, and a new one too", async () => {
    const db = new PGlite();
    for (const name of readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
      if (name < "0023_preview_production_access") await db.exec(script(name));
    }
    await db.exec(`INSERT INTO projects (id, slug, name, "previewEnabled", "updatedAt") VALUES ('00000000-0000-4000-8000-000000000001', 'old', 'Old', true, now())`);
    await db.exec(script("0023_preview_production_access"));
    await db.exec(`INSERT INTO projects (id, slug, name, "updatedAt") VALUES ('00000000-0000-4000-8000-000000000002', 'new', 'New', now())`);
    const rows = (await db.query<{ slug: string; previewProductionAccess: boolean }>(`SELECT slug, "previewProductionAccess" FROM projects ORDER BY slug`)).rows;
    expect(rows).toEqual([{ slug: "new", previewProductionAccess: false }, { slug: "old", previewProductionAccess: false }]);
  }, 120_000);
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("0022 on an empty database", () => {
  it("makes the one primary a fresh install starts with", async () => {
    const db = await before();
    await db.exec(script(NAME));
    const rows = (await db.query<{ name: string; isPrimary: boolean; state: string; ingress: string }>(`SELECT name, "isPrimary", state, ingress FROM servers`)).rows;
    expect(rows).toEqual([{ name: "server-1", isPrimary: true, state: "active", ingress: "direct_tls" }]);
  }, 120_000);
});

describe("0022 on an install that has rows", () => {
  let db: PGlite;
  let primary: string;
  const PROJECT = uuid(1);
  const ENV = uuid(2);
  const APP = uuid(3);
  const DEPLOYMENT = uuid(4);

  beforeAll(async () => {
    db = await before();
    await db.exec(`INSERT INTO instance (id, name, "publicUrl", "masterKeyFingerprint", "ingressMode", "updatedAt") VALUES (1, 'Acme', 'https://dash.acme.dev', 'k', 'cloudflare_tunnel', now())`);
    await db.exec(`INSERT INTO projects (id, slug, name, "updatedAt") VALUES ('${PROJECT}', 'p', 'P', now())`);
    await db.exec(`INSERT INTO environments (id, "projectId", name, branch) VALUES ('${ENV}', '${PROJECT}', 'production', 'main')`);
    await db.exec(`INSERT INTO apps (id, "environmentId", name, kind, "updatedAt") VALUES ('${APP}', '${ENV}', 'a', 'backend', now())`);
    await db.exec(`INSERT INTO deployments (id, "appId", trigger, "actorType") VALUES ('${DEPLOYMENT}', '${APP}', 'manual', 'system')`);
    // Bound kinds and lanes, open and long finished; global kinds on global lanes, both ways too.
    await job(db, uuid(10), "deploy", "deploy");
    await job(db, uuid(11), "deploy", "deploy", true);
    await job(db, uuid(12), "janitor", "maintenance", true);
    await job(db, uuid(13), "remove_app", "maintenance");
    await job(db, uuid(14), "backup", "data", true);
    await job(db, uuid(15), "scheduled_run", "cron", true);
    await job(db, uuid(16), "vercel_sync", "deploy", true);
    await job(db, uuid(17), "edge_cf_unwire", "deploy");
    await job(db, uuid(18), "preview_cleanup", "maintenance");
    await job(db, uuid(20), "dns_check", "maintenance");
    await job(db, uuid(21), "email_send", "maintenance", true);
    await job(db, uuid(22), "build_detect", "detect");
    await job(db, uuid(23), "self_update", "update", true);
    await db.exec(`INSERT INTO metric_samples ("appId", at, "cpuPct", "memoryBytes") VALUES (NULL, now(), 1, 1), ('${APP}', now(), 1, 1)`);
    await db.exec(script(NAME));
    primary = (await db.query<{ id: string }>(`SELECT id FROM servers WHERE "isPrimary"`)).rows[0]!.id;
  }, 120_000);

  it("names the primary from the instance row", async () => {
    const rows = (await db.query<{ name: string; state: string; ingress: string }>(`SELECT name, state, ingress FROM servers`)).rows;
    expect(rows).toEqual([{ name: "Acme", state: "active", ingress: "cloudflare_tunnel" }]);
  });

  it("puts every app and deployment on it, and the columns are not null", async () => {
    expect((await db.query<{ serverId: string }>(`SELECT "serverId" FROM apps`)).rows).toEqual([{ serverId: primary }]);
    expect((await db.query<{ serverId: string }>(`SELECT "serverId" FROM deployments`)).rows).toEqual([{ serverId: primary }]);
    await expect(db.exec(`UPDATE apps SET "serverId" = NULL`)).rejects.toThrow(/null value/);
    await expect(db.exec(`UPDATE deployments SET "serverId" = NULL`)).rejects.toThrow(/null value/);
  });

  it("backfills every bound job, open or finished, and leaves the global ones null", async () => {
    const rows = (await db.query<{ id: string; serverId: string | null }>(`SELECT id, "serverId" FROM jobs ORDER BY id`)).rows;
    const bound = rows.filter((r) => r.id < uuid(20));
    const global = rows.filter((r) => r.id >= uuid(20) && r.id <= uuid(23));
    expect(bound).toHaveLength(9);
    expect(bound.every((r) => r.serverId === primary)).toBe(true);
    expect(global).toHaveLength(4);
    expect(global.every((r) => r.serverId === null)).toBe(true);
  });

  it("backfills host metric rows only", async () => {
    const rows = (await db.query<{ appId: string | null; serverId: string | null }>(`SELECT "appId", "serverId" FROM metric_samples ORDER BY "appId" NULLS FIRST`)).rows;
    expect(rows).toEqual([{ appId: null, serverId: primary }, { appId: APP, serverId: null }]);
  });

  it("refuses a bound kind or a server lane with no server, and takes a global job", async () => {
    await expect(job(db, uuid(30), "deploy", "deploy")).rejects.toThrow(/jobs_server_bound/);
    await expect(job(db, uuid(31), "janitor", "maintenance")).rejects.toThrow(/jobs_server_bound/);
    await expect(job(db, uuid(32), "dns_check", "deploy")).rejects.toThrow(/jobs_server_bound/);
    await expect(job(db, uuid(33), "dns_check", "cron")).rejects.toThrow(/jobs_server_bound/);
    await job(db, uuid(34), "dns_check", "maintenance");
    await job(db, uuid(35), "deploy", "deploy", false, primary);
    await job(db, uuid(36), "edge_cf_wire", "deploy", false, primary);
  });

  it("allows one primary, and one live server per name", async () => {
    const add = (name: string, state: string, isPrimary = false) =>
      db.exec(`INSERT INTO servers (id, name, "isPrimary", state, "updatedAt") VALUES (gen_random_uuid(), '${name}', ${isPrimary}, '${state}', now())`);
    await expect(add("second-primary", "active", true)).rejects.toThrow(/servers_one_primary/);
    await add("two", "active");
    await expect(add("two", "pending_approval")).rejects.toThrow(/servers_live_name/);
    await add("two-gone", "revoked");
    await add("two-gone", "revoked");
    await add("two-gone", "active");
  });

  it("will not delete a server an app runs on, and a job or host row goes with its server", async () => {
    await expect(db.exec(`DELETE FROM servers WHERE id = '${primary}'`)).rejects.toThrow(/foreign key/);
    const other = (await db.query<{ id: string }>(`SELECT id FROM servers WHERE name = 'two'`)).rows[0]!.id;
    await job(db, uuid(40), "deploy", "deploy", false, other);
    await db.exec(`DELETE FROM servers WHERE id = '${other}'`);
    expect((await db.query(`SELECT id FROM jobs WHERE id = '${uuid(40)}'`)).rows).toEqual([]);
  });
});
