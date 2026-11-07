import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0026 on a real Postgres (PGlite, in process): every migration before it, the rows an
 * existing install has, then the migration. Existing apps keep showing their names, and the
 * database holds display names to the contract's length and to one per environment, whatever the case.
 */
const DIR = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
const NAME = "0026_app_display_name";
const script = (name: string) => readFileSync(`${DIR}${name}/migration.sql`, "utf8");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("0026 on an install that has apps", () => {
  let db: PGlite;
  const [PROJECT, PROD, DEV, WEB, API, WEB_DEV, SERVER] = [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5), uuid(6), uuid(7)];
  const app = (id: string, env: string, name: string) =>
    db.exec(`INSERT INTO apps (id, "environmentId", "serverId", name, kind, "updatedAt") VALUES ('${id}', '${env}', '${SERVER}', '${name}', 'frontend', now())`);
  const rename = (id: string, to: string | null) => db.query(`UPDATE apps SET "displayName" = $1 WHERE id = $2`, [to, id]);

  beforeAll(async () => {
    db = new PGlite();
    for (const name of readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
      if (name < NAME) await db.exec(script(name));
    }
    await db.exec(`INSERT INTO servers (id, name, "isPrimary", state, "updatedAt") VALUES ('${SERVER}', 'server-x', false, 'active', now())`);
    await db.exec(`INSERT INTO projects (id, slug, name, "updatedAt") VALUES ('${PROJECT}', 'shop', 'Shop', now())`);
    await db.exec(`INSERT INTO environments (id, "projectId", name, branch) VALUES ('${PROD}', '${PROJECT}', 'production', 'main'), ('${DEV}', '${PROJECT}', 'development', 'dev')`);
    await app(WEB, PROD, "web");
    await app(API, PROD, "api");
    await app(WEB_DEV, DEV, "web");
    await db.exec(script(NAME));
  }, 120_000);

  it("leaves every existing app showing its name, with nothing else changed", async () => {
    const rows = (await db.query<{ name: string; displayName: string | null }>(`SELECT name, "displayName" FROM apps ORDER BY id`)).rows;
    expect(rows).toEqual([{ name: "web", displayName: null }, { name: "api", displayName: null }, { name: "web", displayName: null }]);
  });

  it("stores a display name of 1 to 60 characters, and no other", async () => {
    await rename(WEB, "Storefront");
    await rename(API, "x".repeat(60));
    await expect(rename(API, "x".repeat(61))).rejects.toThrow(/apps_display_name_length/);
    await expect(rename(API, "")).rejects.toThrow(/apps_display_name_length/);
    await rename(API, null);
  });

  it("lets two apps of one environment never show the same display name, in any case, and leaves other environments free", async () => {
    await rename(WEB, "Storefront");
    await expect(rename(API, "STOREFRONT")).rejects.toThrow(/apps_display_name_unique/);
    await rename(WEB_DEV, "storefront");
    // Any number of apps show their own names.
    await rename(API, null);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM apps WHERE "displayName" IS NULL`)).rows[0]?.n).toBe(1);
  });
});
