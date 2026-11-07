/**
 * Builds without a Dockerfile. What a hostile repository could reach goes through these functions:
 * what enters the plan step, what the build is allowed to ask BuildKit for, and what is believed of
 * the files the plan step wrote. The pins are checked against the Dockerfile and the daemon's config.
 */
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return { ...mod, spawn: vi.fn() };
});

const { spawn } = await import("node:child_process");
const { buildCacheScope, buildImage, checkSyntaxDirective, dockerfileCandidates, findDockerfile, planBuild } = await import("@dockify/engine");
const R = await import("@dockify/engine");
type RepoHints = import("@dockify/engine").RepoHints;
const { isPermanent, PermanentDeployError } = await import("@dockify/engine");
const { DeployLog } = await import("./log.ts");
const { detectAnswer, detectPort } = await import("./detect.ts");
type DockerApi = import("@dockify/engine").DockerApi;
type BuildVar = import("@dockify/engine").BuildVar;

const SECRET = "s3cret-value-in-a-variable";
const vars: BuildVar[] = [
  { key: "API_KEY", value: SECRET, isSecret: true, target: "both" },
  { key: "NEXT_PUBLIC_URL", value: "https://a.example", isSecret: false, target: "build" },
  { key: "RUNTIME_ONLY", value: "not-for-builds", isSecret: true, target: "runtime" },
  { key: "RAILPACK_NODE_VERSION", value: "22", isSecret: false, target: "build" },
  { key: "RAILPACK_PACKAGES", value: SECRET, isSecret: true, target: "build" },
  { key: "bad key;rm -rf /", value: "x", isSecret: false, target: "build" },
];
const NO_OVERRIDES = { installCommand: "", buildCommand: "", startCommand: "" };

describe("the port a deploy can settle on", () => {
  it("reads the lowest TCP port an image exposes", async () => {
    const { exposedPort } = await import("./pipeline.ts");
    expect(exposedPort({ Config: { ExposedPorts: { "8080/tcp": {}, "9000/tcp": {}, "53/udp": {} } } })).toBe(8080);
    expect(exposedPort({ Config: { ExposedPorts: { "80": {} } } })).toBe(80);
    for (const Config of [{}, { ExposedPorts: null }, { ExposedPorts: { "53/udp": {} } }, { ExposedPorts: { "0/tcp": {}, "70000/tcp": {} } }]) expect(exposedPort({ Config })).toBeNull();
    expect(exposedPort({})).toBeNull();
  });

  it("gives each stack its usual one", () => {
    expect(R.plannedPort({ framework: "Next.js", provider: "node" })).toBe(3000);
    expect(R.plannedPort({ framework: "Flask", provider: "python" })).toBe(8000);
    expect(R.plannedPort({ framework: null, provider: "golang" })).toBe(8080);
    expect(R.plannedPort({ framework: null, provider: null })).toBeNull();
  });
});

