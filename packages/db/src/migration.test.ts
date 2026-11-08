import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Database-free drift check. The squashed init migration is the SQL Prisma generated from the
 * schema, followed by the hand-written invariants block (CHECK constraints Prisma cannot express).
 * Every later migration is replayed onto the init statements, and the result must be exactly the
 * statements Prisma generates from the schema today (compared as a set: Prisma orders a fresh
 * script by kind and schema position, a replay by history). The replay knows the statements
 * Prisma writes when a model goes away (DROP CONSTRAINT, DROP TABLE) or arrives (CREATE TYPE,
 * ALTER TYPE ADD VALUE, CREATE TABLE, ADD COLUMN, DROP COLUMN, CREATE INDEX, ADD FOREIGN KEY), and the ones a
 * backfill or a changed index needs (SET NOT NULL, DROP INDEX), skips a migration's data statements
 * and its invariants (CHECK constraints, partial unique indexes), and fails on anything else, so a
 * migration that needs more extends it in the same change. `pnpm db:drift` is the stronger check against a
 * shadow database.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = `${root}prisma/migrations/`;
const MARKER = "-- Invariants Prisma cannot express.";
const norm = (s: string) => s.replace(/\r/g, "").trim();

/** A script as its statements, each with the Prisma step comment above it ("-- CreateTable"). */
const statements = (sql: string) =>
  norm(sql)
    .split(/;[ \t]*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The statement alone, without comment lines. */
const bare = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .trim();

/** The CHECK constraints a script adds, by name: the invariants Prisma never generates. */
const checksIn = (sql: string): Set<string> =>
  new Set([...sql.matchAll(/^ALTER TABLE "\w+" ADD CONSTRAINT "(\w+)" CHECK /gm)].map((m) => m[1]!));

/**
 * Applies one later migration's statements to the earlier statements, as Postgres would. `checks`
 * holds the CHECK constraint names that exist so far; a migration may drop and add them, and that
 * never touches what Prisma generates.
 */
function replay(init: string[], migration: string, name: string, checks: Set<string> = new Set()): string[] {
  let out = init;
  const drop = (what: string, matches: (s: string) => boolean) => {
    const kept = out.filter((s) => !matches(bare(s)));
    if (kept.length === out.length) throw new Error(`${name}: ${what} matches nothing in the earlier migrations`);
    out = kept;
  };
  const change = (what: string, find: (s: string) => boolean, edit: (s: string) => string) => {
    const at = out.findIndex((s) => find(bare(s)));
    if (at < 0) throw new Error(`${name}: ${what} matches nothing in the earlier migrations`);
    const next = edit(out[at]!);
    if (next === out[at]) throw new Error(`${name}: ${what} could not be applied`);
    out = [...out.slice(0, at), next, ...out.slice(at + 1)];
  };
  // A new statement carries the step comment Prisma writes above it in a fresh script.
  const add = (step: string, stmt: string) => {
    out = [...out, `-- ${step}\n${stmt}`];
  };
  for (const stmt of statements(migration).map(bare).filter(Boolean)) {
    const dropConstraint = /^ALTER TABLE "(\w+)" DROP CONSTRAINT "(\w+)"$/.exec(stmt);
    const addCheck = /^ALTER TABLE "\w+" ADD CONSTRAINT "(\w+)" CHECK \(.+\)$/s.exec(stmt);
    const table = /^DROP TABLE "(\w+)"$/.exec(stmt);
    const addValue = /^ALTER TYPE "(\w+)" ADD VALUE ('[\w]+')(?: (AFTER|BEFORE) ('[\w]+'))?$/.exec(stmt);
    const addColumn = /^ALTER TABLE "(\w+)" ADD COLUMN\s+(".+)$/.exec(stmt);
    const dropColumn = /^ALTER TABLE "(\w+)" DROP COLUMN "(\w+)"$/.exec(stmt);
    const setNotNull = /^ALTER TABLE "(\w+)" ALTER COLUMN "(\w+)" SET NOT NULL$/.exec(stmt);
    const dropIndex = /^DROP INDEX "(\w+)"$/.exec(stmt);
    if (addCheck) {
      checks.add(addCheck[1]!);
    } else if (dropConstraint && checks.has(dropConstraint[2]!)) {
      checks.delete(dropConstraint[2]!);
    } else if (dropConstraint) {
      drop(stmt, (s) => s.startsWith(`ALTER TABLE "${dropConstraint[1]}" ADD CONSTRAINT "${dropConstraint[2]}" `));
    } else if (table) {
      const t = table[1];
      drop(stmt, (s) => s.startsWith(`CREATE TABLE "${t}" (`) || s.startsWith(`ALTER TABLE "${t}" `) || / ON "(\w+)"\(/.exec(s)?.[1] === t);
      // Postgres refuses to drop a table another one still references.
      const left = out.find((s) => s.includes(`REFERENCES "${t}"(`));
      if (left) throw new Error(`${name}: "${t}" is still referenced by ${bare(left)}`);
    } else if (addValue) {
      // ADD VALUE appends, so the schema must list the new value last as well, unless it names the
      // value it goes AFTER or BEFORE, which places it there in the schema too.
      const [, type, value, where, next] = addValue;
      change(stmt, (s) => s.startsWith(`CREATE TYPE "${type}" AS ENUM (`), (s) => {
        if (!where) return s.replace(/\)$/, `, ${value})`);
        const list = /\(([^()]*)\)$/.exec(s);
        const values = list?.[1]?.split(", ") ?? [];
        const at = values.indexOf(next!);
        if (!list || at < 0) return s;
        values.splice(where === "AFTER" ? at + 1 : at, 0, value!);
        return `${s.slice(0, list.index)}(${values.join(", ")})`;
      });
    } else if (addColumn) {
      // ADD COLUMN appends, so the schema must list the new field after the model's other columns.
      const pkey = `,\n\n    CONSTRAINT "${addColumn[1]}_pkey" PRIMARY KEY`;
      change(stmt, (s) => s.startsWith(`CREATE TABLE "${addColumn[1]}" (`), (s) => s.replace(pkey, `,\n    ${addColumn[2]},\n\n    CONSTRAINT "${addColumn[1]}_pkey" PRIMARY KEY`));
    } else if (dropColumn) {
      const [, t, column] = dropColumn;
      change(stmt, (s) => s.startsWith(`CREATE TABLE "${t}" (`), (s) => s.replace(new RegExp(`^\\s*"${column}" [^\\n]*\\n`, "m"), ""));
    } else if (setNotNull) {
      // A column added nullable, backfilled, then tightened: what Prisma writes in the table at once.
      const [, t, column] = setNotNull;
      change(stmt, (s) => s.startsWith(`CREATE TABLE "${t}" (`), (s) => s.replace(new RegExp(`^(\\s*"${column}" [^,\n]*)(?<! NOT NULL)(,?)$`, "m"), "$1 NOT NULL$2"));
    } else if (dropIndex) {
      drop(stmt, (s) => new RegExp(`^CREATE (UNIQUE )?INDEX "${dropIndex[1]}" ON `).test(s));
    } else if (/^CREATE (UNIQUE )?INDEX "\w+" ON "\w+"\s*\(.*\) WHERE /s.test(stmt)) {
      // A partial index is an invariant: Prisma never generates one, and its drift check ignores them.
    } else if (/^CREATE TYPE "\w+" AS ENUM \(/.test(stmt)) {
      add("CreateEnum", stmt);
    } else if (/^CREATE TABLE "\w+" \(/.test(stmt)) {
      add("CreateTable", stmt);
    } else if (/^CREATE (UNIQUE )?INDEX "\w+" ON "\w+"/.test(stmt)) {
      add("CreateIndex", stmt);
    } else if (/^ALTER TABLE "\w+" ADD CONSTRAINT "\w+" FOREIGN KEY /.test(stmt)) {
      add("AddForeignKey", stmt);
    } else if (/^(INSERT INTO|UPDATE|DELETE FROM) "\w+"/.test(stmt)) {
      // Data only: moves rows, never the schema.
    } else {
      throw new Error(`${name}: the replay does not know this statement, extend it: ${stmt}`);
    }
  }
  return out;
}

describe("migrations", () => {
  const init = readFileSync(`${MIGRATIONS}0001_init/migration.sql`, "utf8");
  const later = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "0001_init")
    .map((d) => d.name)
    .sort();

  it("names every migration NNNN_snake_case, after the init", () => {
    for (const name of later) {
      expect(name, name).toMatch(/^\d{4}_[a-z0-9_]+$/);
      expect(name > "0001_init", name).toBe(true);
    }
  });

  it("gives every migration its own number, so the order never rests on the rest of a name", () => {
    const numbers = later.map((name) => name.slice(0, 4));
    expect(new Set(numbers).size, numbers.join(" ")).toBe(numbers.length);
  });

  it("replays to exactly the schema (no drift)", () => {
    const generated = execFileSync(
      "npx",
      ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"],
      { cwd: root, encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "ignore"] },
    );
    const at = init.indexOf(MARKER);
    expect(at).toBeGreaterThan(0);
    let replayed = statements(init.slice(0, at));
    const checks = checksIn(init.slice(at));
    for (const name of later) replayed = replay(replayed, readFileSync(`${MIGRATIONS}${name}/migration.sql`, "utf8"), name, checks);
    expect([...replayed].sort()).toEqual([...statements(generated)].sort());
  }, 60_000);

  it("keeps a later migration's invariants to CHECK constraints it can name", () => {
    const known = checksIn(init.slice(init.indexOf(MARKER)));
    /** Each CHECK's table and condition, so a drop can be held to the columns it guards. */
    const defs = new Map<string, { table: string; cond: string }>();
    const learn = (sql: string) => {
      for (const m of sql.matchAll(/^ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)" CHECK (.+);$/gm)) defs.set(m[2]!, { table: m[1]!, cond: m[3]! });
    };
    learn(init.replace(/\r/g, ""));
    for (const name of later) {
      const sql = readFileSync(`${MIGRATIONS}${name}/migration.sql`, "utf8").replace(/\r/g, "");
      const droppedColumns = [...sql.matchAll(/^ALTER TABLE "(\w+)" DROP COLUMN "(\w+)";$/gm)].map((m) => [m[1]!, m[2]!] as const);
      for (const s of statements(sql).map(bare)) {
        const dropped = /^ALTER TABLE "\w+" DROP CONSTRAINT "(\w+)"$/.exec(s)?.[1];
        // A CHECK is dropped only to be added again in the same migration, never lost, or with the
        // column it guards, which the same migration drops.
        const def = dropped ? defs.get(dropped) : undefined;
        const withColumn = !!def && droppedColumns.some(([t, c]) => t === def.table && def.cond.includes(`"${c}"`));
        if (dropped && known.has(dropped)) expect(checksIn(sql).has(dropped) || withColumn, `${name}: ${dropped}`).toBe(true);
      }
      for (const c of checksIn(sql)) known.add(c);
      learn(sql);
    }
    expect([...known]).toEqual(expect.arrayContaining(["icon_images_one_owner", "icon_images_mime_known", "notification_webhooks_telegram_chat"]));
  });

  it("keeps the invariants block to constraints only", () => {
    const block = init.slice(init.indexOf(MARKER));
    for (const line of block.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("--"))) {
      expect(line, line).toMatch(/^ALTER TABLE "\w+" ADD CONSTRAINT "\w+" CHECK \(.+\);$/);
    }
  });

  it("refuses a statement the replay does not know, and a drop of something missing", () => {
    const base = statements('-- CreateTable\nCREATE TABLE "a" (\n    "id" UUID NOT NULL\n);');
    expect(() => replay(base, 'ALTER TABLE "a" ALTER COLUMN "id" TYPE TEXT;', "x")).toThrow(/does not know/);
    expect(() => replay(base, 'GRANT ALL ON "a" TO someone;', "x")).toThrow(/does not know/);
    expect(() => replay(base, 'DROP TABLE "nope";', "x")).toThrow(/matches nothing/);
    expect(() => replay(base, 'ALTER TYPE "Nope" ADD VALUE \'x\';', "x")).toThrow(/matches nothing/);
    expect(replay(base, '-- DropTable\nDROP TABLE "a";', "x")).toEqual([]);
  });

  it("applies the statements Prisma writes for new enums, values, tables, columns, indexes and keys", () => {
    const base = statements([
      '-- CreateEnum\nCREATE TYPE "K" AS ENUM (\'a\');',
      '-- CreateTable\nCREATE TABLE "t" (\n    "id" UUID NOT NULL,\n\n    CONSTRAINT "t_pkey" PRIMARY KEY ("id")\n);',
    ].join("\n\n"));
    const out = replay(base, [
      'ALTER TYPE "K" ADD VALUE \'b\';',
      'ALTER TABLE "t" ADD COLUMN     "x" UUID;',
      'CREATE TABLE "u" (\n    "id" UUID NOT NULL\n);',
      'CREATE UNIQUE INDEX "t_x_key" ON "t"("x");',
      'ALTER TABLE "t" ADD CONSTRAINT "t_x_fkey" FOREIGN KEY ("x") REFERENCES "u"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      'INSERT INTO "u" ("id") SELECT "id" FROM "t";',
      'ALTER TABLE "t" ADD CONSTRAINT "t_x_set" CHECK ("x" IS NOT NULL);',
    ].join("\n"), "x");
    expect(out).toEqual([
      '-- CreateEnum\nCREATE TYPE "K" AS ENUM (\'a\', \'b\')',
      '-- CreateTable\nCREATE TABLE "t" (\n    "id" UUID NOT NULL,\n    "x" UUID,\n\n    CONSTRAINT "t_pkey" PRIMARY KEY ("id")\n)',
      '-- CreateTable\nCREATE TABLE "u" (\n    "id" UUID NOT NULL\n)',
      '-- CreateIndex\nCREATE UNIQUE INDEX "t_x_key" ON "t"("x")',
      '-- AddForeignKey\nALTER TABLE "t" ADD CONSTRAINT "t_x_fkey" FOREIGN KEY ("x") REFERENCES "u"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    ]);
  });

  it("places a value named AFTER or BEFORE another one where Postgres puts it", () => {
    const base = statements('-- CreateEnum\nCREATE TYPE "K" AS ENUM (\'a\', \'c\');');
    expect(replay(base, 'ALTER TYPE "K" ADD VALUE \'b\' AFTER \'a\';', "x")).toEqual(['-- CreateEnum\nCREATE TYPE "K" AS ENUM (\'a\', \'b\', \'c\')']);
    expect(replay(base, 'ALTER TYPE "K" ADD VALUE \'z\' BEFORE \'a\';', "x")).toEqual(['-- CreateEnum\nCREATE TYPE "K" AS ENUM (\'z\', \'a\', \'c\')']);
    expect(() => replay(base, 'ALTER TYPE "K" ADD VALUE \'b\' AFTER \'nope\';', "x")).toThrow(/could not be applied/);
  });

  it("applies a backfilled column's SET NOT NULL, a dropped index, and ignores a partial index", () => {
    const base = statements([
      '-- CreateTable\nCREATE TABLE "t" (\n    "id" UUID NOT NULL,\n\n    CONSTRAINT "t_pkey" PRIMARY KEY ("id")\n);',
      '-- CreateIndex\nCREATE INDEX "t_id_idx" ON "t"("id");',
    ].join("\n\n"));
    const out = replay(base, [
      'ALTER TABLE "t" ADD COLUMN     "x" UUID;',
      'UPDATE "t" SET "x" = "id";',
      'ALTER TABLE "t" ALTER COLUMN "x" SET NOT NULL;',
      'DROP INDEX "t_id_idx";',
      'CREATE UNIQUE INDEX "t_one" ON "t"("x") WHERE "x" IS NOT NULL;',
    ].join("\n"), "x");
    expect(out).toEqual(['-- CreateTable\nCREATE TABLE "t" (\n    "id" UUID NOT NULL,\n    "x" UUID NOT NULL,\n\n    CONSTRAINT "t_pkey" PRIMARY KEY ("id")\n)']);
    expect(() => replay(base, 'ALTER TABLE "t" ALTER COLUMN "nope" SET NOT NULL;', "x")).toThrow(/could not be applied/);
    expect(() => replay(base, 'ALTER TABLE "t" ALTER COLUMN "id" SET NOT NULL;', "x")).toThrow(/could not be applied/);
    expect(() => replay(base, 'DROP INDEX "nope";', "x")).toThrow(/matches nothing/);
  });

  it("lets a migration drop and re-add a CHECK, which Prisma never sees", () => {
    const checks = new Set(["t_one_owner"]);
    const base = statements('-- CreateTable\nCREATE TABLE "t" (\n    "id" UUID NOT NULL\n);');
    expect(replay(base, 'ALTER TABLE "t" DROP CONSTRAINT "t_one_owner";\nALTER TABLE "t" ADD CONSTRAINT "t_one_owner" CHECK (true);', "x", checks)).toEqual(base);
    expect(checks.has("t_one_owner")).toBe(true);
    // An unknown name is not a CHECK: it must be a generated constraint that exists.
    expect(() => replay(base, 'ALTER TABLE "t" DROP CONSTRAINT "t_other";', "x", new Set())).toThrow(/matches nothing/);
  });
});
