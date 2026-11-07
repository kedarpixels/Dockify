/**
 * What the contracts accept, the database must store. Handler tests fake the database, so a CHECK or
 * enum left behind by a contract change passed every test and then answered 500 on a real install
 * (the Railpack builder, a new Vercel app). This reads the migrations with no database at all, and with
 * DATABASE_URL_TEST set it asks a really migrated Postgres the same questions and inserts the rows.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import * as contracts from "@dockify/contracts";
import { createDb, defaultServerId, type Db } from "@dockify/db";

const DB_ROOT = fileURLToPath(new URL("../../../packages/db/prisma/", import.meta.url));
const MIGRATIONS = `${DB_ROOT}migrations/`;

/** Every CHECK that stands after all migrations ran, by name. */
function checksNow(): Map<string, string> {
  const checks = new Map<string, string>();
  const names = readdirSync(MIGRATIONS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const name of names) {
    const sql = readFileSync(`${MIGRATIONS}${name}/migration.sql`, "utf8").replace(/\r/g, "");
    for (const m of sql.matchAll(/^ALTER TABLE "\w+" (?:DROP CONSTRAINT "(\w+)"|ADD CONSTRAINT "(\w+)" CHECK \((.+)\));$/gm)) {
      if (m[1]) checks.delete(m[1]);
      else checks.set(m[2]!, m[3]!);
    }
  }
  return checks;
}

/** Every enum in the Prisma schema, which migration.test.ts holds to the migrations. */
function dbEnums(): Map<string, string[]> {
  const schema = readFileSync(`${DB_ROOT}schema.prisma`, "utf8").replace(/\r/g, "");
  const out = new Map<string, string[]>();
  for (const m of schema.matchAll(/^enum (\w+) \{\n([\s\S]*?)^\}/gm)) {
    out.set(m[1]!, m[2]!.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")).map((l) => l.split(/\s+/)[0]!));
  }
  return out;
}

/** The api speaks camelCase and the database snake_case for the same value, as the mappers convert it. */
const same = (v: string) => v.replace(/_/g, "").toLowerCase();

/** Every exported z.enum, namespaces included, by export name. */
function contractEnums(): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  const walk = (o: Record<string, unknown>) => {
    for (const [name, v] of Object.entries(o)) {
      if (v instanceof z.ZodEnum) out.set(name, v.options as readonly string[]);
      else if (v && typeof v === "object" && Object.prototype.toString.call(v) === "[object Module]") walk(v as Record<string, unknown>);
    }
  };
  walk(contracts as unknown as Record<string, unknown>);
  return out;
}

const P = contracts.projects;
const S = contracts.server;

/** Contract enums whose name differs from the database enum that stores them. */
const RENAMED: Array<[string, readonly string[], string]> = [
  ["AppSpec.target", P.AppSpec.shape.target.options, "DeployTarget"],
];

/** CHECKs listing allowed text, and the contract values that must all pass them. */
const LISTS: Record<string, readonly string[]> = {
  apps_builder_known: contracts.BuilderKind.options,
  icon_images_mime_known: contracts.LogoMime.options,
};

const PS = P.PreviewSettings.shape;
/** CHECK ranges a contract field writes straight into, as [check, column, schema]. */
const RANGES: Array<[string, string, z.ZodNumber]> = [
  ["projects_preview_caps", "previewMaxConcurrent", PS.maxConcurrent],
  ["projects_preview_caps", "previewIdleMinutes", PS.idleMinutes],
  ["projects_preview_caps", "previewTtlHours", PS.ttlHours],
  ["projects_preview_limits", "previewMemoryMb", PS.memoryMb],
  ["projects_preview_limits", "previewPidsLimit", PS.pidsLimit],
  ["instance_preview_server_max", "previewServerMax", PS.serverMaxConcurrent],
];
/** CHECKs no contract list or range feeds, each read by hand against what writes it. A new CHECK must pick a group. */
const REVIEWED = new Set([
  "instance_singleton", "apps_one_source", "apps_port_range", "apps_replicas_range", "apps_retention_min", "apps_sysctls_object",
  "apps_root_dir_relative", "apps_vercel_target", "volumes_mount_absolute", "backup_destinations_s3_has_storage", "jobs_attempts_range",
  "preview_envs_pr_positive", "release_updates_rollback_of_check", "release_updates_attempt_check", "icon_images_one_owner", "icon_images_size_cap",
  "notification_webhooks_telegram_chat", "notification_webhooks_name_length", "deployments_external_id_needs_provider", "jobs_server_bound",
]);