describe("repository hints the plan step gets", () => {
  const hints = (nextConfig: string | null, over: Partial<RepoHints> = {}): RepoHints => ({ nextConfig, packageJson: null, railpackJson: null, hasAppPy: false, hasMainPy: false, ...over });

  it("serves a static export with Caddy from the folder it writes, however the setting is spaced", () => {
    for (const cfg of [`{ output: "export" }`, `{ output:'export' }`, `{\n  output  :  "export",\n}`]) {
      expect(R.planHintArgs({ startCommand: "" }, [], hints(cfg)), cfg).toEqual(["--env", "RAILPACK_SPA_OUTPUT_DIR=out"]);
    }
    expect(R.nextExportDir(hints(`{ output: "export", distDir: "./build/" }`))).toBe("build");
  });

  it("takes no setting from a config that does not export, or from a comment", () => {
    for (const cfg of [null, `{}`, `{ output: "standalone" }`, `// output: "export"\n{}`, `/* output: "export" */ {}`]) {
      expect(R.nextExportDir(hints(cfg)), String(cfg)).toBeNull();
    }
  });

  it("leaves it to an owner who said how it starts", () => {
    const cfg = `{ output: "export" }`;
    expect(R.planHintArgs({ startCommand: "node x.js" }, [], hints(cfg))).toEqual([]);
    expect(R.planHintArgs({ startCommand: "" }, [{ key: "RAILPACK_NO_SPA", value: "1", isSecret: false, target: "build" }], hints(cfg))).toEqual([]);
    expect(R.planHintArgs({ startCommand: "" }, [], hints(cfg, { railpackJson: "{}" }))).toEqual([]);
    expect(R.planHintArgs({ startCommand: "" }, [], hints(cfg, { packageJson: JSON.stringify({ scripts: { start: "serve out" } }) }))).toEqual([]);
  });

  it("never takes a hostile folder name from the config", () => {
    for (const dist of ["../../etc", "a b", "$(reboot)", "/etc", "a/../b"]) {
      expect(R.nextExportDir(hints(`{ output: "export", distDir: "${dist}" }`)), dist).toBe("out");
    }
  });

  it("points a Python start at app.py only when there is no main.py", () => {
    const start = "gunicorn --bind 0.0.0.0:${PORT:-8000} main:app";
    expect(R.pythonEntryStart(start, { hasAppPy: true, hasMainPy: false })).toBe("gunicorn --bind 0.0.0.0:${PORT:-8000} app:app");
    expect(R.pythonEntryStart(start, { hasAppPy: true, hasMainPy: true })).toBeNull();
    expect(R.pythonEntryStart(start, { hasAppPy: false, hasMainPy: false })).toBeNull();
    expect(R.pythonEntryStart("uvicorn main:app --port 80", { hasAppPy: true, hasMainPy: false })).toBe("uvicorn app:app --port 80");
    expect(R.pythonEntryStart("python server.py", { hasAppPy: true, hasMainPy: false })).toBeNull();
    expect(R.pythonEntryStart(null, { hasAppPy: true, hasMainPy: false })).toBeNull();
  });
});

describe("what the plan step is told", () => {
  it("never gets a secret's value, only names with a placeholder and non-secret RAILPACK_ settings", () => {
    const args = R.planEnvArgs(vars, { installCommand: "" });
    expect(args.join(" ")).not.toContain(SECRET);
    expect(args.join(" ")).not.toContain("https://a.example");
    expect(args).toContain("API_KEY=1");
    expect(args).toContain("NEXT_PUBLIC_URL=1");
    expect(args).toContain("RAILPACK_NODE_VERSION=22");
  });

  it("leaves out runtime-only variables, a secret setting, and a name that is not one", () => {
    const text = R.planEnvArgs(vars, { installCommand: "" }).join(" ");
    expect(text).not.toContain("RUNTIME_ONLY");
    expect(text).not.toContain("RAILPACK_PACKAGES");
    expect(text).not.toContain("rm -rf");
  });

  it("lets the form's install command beat a variable of that name", () => {
    const args = R.planEnvArgs([{ key: "RAILPACK_INSTALL_CMD", value: "from-var", isSecret: false, target: "build" }], { installCommand: "pnpm i" });
    expect(args).toEqual(["--env", "RAILPACK_INSTALL_CMD=pnpm i"]);
  });

  it("errors on a plan with no way to start, unless the app or Next's own server gives one", () => {
    expect(R.planCommandArgs(NO_OVERRIDES, null)).toEqual(["--error-missing-start"]);
    expect(R.planCommandArgs({ ...NO_OVERRIDES, startCommand: "node a.js" }, null)).toEqual(["--start-cmd", "node a.js"]);
    expect(R.planCommandArgs(NO_OVERRIDES, "x")).toEqual(["--start-cmd", "x"]);
  });
});

