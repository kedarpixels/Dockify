import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0027 on a real Postgres (PGlite, in process): every migration before it, the schedules an
 * existing install has, then the migration. Each service's one schedule lands on the tier its
 * destination names with the same cron, switch, last run and retention (keep 3 plus its days, the old
 * rule), the other tier is off with the same retention, and apps that are not services get nothing.
 */
const DIR = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));
const NAME = "0027_backup_tiers";
const script = (name: string) => readFileSync(`${DIR}${name}/migration.sql`, "utf8");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface TierRow {
  tier: string;
  enabled: boolean;
  cron: string | null;
  timezone: string;
  keep: number;
  keepDays: number | null;
  destinationId: string | null;
  lastRunAt: Date | null;
}

const [PROJECT, ENV, SERVER, INTEGRATION, S3_DEST, LOCAL_DEST] = [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5), uuid(6)];
const LAST = "2026-11-01T03:00:00.000Z";

/** A database migrated up to just before 0027, with a project, an environment and destinations. */
async function before(withDefaultS3: boolean): Promise<PGlite> {
  const db = new PGlite();
  for (const name of readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    if (name < NAME) await db.exec(script(name));
  }
  await db.exec(`INSERT INTO servers (id, name, "isPrimary", state, "updatedAt") VALUES ('${SERVER}', 'server-x', false, 'active', now())`);
  await db.exec(`INSERT INTO projects (id, slug, name, "updatedAt") VALUES ('${PROJECT}', 'shop', 'Shop', now())`);
  await db.exec(`INSERT INTO environments (id, "projectId", name, branch) VALUES ('${ENV}', '${PROJECT}', 'production', 'main')`);
  await db.exec(`INSERT INTO integrations (id, kind, name, "updatedAt") VALUES ('${INTEGRATION}', 'storage', 'b2', now())`);
  await db.exec(`INSERT INTO backup_destinations (id, name, type, "integrationId", "isDefault") VALUES ('${S3_DEST}', 'Backblaze B2', 's3', '${INTEGRATION}', ${withDefaultS3})`);
  await db.exec(`INSERT INTO backup_destinations (id, name, type) VALUES ('${LOCAL_DEST}', 'This server', 'local')`);
  return db;
}

async function app(db: PGlite, id: string, name: string, kind: string, schedule: Record<string, unknown> = {}): Promise<void> {
  const cols = Object.keys(schedule).map((k) => `"${k}"`).join(", ");
  const vals = Object.keys(schedule).map((_, i) => `$${i + 1}`).join(", ");
  await db.query(
    `INSERT INTO apps (id, "environmentId", "serverId", name, kind, "updatedAt"${cols ? `, ${cols}` : ""}) VALUES ('${id}', '${ENV}', '${SERVER}', '${name}', '${kind}', now()${vals ? `, ${vals}` : ""})`,
    Object.values(schedule),
  );
}

const tiers = async (db: PGlite, appId: string) =>
  (
    await db.query<TierRow>(
      `SELECT tier::text AS tier, enabled, cron, timezone, keep, "keepDays", "destinationId", "lastRunAt" FROM backup_schedules WHERE "appId" = $1 ORDER BY tier`,
      [appId],
    )
  ).rows;

const OFF = { enabled: false, cron: null, timezone: "UTC", keep: 3, destinationId: null, lastRunAt: null };

