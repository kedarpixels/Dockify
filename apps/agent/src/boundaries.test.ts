/**
 * The agent runs on a node a hostile tenant may share. No database client and no key handling may ever
 * reach it, directly or through a package it uses, so a node holds nothing of the control plane's.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FORBIDDEN = ["@dockify/db", "@dockify/crypto", "@prisma/client"];

const packageDir = (name: string) => join(ROOT, "packages", name.replace("@dockify/", ""));
const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };

function dependencyClosure(dir: string, seen = new Set<string>()): Set<string> {
  for (const dep of Object.keys(manifest(dir).dependencies ?? {})) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    if (dep.startsWith("@dockify/")) dependencyClosure(packageDir(dep), seen);
  }
  return seen;
}

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((f) => {
    if (f.name === "node_modules") return [];
    const p = join(dir, f.name);
    return f.isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });

describe("apps/agent's boundary", () => {
  const agent = join(ROOT, "apps", "agent");

  it("depends on neither the database nor the crypto package, at any depth", () => {
    const all = dependencyClosure(agent);
    for (const f of FORBIDDEN) expect([...all], f).not.toContain(f);
  });

  it("imports neither from any file, nor reaches into another app", () => {
    for (const root of [join(agent, "src"), packageDir("engine"), packageDir("redact"), packageDir("contracts")]) {
      for (const file of sources(root)) {
        if (file.endsWith("boundaries.test.ts")) continue;
        const text = readFileSync(file, "utf8");
        for (const f of FORBIDDEN) expect(text.includes(`"${f}"`), `${file} names ${f}`).toBe(false);
        expect(/from "(?:\.\.\/)+(?:apps\/)?(?:worker|api|web)\//.test(text), `${file} reaches into another app`).toBe(false);
      }
    }
  });

  it("is not given a secret the control plane holds", () => {
    const text = sources(join(agent, "src")).filter((f) => !f.endsWith(".test.ts")).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const name of ["DATABASE_URL", "DOCKIFY_MASTER_KEY", "DOCKIFY_INTERNAL_TOKEN", "DOCKIFY_DB_PASSWORD"]) expect(text.includes(name), name).toBe(false);
  });
});