describe("the plan step's Dockerfile", () => {
  const hostile = ['"; rm -rf / #', "$(cat /run/secrets/internal_token)", "line1\nFROM evil\nRUN curl evil", "]", "`id`", "\\", "<<EOF", "${HOME}"];
  const runLine = (text: string) => text.split("\n").find((l) => l.startsWith("RUN "))!;

  it("keeps any value inside one exec-form RUN, as data", () => {
    const text = R.planDockerfile(["--build-cmd", ...hostile]);
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(6);
    expect(lines.filter((l) => /^FROM /.test(l))).toEqual([`FROM ${R.PLAN_BASE_IMAGE} AS plan`, "FROM scratch"]);
    const json = runLine(text).replace(/^RUN --mount=type=bind,source=\.,target=\/app /, "");
    const argv = JSON.parse(json) as string[];
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(argv.slice(-hostile.length)).toEqual(hostile);
    // The shell only ever sees the fixed wrapper, which passes values through "$@".
    for (const h of hostile) expect(argv[2]).not.toContain(h);
    expect(argv[2]).toContain('"$@"');
  });

  it("asks for no frontend, mounts the repository read-only, and brings mise so Railpack never fetches one", () => {
    const text = R.planDockerfile([]);
    expect(text).not.toMatch(/syntax\s*=/i);
    checkSyntaxDirective(text);
    expect(runLine(text)).toContain("--mount=type=bind,source=.,target=/app");
    expect(runLine(text)).not.toMatch(/rw\b/);
    expect(text).toContain(`/tmp/railpack/mise/mise-${R.MISE_VERSION}`);
  });

  it("runs with no secret, no build arg, no cache and no entitlement", () => {
    const args = R.planStepArgs({ buildkitAddr: "unix:///b.sock", contextDir: "/w/repo", stepDir: "/w/step", outDir: "/w/out" });
    const text = args.join(" ");
    expect(text).not.toContain("--secret");
    expect(text).not.toContain("build-arg");
    expect(text).not.toContain("--allow");
    expect(text).not.toContain("gateway");
    expect(args).toContain("--no-cache");
    expect(text).toContain(`tools=${R.TOOLS_DIR}`);
    expect(text).toContain("type=local,dest=/w/out");
  });
});

describe("the Railpack build", () => {
  const plan = () => R.planRailpackBuild({ buildkitAddr: "unix:///b.sock", contextDir: "/w/repo", planDir: "/w/plan", imageName: "dockify/app-a:1", appId: "app-a", cacheScope: "dockify-app-app-a", vars });

  it("names the frontend by digest and asks for no entitlement", () => {
    const text = plan().args.join(" ");
    expect(R.RAILPACK_FRONTEND).toMatch(/^ghcr\.io\/railwayapp\/railpack-frontend:v[\d.]+@sha256:[a-f0-9]{64}$/);
    expect(text).toContain(`--frontend gateway.v0 --opt source=${R.RAILPACK_FRONTEND}`);
    expect(text).not.toContain("--allow");
    expect(text).not.toContain("--export-cache");
    expect(text).not.toContain("github-token");
  });

  it("offers build-visible variables only through the environment, under the same rule as a Dockerfile", () => {
    const p = plan();
    expect(p.args.join(" ")).not.toContain(SECRET);
    expect(p.args.join(" ")).toContain("id=API_KEY,env=DOCKIFY_BUILD_SECRET_API_KEY");
    expect(p.env.DOCKIFY_BUILD_SECRET_API_KEY).toBe(SECRET);
    expect(p.env.DOCKIFY_BUILD_SECRET_RUNTIME_ONLY).toBeUndefined();
    expect(p.buildArgKeys).toEqual([]);
    expect(p.args.some((a) => a.startsWith("build-arg:API_KEY"))).toBe(false);
  });

  it("keeps cache mounts per app, and apart for every preview", () => {
    expect(plan().args).toContain("build-arg:cache-key=dockify-app-app-a");
    expect(buildCacheScope("a", null)).toBe("dockify-app-a");
    expect(buildCacheScope("a", { envId: "env1", fromFork: true })).toBe("dockify-fork-env1");
    expect(buildCacheScope("a", { envId: "env1", fromFork: false })).toBe("dockify-preview-env1");
    // The Dockerfile path follows the same scope.
    const p = planBuild({ buildkitAddr: "x", contextDir: "/a", dockerfileDir: "/a", dockerfileName: "Dockerfile", imageName: "i", appId: "a", deploymentId: "d", vars: [], cacheScope: buildCacheScope("a", { envId: "env1", fromFork: true }) });
    expect(p.args).toContain("build-arg:BUILDKIT_CACHE_MOUNT_NS=dockify-fork-env1");
  });

  it("hashes secrets so a rotation rebuilds, without the value and differently per app", () => {
    const a = R.secretsHash("a", vars);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toContain(SECRET);
    expect(R.secretsHash("b", vars)).not.toBe(a);
    expect(R.secretsHash("a", [...vars].reverse())).toBe(a);
    expect(R.secretsHash("a", [{ key: "API_KEY", value: "rotated", isSecret: true, target: "both" }])).not.toBe(R.secretsHash("a", [{ key: "API_KEY", value: SECRET, isSecret: true, target: "both" }]));
  });

  it("still refuses Railpack's frontend when a Dockerfile asks for it", () => {
    expect(() => checkSyntaxDirective("# syntax=ghcr.io/railwayapp/railpack-frontend\nFROM a\n")).toThrow(PermanentDeployError);
    expect(() => checkSyntaxDirective("# syntax=docker.io/attacker/frontend:1\nFROM a\n")).toThrow(PermanentDeployError);
  });
});