describe("0027 on an install with a default S3 destination", () => {
  let db: PGlite;
  const [OFFSITE_DB, LOCAL_DB, DEFAULT_DB, PAUSED_DB, WEB] = [uuid(11), uuid(12), uuid(13), uuid(14), uuid(15)];

  beforeAll(async () => {
    db = await before(true);
    await app(db, OFFSITE_DB, "orders", "postgres", { backupEnabled: true, backupCron: "0 3 * * *", backupRetentionDays: 14, backupDestinationId: S3_DEST, backupLastRunAt: LAST });
    await app(db, LOCAL_DB, "cache", "redis", { backupEnabled: true, backupCron: "0 */12 * * *", backupRetentionDays: 7, backupDestinationId: LOCAL_DEST });
    await app(db, DEFAULT_DB, "ledger", "postgres", { backupEnabled: true, backupCron: "30 4 * * *", backupRetentionDays: 30 });
    await app(db, PAUSED_DB, "audit", "postgres", { backupEnabled: false, backupCron: "0 2 * * 0", backupRetentionDays: 9000, backupDestinationId: LOCAL_DEST });
    await app(db, WEB, "web", "frontend");
    await db.exec(script(NAME));
  }, 120_000);

  it("puts an S3 schedule on the offsite tier, unchanged, with the old retention rule", async () => {
    expect(await tiers(db, OFFSITE_DB)).toEqual([
      { ...OFF, tier: "local", keepDays: 14 },
      { tier: "offsite", enabled: true, cron: "0 3 * * *", timezone: "UTC", keep: 3, keepDays: 14, destinationId: S3_DEST, lastRunAt: new Date(LAST) },
    ]);
  });

  it("puts a schedule on this server's disk on the local tier, with no destination of its own", async () => {
    expect(await tiers(db, LOCAL_DB)).toEqual([
      { tier: "local", enabled: true, cron: "0 */12 * * *", timezone: "UTC", keep: 3, keepDays: 7, destinationId: null, lastRunAt: null },
      { ...OFF, tier: "offsite", keepDays: 7 },
    ]);
  });

  it("keeps a schedule that followed the default S3 destination following it, offsite", async () => {
    expect(await tiers(db, DEFAULT_DB)).toEqual([
      { ...OFF, tier: "local", keepDays: 30 },
      { tier: "offsite", enabled: true, cron: "30 4 * * *", timezone: "UTC", keep: 3, keepDays: 30, destinationId: null, lastRunAt: null },
    ]);
  });

  it("keeps a paused schedule paused, and holds its days to what the contract allows", async () => {
    expect(await tiers(db, PAUSED_DB)).toEqual([
      { tier: "local", enabled: false, cron: "0 2 * * 0", timezone: "UTC", keep: 3, keepDays: 3650, destinationId: null, lastRunAt: null },
      { ...OFF, tier: "offsite", keepDays: 3650 },
    ]);
  });

  it("gives apps that are not services no schedule, and drops the old columns", async () => {
    expect(await tiers(db, WEB)).toEqual([]);
    const cols = (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'apps' AND column_name LIKE 'backup%'`)).rows;
    expect(cols).toEqual([]);
  });

  it("holds keep, keepDays and the local tier to their CHECKs, and goes with its app", async () => {
    const set = (sql: string) => db.exec(`UPDATE backup_schedules SET ${sql} WHERE "appId" = '${LOCAL_DB}' AND tier = 'local'`);
    await set(`keep = 1`);
    await set(`keep = 1000, "keepDays" = NULL`);
    await expect(set(`keep = 0`)).rejects.toThrow(/backup_schedules_keep_range/);
    await expect(set(`keep = 1001`)).rejects.toThrow(/backup_schedules_keep_range/);
    await expect(set(`"keepDays" = 0`)).rejects.toThrow(/backup_schedules_keep_days_range/);
    await expect(set(`"destinationId" = '${S3_DEST}'`)).rejects.toThrow(/backup_schedules_local_no_destination/);
    await expect(db.exec(`INSERT INTO backup_schedules (id, "appId", tier, "updatedAt") VALUES (gen_random_uuid(), '${LOCAL_DB}', 'local', now())`)).rejects.toThrow(/backup_schedules_appId_tier_key/);
    await db.exec(`DELETE FROM apps WHERE id = '${LOCAL_DB}'`);
    expect(await tiers(db, LOCAL_DB)).toEqual([]);
  });
});

describe("0027 on an install with no default destination", () => {
  it("puts a schedule with no destination on the local tier, where its backups went", async () => {
    const db = await before(false);
    const DB = uuid(21);
    await app(db, DB, "orders", "postgres", { backupEnabled: true, backupCron: "0 3 * * *", backupRetentionDays: 14 });
    await db.exec(script(NAME));
    expect(await tiers(db, DB)).toEqual([
      { tier: "local", enabled: true, cron: "0 3 * * *", timezone: "UTC", keep: 3, keepDays: 14, destinationId: null, lastRunAt: null },
      { ...OFF, tier: "offsite", keepDays: 14 },
    ]);
  }, 120_000);
});
