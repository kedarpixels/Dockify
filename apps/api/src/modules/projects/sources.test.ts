import { describe, expect, it } from "vitest";
import { projects as P } from "@dockify/contracts";
import { appColumns, checkSpec, dockerVolumeName, STORAGE_UNAVAILABLE, type AppSpec } from "./app-source.ts";
import { composeToSpecs, parseComposeText } from "./compose.ts";
import { registryHost as registryHostOf } from "@dockify/contracts";
import { isBlockedHost } from "./host-rule.ts";
import { slugCandidate, slugify } from "./views.ts";

const spec = (over: Record<string, unknown>): AppSpec => P.AppSpec.parse({ name: "web", kind: "backend", target: "server", source: { type: "image", image: "nginx:1.27", registryId: null }, ...over });
const reasons = (s: AppSpec) => checkSpec(s).map((r) => r.field);

describe("host rule", () => {
  it.each(["localhost", "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "db.internal", "printer.local", "intranet"])(
    "blocks %s",
    (h) => expect(isBlockedHost(h)).toBe(true),
  );
  it.each(["github.com", "registry.gitlab.com", "8.8.8.8", "2606:4700::1111"])("allows %s", (h) => expect(isBlockedHost(h)).toBe(false));
  it("reads the registry host of an image", () => {
    expect(registryHostOf("nginx:1.27")).toBeNull();
    expect(registryHostOf("library/nginx")).toBeNull();
    expect(registryHostOf("ghcr.io/o/r:1")).toBe("ghcr.io");
    expect(registryHostOf("10.0.0.5:5000/x")).toBe("10.0.0.5");
    expect(registryHostOf("localhost/x")).toBe("localhost");
  });
});

describe("new app refusals", () => {
  it("accepts a plain image app and maps its columns", () => {
    const s = spec({ run: { startCommand: "", port: 8080 } });
    expect(checkSpec(s)).toEqual([]);
    expect(appColumns(s)).toMatchObject({ image: "nginx:1.27", port: 8080, startCommand: null, gitRepository: null });
  });
  it("refuses an image from a registry the gate refuses, and takes one on a LAN", () => {
    for (const image of ["127.0.0.1:5000/app", "169.254.169.254/app", "172.30.3.2:5432/app", "localhost:5000/app", "0x7f.0.0.1:5000/app"]) {
      expect(reasons(spec({ source: { type: "image", image, registryId: null } })), image).toContain("source.image");
    }
    for (const image of ["10.0.0.5:5000/app", "192.168.1.5:5000/app", "registry.lan:5000/app"]) {
      expect(reasons(spec({ source: { type: "image", image, registryId: null } })), image).not.toContain("source.image");
    }
  });
  it("ties service kinds to service sources and versions to the allowlist", () => {
    expect(reasons(spec({ kind: "postgres" }))).toContain("kind");
    expect(reasons(spec({ kind: "redis", source: { type: "service", service: "postgres", version: "16" } }))).toContain("kind");
    expect(reasons(spec({ kind: "postgres", source: { type: "service", service: "postgres", version: "9" } }))).toContain("source.version");
    const pg = spec({ kind: "postgres", source: { type: "service", service: "postgres", version: "17" } });
    expect(checkSpec(pg)).toEqual([]);
    expect(appColumns(pg)).toMatchObject({ image: "postgres:17-alpine", port: 5432 });
    const redis = spec({ kind: "redis", source: { type: "service", service: "redis", version: "8.2" } });
    expect(checkSpec(redis)).toEqual([]);
    expect(appColumns(redis)).toMatchObject({ image: "redis:8.2-alpine", port: 6379 });
  });
  it("refuses Storage: MinIO no longer publishes an image", () => {
    const minio = spec({ kind: "s3", source: { type: "service", service: "minio", version: "latest" } });
    expect(checkSpec(minio)).toEqual([{ field: "source.service", reason: STORAGE_UNAVAILABLE }]);
  });
  it("gives a managed service no variables and no volumes but its own", () => {
    const s = spec({ kind: "redis", source: { type: "service", service: "redis", version: "7.4" }, env: [{ key: "A", value: "1" }], volumes: [{ name: "x", path: "/data" }] });
    expect(reasons(s)).toEqual(expect.arrayContaining(["env", "volumes"]));
  });
  it("refuses build settings on an image and a Vercel target off git", () => {
    expect(reasons(spec({ build: { builder: "auto", framework: null, rootDir: "", buildCommand: "", startCommand: "", dockerfilePath: "", port: null } }))).toContain("build");
    expect(reasons(spec({ kind: "frontend", target: "vercel" }))).toContain("target");
  });
  it("refuses dangerous mounts, duplicates and reserved keys", () => {
    const s = spec({
      volumes: [{ name: "a", path: "/etc" }, { name: "a", path: "/data" }, { name: "b", path: "/data" }, { name: "c", path: "/proc/x" }],
      env: [{ key: "DOCKIFY_TOKEN", value: "x" }, { key: "A", value: "1" }, { key: "A", value: "2" }],
    });
    expect(reasons(s)).toEqual(expect.arrayContaining(["volumes.0.path", "volumes.1.name", "volumes.2.path", "volumes.3.path", "env.0.key", "env.2.key"]));
  });
  it("maps a git app with a Dockerfile default", () => {
    const s = spec({
      kind: "frontend",
      source: { type: "git", repoUrl: "https://github.com/o/r", branch: "main" },
      build: { builder: "dockerfile", framework: null, rootDir: "web", buildCommand: "", startCommand: "", dockerfilePath: "Dockerfile.prod", port: 3000 },
    });
    expect(checkSpec(s)).toEqual([]);
    expect(appColumns(s)).toMatchObject({ gitRepository: "https://github.com/o/r", gitBranch: "main", rootDir: "web", dockerfilePath: "Dockerfile.prod", port: 3000 });
  });
  it("namespaces docker volume names by app", () => {
    expect(dockerVolumeName("0a1b2c3d-4e5f-6789-abcd-ef0123456789", "data")).toBe("dk-0a1b2c3d4e5f-data");
  });
});

describe("compose import", () => {
  const base = {
    services: {
      web: { image: "ghcr.io/acme/web:1.2", ports: ["8080:3000"], environment: { NODE_ENV: "production" }, volumes: ["uploads:/app/uploads"], restart: "always" },
      db: { image: "postgres:16-alpine", volumes: ["pg:/var/lib/postgresql/data"] },
      worker: { image: "ghcr.io/acme/worker:1.2", command: ["node", "worker.js", "--queue=main"] },
    },
    volumes: { uploads: {}, pg: {} },
  };

  it("maps services to app specs with warnings for what it drops", () => {
    const r = composeToSpecs(base);
    expect(r.refusals).toEqual([]);
    expect(r.specs.map((s) => [s.name, s.kind, s.source.type])).toEqual([["web", "backend", "image"], ["db", "postgres", "service"], ["worker", "bot", "image"]]);
    expect(r.specs[0]?.run?.port).toBe(3000);
    expect(r.specs[2]?.run?.startCommand).toBe("node worker.js --queue=main");
    expect(r.warnings.join(" ")).toMatch(/host port is not published/);
    expect(r.warnings.join(" ")).toMatch(/restart is ignored/);
    // The database runs on its own managed volume, with no variables from the file.
    expect(r.specs[1]?.volumes).toBeUndefined();
    expect(r.specs[1]?.env).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/db: Dockify keeps its data on its own volume and backs it up; its volumes are not imported/);
  });

  it("refuses a MinIO service: Storage is not offered", () => {
    const r = composeToSpecs({ services: { files: { image: "minio/minio:latest" } } });
    expect(r.specs).toEqual([]);
    expect(r.refusals).toEqual([{ field: "services.files.image", reason: STORAGE_UNAVAILABLE }]);
  });

  it.each([
    ["privileged", { privileged: true }],
    ["cap_add", { cap_add: ["SYS_ADMIN"] }],
    ["network_mode", { network_mode: "host" }],
    ["pid", { pid: "host" }],
    ["devices", { devices: ["/dev/kvm"] }],
    ["build", { build: "." }],
    ["env_file", { env_file: ".env" }],
    ["security_opt", { security_opt: ["seccomp:unconfined"] }],
    ["sysctls", { sysctls: { "kernel.x": "1" } }],
  ])("refuses %s", (_k, extra) => {
    const r = composeToSpecs({ services: { app: { image: "nginx:1.27", ...extra } } });
    expect(r.specs).toEqual([]);
    expect(r.refusals.length).toBeGreaterThan(0);
  });

  it("refuses host paths, the docker socket and undeclared volumes", () => {
    for (const v of ["./data:/data", "/var/run/docker.sock:/var/run/docker.sock", "~/x:/x", "undeclared:/data"]) {
      expect(composeToSpecs({ services: { app: { image: "nginx:1.27", volumes: [v] } } }).refusals.length).toBeGreaterThan(0);
    }
    expect(composeToSpecs({ services: { app: { image: "nginx:1.27", volumes: [{ type: "bind", source: "/", target: "/host" }] } } }).refusals.length).toBe(1);
  });

  it("refuses host interpolation, valueless env, unpinned databases, UDP and unknown keys", () => {
    expect(composeToSpecs({ services: { a: { image: "nginx:1.27", environment: ["SECRET=${HOST_SECRET}"] } } }).refusals.length).toBe(1);
    expect(composeToSpecs({ services: { a: { image: "nginx:1.27", environment: ["FROM_HOST"] } } }).refusals.length).toBe(1);
    expect(composeToSpecs({ services: { a: { image: "postgres" } } }).refusals[0]?.reason).toMatch(/Pin a postgres version/);
    expect(composeToSpecs({ services: { a: { image: "nginx:1.27", ports: ["53:53/udp"] } } }).refusals.length).toBeGreaterThan(0);
    expect(composeToSpecs({ services: { a: { image: "nginx:1.27", frobnicate: 1 } } }).refusals[0]?.field).toBe("services.a.frobnicate");
  });

  it("refuses two services that map to one app name", () => {
    expect(composeToSpecs({ services: { Web: { image: "nginx:1.27" }, web: { image: "nginx:1.27" } } }).refusals[0]?.reason).toMatch(/Two services/);
  });

  it("refuses a deeply nested file before the parser sees it", () => {
    // The parser overflows its stack on this on Linux, so it must never be handed it.
    for (const deep of [`${"[".repeat(100_000)}${"]".repeat(100_000)}`, `${"{a: ".repeat(65)}1${"}".repeat(65)}`]) {
      const r = parseComposeText(deep);
      expect(r.specs).toEqual([]);
      expect(r.refusals[0]).toMatchObject({ field: "compose", reason: expect.stringMatching(/nested more than 64/) });
    }
    expect(parseComposeText(`services:\n  web:\n    image: nginx:1.27\n    environment: ${"[".repeat(3)}${"]".repeat(3)}\n`).refusals[0]?.reason ?? "").not.toMatch(/nested/);
  });

  it("reads JSON and YAML text, and refuses broken, duplicate-key or alias-bomb YAML", () => {
    expect(parseComposeText(JSON.stringify(base)).specs).toHaveLength(3);
    const yaml = parseComposeText("services:\n  web:\n    image: nginx:1.27\n");
    expect(yaml.refusals).toEqual([]);
    expect(yaml.specs).toHaveLength(1);
    expect(parseComposeText("services: [unclosed").refusals[0]?.field).toBe("compose");
    expect(parseComposeText("services:\n  a: 1\n  a: 2\n").refusals[0]?.field).toBe("compose");
    const names = "abcdefghij";
    const bomb = [`a: &a [${Array(10).fill("x").join(",")}]`];
    for (let i = 1; i < names.length; i++) bomb.push(`${names[i]}: &${names[i]} [${Array(10).fill(`*${names[i - 1]}`).join(",")}]`);
    expect(parseComposeText(bomb.join("\n")).refusals[0]?.field).toBe("compose");
  });
});

describe("slugs", () => {
  it("derives a contract slug and suffixes within 40 characters", () => {
    expect(slugify("  Inkwell Website!  ")).toBe("inkwell-website");
    expect(slugify("Café Été")).toBe("cafe-ete");
    expect(slugify("***")).toBe("");
    const long = slugify("a".repeat(60));
    expect(long).toHaveLength(40);
    expect(slugCandidate(long, 2)).toHaveLength(40);
    expect(slugCandidate(long, 2).endsWith("-3")).toBe(true);
  });
});