describe("the pins", () => {
  const read = (p: string) => readFile(new URL(`../../../../deploy/${p}`, import.meta.url), "utf8");
  it("match between the worker, its image and the daemon's allowlist", async () => {
    const dockerfile = await read("Dockerfile");
    const compose = await read("docker-compose.yml");
    expect(dockerfile).toContain(`ARG RAILPACK_VERSION=${R.RAILPACK_VERSION}`);
    expect(dockerfile).toContain(`ARG MISE_VERSION=${R.MISE_VERSION}`);
    expect(R.RAILPACK_FRONTEND).toContain(`:v${R.RAILPACK_VERSION}@`);
    for (const arg of ["RAILPACK_SHA256_AMD64", "RAILPACK_SHA256_ARM64", "MISE_SHA256_AMD64", "MISE_SHA256_ARM64"]) expect(dockerfile).toMatch(new RegExp(`ARG ${arg}=[a-f0-9]{64}`));
    expect(dockerfile).toContain("COPY --from=builders /opt/dockify/builders /opt/dockify/builders");
    expect(dockerfile).toMatch(/sha256sum -c -; \\\n\s+fetch[^\n]+mise/);
    // A single unreachable CDN address must not fail the whole image build.
    expect(dockerfile).toMatch(/fetch\(\) \{ i=0; until wget -T 30 /);
    expect(compose).toContain('allowedRepositories = ["docker.io/docker/dockerfile", "ghcr.io/railwayapp/railpack-frontend"]');
  });
});

describe("what is believed of the plan", () => {
  const planText = (o: Record<string, unknown> = {}) => JSON.stringify({
    secrets: ["API_KEY", "RAILPACK_INSTALL_CMD", "NOT_OFFERED"],
    steps: [
      { name: "packages:mise", commands: [{ cmd: "mise install", customName: "install mise packages: node" }] },
      { name: "install", secrets: ["*", "NOT_OFFERED"], commands: [{ src: ".", dest: "." }, { cmd: "sh -c 'npm i'", customName: "npm i" }] },
      { name: "build", commands: [{ path: "/x" }, { cmd: "npm run build", customName: "npm run build" }] },
    ],
    deploy: { startCommand: "npm run start" },
    ...o,
  });
  const info = JSON.stringify({ metadata: { providers: "node", nodeRuntime: "next" }, logs: [{ Level: "warn", Msg: "be careful" }, { Level: "info", Msg: "no" }] });

  it("reads a real plan's shape", () => {
    const p = R.readPlan(planText(), info, new Set(["API_KEY"]));
    expect(p).toMatchObject({ framework: "Next.js", provider: "node", installCommand: "npm i", buildCommand: "npm run build", startCommand: "npm run start", staticSite: false, warnings: ["be careful"] });
  });

  it("keeps only the secrets this build offers, so a plan cannot fail or fish on a name", () => {
    const out = JSON.parse(R.readPlan(planText(), info, new Set(["API_KEY"])).planJson);
    expect(out.secrets).toEqual(["API_KEY"]);
    expect(out.steps[1].secrets).toEqual(["*"]);
  });

  it("marks what Railpack serves with Caddy as a static site", () => {
    expect(R.readPlan(planText({ deploy: { startCommand: "caddy run --config Caddyfile --adapter caddyfile 2>&1" } }), JSON.stringify({ metadata: { providers: "staticfile" } }), new Set())).toMatchObject({ staticSite: true, framework: "Static site" });
  });

  it("refuses what is not a plan", () => {
    for (const text of [null, "not json", "[]", "1", '"x"', "null"]) expect(() => R.readPlan(text, null, new Set()), String(text)).toThrow(PermanentDeployError);
  });

  it("flattens hostile text and survives hostile shapes", () => {
    const evil = "ok\n\u0000\u001b[31m next";
    const p = R.readPlan(JSON.stringify({ secrets: "nope", steps: [null, 1, { name: "build", commands: [null, { cmd: 5 }, { cmd: evil }] }], deploy: { startCommand: evil } }), JSON.stringify({ metadata: { providers: { a: 1 }, nodeRuntime: ["x"] }, logs: "x" }), new Set());
    expect(p.startCommand).toBe("ok [31m next");
    expect(p.buildCommand).toBe("ok [31m next");
    expect(p.framework).toBeNull();
    expect(JSON.parse(p.planJson).secrets).toEqual([]);
    expect(R.readPlan(JSON.stringify({ deploy: { startCommand: "x".repeat(5000) } }), null, new Set()).startCommand).toHaveLength(1000);
  });

  it("says why a repository cannot be planned, and retries only a failed lookup", () => {
    const hopeless = R.planFailure(1, JSON.stringify({ success: false, logs: [{ Level: "error", Msg: "No start command could be found" }] }), "");
    expect(isPermanent(hopeless)).toBe(true);
    expect(hopeless.message).toContain("No start command could be found");
    expect(hopeless.message).toContain("Add a Dockerfile");
    expect(isPermanent(R.planFailure(75, null, ""))).toBe(false);
    expect(R.planFailure(1, null, "panic: boom").message).toContain("panic: boom");
    expect(R.planFailure(2, "not json", "").message).toContain("exited with code 2");
  });
});

describe("Next.js standalone", () => {
  const f = (nextConfig: string | null, packageJson: string | null = null, railpackJson: string | null = null) => ({ nextConfig, packageJson, railpackJson, hasAppPy: false, hasMainPy: false });
  it("runs Next's own server when the config asks for standalone", () => {
    for (const cfg of [`module.exports = { output: 'standalone' }`, `export default { output: "standalone" }`, `const c = {\n  output : "standalone",\n}`]) {
      expect(R.nextStandaloneStart(f(cfg)), cfg).toBe(R.NEXT_STANDALONE_START);
    }
    expect(R.nextStandaloneStart(f(`{ output: 'standalone' }`, JSON.stringify({ scripts: { start: "next start -p 3000" } })))).toBe(R.NEXT_STANDALONE_START);
    expect(R.NEXT_STANDALONE_START).toContain("HOSTNAME=0.0.0.0");
    expect(R.NEXT_STANDALONE_START).toContain(".next/static");
  });
  it("leaves everything else alone", () => {
    expect(R.nextStandaloneStart(f(null))).toBeNull();
    expect(R.nextStandaloneStart(f(`{ output: 'export' }`))).toBeNull();
    expect(R.nextStandaloneStart(f(`{}`))).toBeNull();
    expect(R.nextStandaloneStart(f(`{ output: 'standalone' }`, JSON.stringify({ scripts: { start: "node custom.js" } })))).toBeNull();
    expect(R.nextStandaloneStart(f(`{ output: 'standalone' }`, null, "{}"))).toBeNull();
    expect(R.nextStandaloneStart(f(`{ output: 'standalone' }`, "not json"))).toBe(R.NEXT_STANDALONE_START);
  });
});

describe("the port a repository probably serves on", () => {
  it("takes a Dockerfile's EXPOSE first, and refuses nonsense", () => {
    expect(detectPort({ dockerfile: "FROM a\nEXPOSE 8123/tcp\n", framework: "Next.js", provider: "node" })).toBe(8123);
    expect(detectPort({ dockerfile: "FROM a\nexpose 99999\n", framework: null, provider: null })).toBeNull();
    expect(detectPort({ dockerfile: "FROM a\n", framework: null, provider: null })).toBeNull();
  });
  it("falls back to what the framework usually uses", () => {
    expect(detectPort({ dockerfile: null, framework: "Next.js", provider: "node" })).toBe(3000);
    expect(detectPort({ dockerfile: null, framework: "Django", provider: "python" })).toBe(8000);
    expect(detectPort({ dockerfile: null, framework: "Go", provider: "golang" })).toBe(8080);
    expect(detectPort({ dockerfile: null, framework: null, provider: null })).toBeNull();
  });
});

describe("the answer New app shows", () => {
  const plan = { planJson: "{}", framework: "Next.js", provider: "node", installCommand: "npm ci", buildCommand: "npm run build", startCommand: "npm start", staticSite: false, warnings: [] };
  it("says only Dockerfile when there is one, so nothing reads as a guess about a build that will not happen", () => {
    expect(detectAnswer({ dockerfilePath: "Dockerfile", dockerfile: "FROM a\nEXPOSE 80", plan: null, reason: null })).toMatchObject({ detected: true, builder: "dockerfile", hasDockerfile: true, framework: "Dockerfile", staticSite: false, port: 80, buildCommand: "", startCommand: "", reason: null });
    // A Dockerfile that could not be read is still a Dockerfile: no port, and not Railpack's guess at one.
    expect(detectAnswer({ dockerfilePath: "Dockerfile", dockerfile: null, plan: null, reason: null })).toMatchObject({ framework: "Dockerfile", port: null });
  });
  it("uses Railpack without a Dockerfile, and gives the reason when it cannot", () => {
    expect(detectAnswer({ dockerfilePath: null, dockerfile: null, plan, reason: null })).toMatchObject({ detected: true, builder: "railpack", hasDockerfile: false, port: 3000, reason: null });
    expect(detectAnswer({ dockerfilePath: null, dockerfile: null, plan: null, reason: "Nothing to build" })).toMatchObject({ detected: false, reason: "Nothing to build" });
  });
});

describe("finding a Dockerfile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dk-rp-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("looks under the root directory, then from the top", async () => {
    expect(dockerfileCandidates("", "")).toEqual(["Dockerfile"]);
    expect(dockerfileCandidates("apps/web", "")).toEqual(["apps/web/Dockerfile", "Dockerfile"]);
    await mkdir(join(dir, "apps/web"), { recursive: true });
    expect(await findDockerfile(dir, "apps/web", "")).toBeNull();
    await writeFile(join(dir, "Dockerfile"), "FROM a");
    expect(await findDockerfile(dir, "apps/web", "")).toBe("Dockerfile");
    await writeFile(join(dir, "apps/web/Dockerfile"), "FROM a");
    expect(await findDockerfile(dir, "apps/web", "")).toBe("apps/web/Dockerfile");
    await expect(findDockerfile(dir, "", "../../etc/passwd")).rejects.toBeInstanceOf(PermanentDeployError);
  });
});