describe("contracts against the database", () => {
  const checks = checksNow();
  const enums = dbEnums();

  it("stores every value of every contract enum that shares a database enum's name", () => {
    let compared = 0;
    for (const [name, values] of contractEnums()) {
      const stored = enums.get(name);
      if (!stored) continue;
      compared++;
      const known = new Set(stored.map(same));
      expect(values.filter((v) => !known.has(same(v))), `${name} against the database enum`).toEqual([]);
    }
    expect(compared).toBeGreaterThan(15);
    for (const [name, values, dbName] of RENAMED) {
      const known = new Set((enums.get(dbName) ?? []).map(same));
      expect(values.filter((v) => !known.has(same(v))), `${name} against ${dbName}`).toEqual([]);
    }
  });

  it("lets through every value a contract allows for a CHECK that lists text", () => {
    for (const [name, values] of Object.entries(LISTS)) {
      const check = checks.get(name);
      expect(check, name).toBeDefined();
      for (const v of values) expect(check, `${name} must allow ${v}`).toContain(`'${v}'`);
    }
  });

  it("gives the CHECK range at least the room the contract allows", () => {
    for (const [name, column, schema] of RANGES) {
      const m = new RegExp(`"${column}" BETWEEN (\\d+) AND (\\d+)`).exec(checks.get(name) ?? "");
      expect(m, `${name} on ${column}`).not.toBeNull();
      expect(schema.minValue!, column).toBeGreaterThanOrEqual(Number(m![1]));
      expect(schema.maxValue!, column).toBeLessThanOrEqual(Number(m![2]));
    }
  });

  it("makes every CHECK choose: compared with a contract, or reviewed by hand", () => {
    const covered = new Set([...Object.keys(LISTS), ...RANGES.map((r) => r[0]), ...REVIEWED]);
    expect([...checks.keys()].filter((c) => !covered.has(c))).toEqual([]);
    expect([...covered].filter((c) => !checks.has(c))).toEqual([]);
  });
});

const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)("contracts against a migrated Postgres", () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(url);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  /** Inserts one app in a transaction that always rolls back, so nothing stays and other test files cannot get in the way. */
  const ROLLBACK = new Error("rollback");
  let n = 0;
  const app = async (data: Record<string, unknown>): Promise<true> => {
    const slug = `checks-${Date.now()}-${n++}`;
    await db.$transaction(async (tx) => {
      const project = await tx.project.create({ data: { slug, name: "Checks" } });
      const environment = await tx.environment.create({ data: { projectId: project.id, name: "production", branch: "main" } });
      await tx.app.create({ data: { environmentId: environment.id, serverId: await defaultServerId(tx), name: "c", kind: "backend", ...data } as never });
      throw ROLLBACK;
    }).catch((e: unknown) => {
      if (e !== ROLLBACK) throw e;
    });
    return true;
  };

  it("stores every builder", async () => {
    for (const builder of contracts.BuilderKind.options) await expect(app({ builder })).resolves.toBeTruthy();
    await expect(app({ builder: "nope" })).rejects.toThrow(/apps_builder_known/);
  });

  it("stores a new Vercel app with no project, and only a follow can go without one", async () => {
    await expect(app({ kind: "frontend", deployTarget: "vercel", vercelFollowOnly: true, vercelProjectId: null })).resolves.toBeTruthy();
    await expect(app({ kind: "frontend", deployTarget: "vercel", vercelFollowOnly: false, vercelProjectId: "prj_1" })).resolves.toBeTruthy();
    await expect(app({ kind: "frontend", deployTarget: "vercel", vercelFollowOnly: false, vercelProjectId: null })).rejects.toThrow(/apps_vercel_target/);
  });

  it("stores every root folder the contract accepts, and no other", async () => {
    for (const rootDir of ["a..b/c", "apps/web", "x..", "..x"]) {
      expect(contracts.RepoPath.safeParse(rootDir).success, rootDir).toBe(true);
      await expect(app({ rootDir })).resolves.toBeTruthy();
    }
    for (const rootDir of ["..", "a/../b", "/etc", "a/.."]) {
      expect(contracts.RepoPath.safeParse(rootDir).success, rootDir).toBe(false);
      await expect(app({ rootDir })).rejects.toThrow(/apps_root_dir_relative/);
    }
  });

  it("has the enums and the CHECKs the migrations say", async () => {
    const rows = await db.$queryRaw<Array<{ typname: string; enumlabel: string }>>`
      SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid`;
    const live = new Map<string, string[]>();
    for (const r of rows) live.set(r.typname, [...(live.get(r.typname) ?? []), r.enumlabel]);
    for (const [name, values] of dbEnums()) expect([...(live.get(name) ?? [])].sort(), name).toEqual([...values].sort());
    const cons = await db.$queryRaw<Array<{ conname: string }>>`SELECT conname FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace`;
    expect(cons.map((c) => c.conname).sort()).toEqual([...checksNow().keys()].sort());
  });
});
