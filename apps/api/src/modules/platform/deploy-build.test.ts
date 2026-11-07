// Regression tests for the release image build inputs (deploy/Dockerfile, .dockerignore,
// deploy/prisma-cli). They read the files in the repo; nothing is built or pulled.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const dockerfile = read("deploy/Dockerfile");

/** One Dockerfile stage: from its FROM line up to the next one. */
function stage(name: string): string {
  const start = dockerfile.search(new RegExp(`^FROM \\S+ AS ${name}$`, "m"));
  expect(start, name).toBeGreaterThanOrEqual(0);
  const rest = dockerfile.slice(start + 1);
  const next = rest.search(/^FROM /m);
  return next < 0 ? dockerfile.slice(start) : dockerfile.slice(start, start + 1 + next);
}

/** Joins backslash continuations so each instruction is one line. */
const instructions = (text: string) => text.replace(/\\\n/g, " ").split("\n").map((l) => l.trim());

/** Minimal .dockerignore matcher with Docker's rules: last matching pattern wins, a match on a parent dir covers its children. */
function ignored(rules: string, path: string): boolean {
  const pats = rules
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const negate = l.startsWith("!");
      const glob = (negate ? l.slice(1) : l).replace(/^\/+|\/+$/g, "");
      const re = glob
        .split("/")
        .map((seg) => (seg === "**" ? "(?:.*)" : seg.replace(/[.+^${}()|[\]]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")))
        .join("/")
        .replace(/\(\?:\.\*\)\//g, "(?:.*/)?");
      return { negate, re: new RegExp(`^${re}$`) };
    });
  const parts = path.split("/");
  let excluded = false;
  for (const p of pats) {
    for (let i = 1; i <= parts.length; i++) {
      if (p.re.test(parts.slice(0, i).join("/"))) {
        excluded = !p.negate;
        break;
      }
    }
  }
  return excluded;
}

describe("build context (.dockerignore)", () => {
  const rootIgnore = read(".dockerignore");

  it("ships the same rules at the root and beside the Dockerfile", () => {
    expect(read("deploy/Dockerfile.dockerignore")).toBe(rootIgnore);
  });

  it("is an allowlist that keeps every workstation artifact out of the image", () => {
    expect(rootIgnore.split("\n").find((l) => l.trim() && !l.startsWith("#"))).toBe("*");
    for (const path of [
      "apps/web/node_modules/next/package.json",
      "apps/api/node_modules/fastify/package.json",
      "apps/worker/node_modules/x/index.js",
      "packages/db/node_modules/.bin/prisma",
      "node_modules/.pnpm/lock.yaml",
      "apps/web/.next/standalone/server.js",
      "apps/api/.turbo/turbo-test.log",
      ".turbo/cache/x",
      "packages/db/generated/client/index.js",
      "apps/web/tsconfig.tsbuildinfo",
      "apps/web/next-env.d.ts",
      ".env",
      "apps/api/.env.local",
      "packages/db/.env",
      "notes/internal.md",
      "screenshot.png",
      ".git/config",
      "docs/README.md",
      "installer/install.sh",
    ]) {
      expect(ignored(rootIgnore, path), path).toBe(true);
    }
  });

  it("still sends every source file the build needs", () => {
    for (const path of [
      "package.json",
      "pnpm-lock.yaml",
      "apps/web/app/layout.tsx",
      "apps/web/public/dockify-logo.png",
      "apps/web/pnpm-lock.yaml",
      "apps/api/src/main.ts",
      "packages/db/prisma/schema.prisma",
      "deploy/entrypoint.sh",
      "deploy/prisma-cli/package-lock.json",
    ]) {
      expect(ignored(rootIgnore, path), path).toBe(false);
    }
    for (const line of instructions(dockerfile)) {
      if (!line.startsWith("COPY ") || line.includes("--from=")) continue;
      const srcs = line.split(/\s+/).slice(1, -1);
      for (const src of srcs) expect(ignored(rootIgnore, src.replace(/\/$/, "")), src).toBe(false);
    }
  });
});

describe("web image", () => {
  const web = instructions(stage("web-build"));

  it("never copies the whole apps/web folder over the frozen install", () => {
    const copies = web.filter((l) => l.startsWith("COPY "));
    for (const c of copies) expect(c, c).not.toMatch(/\sapps\/web\/?\s/);
    const install = web.findIndex((l) => /pnpm install --frozen-lockfile/.test(l));
    expect(install).toBeGreaterThan(0);
    // After the install only named source paths may land, never node_modules or build output.
    const allowed = /^apps\/web\/(app|components|lib|public|next\.config\.ts|tsconfig\.json|proxy\.ts)$/;
    for (const c of web.slice(install + 1).filter((l) => l.startsWith("COPY "))) {
      for (const src of c.split(/\s+/).slice(1, -1)) expect(src, c).toMatch(allowed);
    }
  });
});

describe("pinned build inputs", () => {
  it("pins every apk package to an exact version", () => {
    const adds = instructions(dockerfile).filter((l) => /^RUN apk add/.test(l));
    expect(adds.length).toBeGreaterThanOrEqual(2);
    for (const line of adds) {
      const cmd = line.replace(/^RUN /, "").split("&&")[0] ?? "";
      const pkgs = cmd.trim().split(/\s+/).slice(2).filter((w) => !w.startsWith("-"));
      expect(pkgs.length, line).toBeGreaterThan(0);
      for (const p of pkgs) expect(p, p).toMatch(/^[a-z0-9.+-]+=\d[\w.]*-r\d+$/);
    }
  });

  it("activates pnpm by version and tarball sha512, matching the repo's packageManager", () => {
    const version = /^ARG PNPM_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
    const sha = /^ARG PNPM_SHA512=(\S+)$/m.exec(dockerfile)?.[1];
    expect(sha).toMatch(/^[a-f0-9]{128}$/);
    expect(JSON.parse(read("package.json")).packageManager).toBe(`pnpm@${version}`);
    expect(dockerfile).toContain('corepack prepare "pnpm@${PNPM_VERSION}+sha512.${PNPM_SHA512}" --activate');
    expect(dockerfile).toMatch(/^ENV COREPACK_ENABLE_NETWORK=0$/m);
    expect(dockerfile).not.toMatch(/corepack prepare pnpm@\$\{PNPM_VERSION\} /);
  });

  it("installs the Prisma CLI only from the committed lockfile, at the client's version", () => {
    expect(dockerfile).not.toMatch(/(^|[^p])npm install/m);
    expect(dockerfile).not.toMatch(/package-lock=false/);
    expect(dockerfile).toContain("COPY deploy/prisma-cli/package.json deploy/prisma-cli/package-lock.json /opt/prisma/");
    expect(dockerfile).toMatch(/^RUN npm ci --prefix \/opt\/prisma /m);

    const lock = JSON.parse(read("deploy/prisma-cli/package-lock.json")) as {
      lockfileVersion: number;
      packages: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }>;
    };
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(2);
    const entries = Object.entries(lock.packages).filter(([k]) => k !== "");
    expect(entries.length).toBeGreaterThan(1);
    for (const [name, p] of entries) {
      expect(p.link, name).toBeUndefined();
      expect(p.resolved, name).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(p.integrity, name).toMatch(/^sha512-/);
    }
    const cliVersion = lock.packages["node_modules/prisma"]?.version;
    const manifest = JSON.parse(read("deploy/prisma-cli/package.json")) as { dependencies: Record<string, string> };
    expect(manifest.dependencies.prisma).toBe(cliVersion);
    const pnpmLock = read("pnpm-lock.yaml");
    expect(pnpmLock).toContain(`\n  prisma@${cliVersion}:`);
    expect(pnpmLock).toContain(`\n  '@prisma/client@${cliVersion}':`);
  });
});