describe("builds end to end, buildctl faked", () => {
  let root: string;
  let repo: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dk-rp-"));
    repo = join(root, "repo");
    await mkdir(repo);
  });
  afterEach(async () => {
    vi.mocked(spawn).mockReset();
    await rm(root, { recursive: true, force: true });
  });

  /** Plays both buildctl runs: the plan step writes `files`; the build exits 0 and streams nothing. */
  function fakeBuildctl(files: (out: string) => Promise<void>, calls: Array<{ args: string[]; env: Record<string, string> }>) {
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[], opts: { env: Record<string, string> }) => {
      calls.push({ args, env: opts.env });
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
      const dest = args.find((a) => a.startsWith("type=local,dest="))?.slice("type=local,dest=".length);
      setTimeout(() => {
        void (dest ? files(dest) : Promise.resolve()).then(() => {
          child.stderr.end();
          child.stdout.end();
          child.emit("close", 0);
        });
      }, 1);
      return child;
    }) as unknown as typeof spawn);
  }
  const okPlan = async (out: string) => {
    await writeFile(join(out, "code"), "0\n");
    await writeFile(join(out, "plan.json"), JSON.stringify({ secrets: ["API_KEY", "RAILPACK_INSTALL_CMD"], steps: [], deploy: { startCommand: "npm start" } }));
    await writeFile(join(out, "info.json"), JSON.stringify({ metadata: { providers: "node" } }));
  };
  const docker = { loadImage: async () => {}, inspectImage: async () => ({ Id: "sha256:" + "a".repeat(64), Size: 1 }) } as unknown as DockerApi;
  const input = (over: Partial<import("@dockify/engine").BuildInput> = {}) => ({
    checkoutDir: repo, checkoutRoot: root, rootDir: "", dockerfilePath: "", appId: "app-1", deploymentId: "dep-12345678",
    vars: [{ key: "API_KEY", value: SECRET, isSecret: true, target: "build" as const }],
    timeoutMs: 60_000, ...over,
  });
  const logOf = (stored: string[]) => new DeployLog({ write: async (lines) => void stored.push(...lines.map((l) => l.text)) });

  it("uses Railpack when there is no Dockerfile: plan step first, then the pinned frontend, and the secret stays out of both argvs", async () => {
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    fakeBuildctl(okPlan, calls);
    const stored: string[] = [];
    const log = logOf(stored);
    await buildImage({ docker, buildkitAddr: "unix:///b.sock" }, input({ installCommand: "pnpm i" }), log, new AbortController().signal);
    await log.flush();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toContain("--no-cache");
    expect(calls[0]!.env.DOCKIFY_BUILD_SECRET_API_KEY).toBeUndefined();
    expect(calls[1]!.args).toContain(`source=${R.RAILPACK_FRONTEND}`);
    expect(calls[1]!.env.DOCKIFY_BUILD_SECRET_API_KEY).toBe(SECRET);
    for (const c of calls) expect(c.args.join(" ")).not.toContain(SECRET);
    const dockerfile = await readFile(join(root, "plan-step", "Dockerfile"), "utf8");
    expect(dockerfile).not.toContain(SECRET);
    expect(dockerfile).toContain("RAILPACK_INSTALL_CMD=pnpm i");
    // The repository's own .dockerignore cannot hide files from the read.
    expect(await readFile(join(root, "plan-step", "Dockerfile.dockerignore"), "utf8")).toBe("");
    const plan = JSON.parse(await readFile(join(root, "plan", "railpack-plan.json"), "utf8"));
    expect(plan.secrets).toEqual(["API_KEY"]);
    expect(stored.join("\n")).toContain("start: npm start");
    expect(stored.join("\n")).not.toContain(SECRET);
  });

  it("keeps using a Dockerfile under auto, and goes to Railpack anyway when told to", async () => {
    await writeFile(join(repo, "Dockerfile"), "FROM a\n");
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    fakeBuildctl(okPlan, calls);
    await buildImage({ docker, buildkitAddr: "unix:///b.sock" }, input(), logOf([]), new AbortController().signal);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("dockerfile.v0");
    calls.length = 0;
    await buildImage({ docker, buildkitAddr: "unix:///b.sock" }, input({ builder: "railpack" }), logOf([]), new AbortController().signal);
    expect(calls).toHaveLength(2);
  });

  it("refuses a missing Dockerfile when the builder says Dockerfile", async () => {
    await expect(buildImage({ docker, buildkitAddr: "unix:///b.sock" }, input({ builder: "dockerfile" }), logOf([]), new AbortController().signal)).rejects.toThrow(/No Dockerfile at Dockerfile/);
  });

  it("reports a repository Railpack cannot plan, from its info file", async () => {
    fakeBuildctl(async (out) => {
      await writeFile(join(out, "code"), "1\n");
      await writeFile(join(out, "info.json"), JSON.stringify({ success: false, logs: [{ Level: "error", Msg: "Railpack could not determine how to build the app." }] }));
    }, []);
    const err = await buildImage({ docker, buildkitAddr: "unix:///b.sock" }, input(), logOf([]), new AbortController().signal).catch((e: unknown) => e as Error);
    expect(isPermanent(err)).toBe(true);
    expect((err as Error).message).toContain("Railpack could not determine");
  });

  it("does not follow a symlink the plan step left, to a secret or anywhere", async () => {
    const outside = join(root, "internal_token");
    await writeFile(outside, JSON.stringify({ secrets: [], deploy: { startCommand: "the-secret-token" } }));
    let made = true;
    fakeBuildctl(async (out) => {
      await writeFile(join(out, "code"), "0\n");
      try {
        await symlink(outside, join(out, "plan.json"));
      } catch {
        // Windows without the privilege: the rule is checked on Linux in CI and on the box.
        made = false;
      }
    }, []);
    const err = await buildImage({ docker, buildkitAddr: "unix:///b.sock" }, input(), logOf([]), new AbortController().signal).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain(made ? "did not write a build plan" : "");
    expect((err as Error).message).not.toContain("the-secret-token");
  });

  it("does not read the repository's own hint files through a symlink", async () => {
    const outside = join(root, "next.config.js");
    await writeFile(outside, "module.exports = { output: 'standalone' }");
    let linked = true;
    await symlink(outside, join(repo, "next.config.js")).catch(() => {
      linked = false;
    });
    const hints = await R.readRepoHints(repo);
    if (linked) expect(hints.nextConfig).toBeNull();
    await writeFile(join(repo, "package.json"), "x".repeat(300 * 1024));
    expect((await R.readRepoHints(repo)).packageJson).toBeNull();
  });
});
