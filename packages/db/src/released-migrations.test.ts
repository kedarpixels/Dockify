import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Released migrations never change. An install records the checksum of every migration it applied
 * and `prisma migrate deploy` never runs one twice, so an edit to a shipped migration reaches no
 * existing install: they silently miss it while fresh installs get it. prisma/released-migrations.json lists every
 * migration a release shipped with the sha256 of its exact bytes; this test holds the files to it.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = join(root, "prisma", "migrations");
const MANIFEST = join(root, "prisma", "released-migrations.json");
const NAME = /^\d{4}_[a-z0-9_]+$/;

interface Manifest {
  released: Array<{ name: string; sha256: string }>;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Everything wrong with a migrations folder against a manifest, one line each. */
export function releasedProblems(dir: string, manifest: Manifest): string[] {
  const problems: string[] = [];
  const names = manifest.released.map((r) => r.name);
  if (new Set(names).size !== names.length) problems.push("a migration is listed twice");
  if (names.join("\n") !== [...names].sort().join("\n")) problems.push("the list is not in migration order");
  for (const r of manifest.released) {
    if (!NAME.test(r.name) || !/^[a-f0-9]{64}$/.test(r.sha256)) {
      problems.push(`${r.name}: not a migration name and a sha256`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dir, r.name, "migration.sql"));
    } catch {
      problems.push(`${r.name}: released, but its migration.sql is gone`);
      continue;
    }
    const got = sha256(bytes);
    if (got !== r.sha256) problems.push(`${r.name}: changed after release (sha256 ${got}, released ${r.sha256}); put the change in a new migration`);
  }
  // A new migration goes after every released one: one sorted in between would run out of order on
  // installs that applied the later ones.
  const newest = [...names].sort().at(-1);
  if (newest) {
    const present = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const n of present) if (n < newest && !names.includes(n)) problems.push(`${n}: sorts before the released ${newest} but was never released`);
  }
  return problems;
}

const manifest = (): Manifest => JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;

describe("released migrations", () => {
  it("are byte for byte what shipped", () => {
    expect(releasedProblems(MIGRATIONS, manifest())).toEqual([]);
  });

  it("include the 0001_init the first installs applied", () => {
    // The checksum in the test server's _prisma_migrations table for 0001_init.
    expect(manifest().released[0]).toEqual({ name: "0001_init", sha256: "1a3e285f9dc6d2af1c58f01d99533dcfaaf33e34be1e41ee988b9ece3899d74d" });
  });

  describe("the check itself", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const folder = (files: Record<string, string>) => {
      const d = mkdtempSync(join(tmpdir(), "dk-mig-"));
      dirs.push(d);
      for (const [name, sql] of Object.entries(files)) {
        mkdirSync(join(d, name));
        writeFileSync(join(d, name, "migration.sql"), sql);
      }
      return d;
    };
    const sum = (s: string) => sha256(Buffer.from(s));

    it("fails when a released file changes, even by a line ending", () => {
      const d = folder({ "0001_init": "CREATE TABLE a ();\r\n" });
      const out = releasedProblems(d, { released: [{ name: "0001_init", sha256: sum("CREATE TABLE a ();\n") }] });
      expect(out).toHaveLength(1);
      expect(out[0]).toMatch(/0001_init: changed after release/);
    });

    it("fails when a released migration is deleted, or a new one sorts before a released one", () => {
      const d = folder({ "0001_init": "a", "0002_new": "b", "0003_shipped": "c" });
      const out = releasedProblems(d, { released: [{ name: "0001_init", sha256: sum("a") }, { name: "0003_shipped", sha256: sum("c") }, { name: "0004_gone", sha256: sum("d") }] });
      expect(out.sort()).toEqual([
        "0002_new: sorts before the released 0004_gone but was never released",
        "0004_gone: released, but its migration.sql is gone",
      ]);
    });

    it("passes unreleased migrations after the newest released one", () => {
      const d = folder({ "0001_init": "a", "0002_next": "b" });
      expect(releasedProblems(d, { released: [{ name: "0001_init", sha256: sum("a") }] })).toEqual([]);
    });
  });
});
