/**
 * Builds a repository with no Dockerfile. `railpack prepare` runs as a RUN step in BuildKit's sandbox, never
 * in this process: the worker holds secrets a symlinked Procfile could pull into the plan, and the step gets
 * placeholder values only. The frontend is pinned by digest and prefixes every cache id with `cache-key`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PermanentDeployError } from "./errors.ts";
import { insideCheckout } from "./checkout.ts";
import { LineSplitter } from "./line-splitter.ts";
import { buildCacheScope } from "./build-shared.ts";
import type { BuildPlan, BuildVar } from "./build.ts";

export { plannedPort } from "./build-shared.ts";

export const RAILPACK_VERSION = "0.43.0";
/** The mise version this Railpack release expects to find (core/mise/version.txt at its tag). */
export const MISE_VERSION = "2026.10.14";
export const RAILPACK_FRONTEND = "ghcr.io/railwayapp/railpack-frontend:v0.43.0@sha256:355ef61fae6f2551103cd8b10c710cb07167dd353d561f15c69b8d7ac1c676cc";
/** Only what the plan step runs on: a shell for the wrapper, certificates for mise's version lookups. */
export const PLAN_BASE_IMAGE = "alpine:3.22@sha256:bfe7ceb9f09ec0566c48fb93356e45a47a00be5a1dd14fa5b909e7709c66b034";
/** Where the worker image keeps `railpack` and `mise`. */
export const TOOLS_DIR = "/opt/dockify/builders";

const PLAN_FILE = "railpack-plan.json";
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** A plan's files are written by a process that read hostile input. Bigger than any real plan. */
const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const MAX_VALUE = 4096;

export interface Overrides {
  installCommand: string;
  buildCommand: string;
  startCommand: string;
}

/**
 * Railpack adds every name it is given to the plan's `secrets`. A value goes in only for a non-secret
 * RAILPACK_* variable: everything else gets a placeholder, so no secret enters this step, its argv or the cache.
 */
export function planEnvArgs(vars: readonly BuildVar[], o: Pick<Overrides, "installCommand">): string[] {
  const args: string[] = [];
  const named = new Set<string>();
  for (const v of vars) {
    if (v.target === "runtime" || !ENV_KEY.test(v.key)) continue;
    // A setting marked secret cannot work: it would need its value here.
    if (v.key.startsWith("RAILPACK_") && v.isSecret) continue;
    // The form field wins over a variable of the same name.
    if (v.key === "RAILPACK_INSTALL_CMD" && o.installCommand) continue;
    named.add(v.key);
    const real = v.key.startsWith("RAILPACK_") && v.value.length > 0 && v.value.length <= MAX_VALUE;
    args.push("--env", `${v.key}=${real ? v.value : "1"}`);
  }
  if (o.installCommand) args.push("--env", `RAILPACK_INSTALL_CMD=${o.installCommand}`);
  return args;
}

/** Runs prepare and always exits 0, so its exit code and its info file come back with the solve. */
const PLAN_WRAPPER = `mkdir -p /out; railpack prepare /app --hide-pretty-plan --plan-out /out/plan.json --info-out /out/info.json "$@" >/dev/null 2>/out/stderr; echo $? >/out/code; exit 0`;

/**
 * Values reach it only as JSON strings in an exec-form RUN, which BuildKit neither expands nor hands to a
 * shell; the wrapper takes them through "$@". The repository is mounted read-only.
 */
export function planDockerfile(args: readonly string[]): string {
  const run = JSON.stringify(["/bin/sh", "-c", PLAN_WRAPPER, "railpack", ...args]);
  return [
    `FROM ${PLAN_BASE_IMAGE} AS plan`,
    `COPY --from=tools /railpack /usr/local/bin/railpack`,
    // Railpack's install check finds this and stops there, so it never downloads mise.
    `COPY --from=tools /mise /tmp/railpack/mise/mise-${MISE_VERSION}`,
    `RUN --mount=type=bind,source=.,target=/app ${run}`,
    `FROM scratch`,
    `COPY --from=plan /out /`,
    "",
  ].join("\n");
}

export function planStepArgs(o: { buildkitAddr: string; contextDir: string; stepDir: string; outDir: string; toolsDir?: string }): string[] {
  return [
    "--addr", o.buildkitAddr,
    "build",
    "--progress", "plain",
    // A retry after a failed version lookup must run it again, not read that failure from the cache.
    "--no-cache",
    "--frontend", "dockerfile.v0",
    "--local", `context=${o.contextDir}`,
    "--local", `dockerfile=${o.stepDir}`,
    "--local", `tools=${o.toolsDir ?? TOOLS_DIR}`,
    "--opt", "filename=Dockerfile",
    "--opt", "context:tools=local:tools",
    "--output", `type=local,dest=${o.outDir}`,
  ];
}

/** Lets a secret's value change bust the layers that used it, without the value entering any build input. */
export function secretsHash(appId: string, vars: readonly BuildVar[]): string {
  const h = createHash("sha256").update(`dockify-build-secrets\0${appId}\0`);
  for (const v of [...vars].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    if (v.target === "runtime" || !ENV_KEY.test(v.key)) continue;
    h.update(`${v.key}\0${v.value}\0`);
  }
  return h.digest("hex");
}

/** The build's arguments. Every build-visible variable is offered as a secret, as for a Dockerfile; none is a build arg. */
export function planRailpackBuild(input: {
  buildkitAddr: string;
  contextDir: string;
  planDir: string;
  imageName: string;
  appId: string;
  cacheScope: string;
  vars: readonly BuildVar[];
}): BuildPlan {
  const args = [
    "--addr", input.buildkitAddr,
    "build",
    "--progress", "plain",
    "--frontend", "gateway.v0",
    "--opt", `source=${RAILPACK_FRONTEND}`,
    "--local", `context=${input.contextDir}`,
    "--local", `dockerfile=${input.planDir}`,
    "--opt", `filename=${PLAN_FILE}`,
    "--opt", `build-arg:cache-key=${input.cacheScope}`,
    "--opt", `build-arg:secrets-hash=${secretsHash(input.cacheScope === buildCacheScope(input.appId, null) ? input.appId : input.cacheScope, input.vars)}`,
    "--output", `type=oci,name=${input.imageName}`,
  ];
  const env: Record<string, string> = {};
  const secretKeys: string[] = [];
  for (const v of input.vars) {
    if (v.target === "runtime" || !ENV_KEY.test(v.key)) continue;
    const envName = `DOCKIFY_BUILD_SECRET_${v.key}`;
    env[envName] = v.value;
    args.push("--secret", `id=${v.key},env=${envName}`);
    secretKeys.push(v.key);
  }
  return { args, env, imageName: input.imageName, buildArgKeys: [], secretKeys };
}

export interface PlanInfo {
  planJson: string;
  framework: string | null;
  provider: string | null;
  /** Nothing below is ever run from here: it is what New app and the deploy log show. */
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  staticSite: boolean;
  warnings: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Text from a hostile plan, for a form field or a log line: one line, no control characters, bounded. */
const shown = (v: unknown, max = 1000): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ").trim().slice(0, max) : "");

/** Read a file the plan step wrote: a regular file of a sane size, or nothing. Never a symlink, whatever the step left. */
async function readOutput(path: string): Promise<string | null> {
  const st = await lstat(path).catch(() => null);
  if (!st?.isFile() || st.size > MAX_PLAN_BYTES) return null;
  const f = await open(path, "r");
  try {
    return await f.readFile("utf8");
  } finally {
    await f.close();
  }
}

const parse = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const PROVIDER_NAME: Record<string, string> = {
  node: "Node.js", python: "Python", golang: "Go", staticfile: "Static site", php: "PHP", ruby: "Ruby", rust: "Rust", java: "Java",
  deno: "Deno", dotnet: ".NET", elixir: "Elixir", gleam: "Gleam", cpp: "C++", shell: "Shell script", zig: "Zig",
};
const RUNTIME_NAME: Record<string, string> = {
  next: "Next.js", vite: "Vite", astro: "Astro", remix: "Remix", nuxt: "Nuxt", tanstack: "TanStack Start", svelte: "SvelteKit", "react-router": "React Router",
  cra: "Create React App", angular: "Angular", expo: "Expo", bun: "Bun", django: "Django", flask: "Flask", fastapi: "FastAPI", fasthtml: "FastHTML",
};

/** What a step runs, as its own command names say it. Railpack wraps a command in sh -c and keeps the plain text as customName. */
function stepCommand(steps: unknown, name: string): string {
  if (!Array.isArray(steps)) return "";
  const step = steps.find((s) => isRecord(s) && s.name === name);
  if (!isRecord(step) || !Array.isArray(step.commands)) return "";
  const parts: string[] = [];
  for (const c of step.commands) {
    if (!isRecord(c) || typeof c.cmd !== "string") continue;
    parts.push(shown(c.customName) || shown(c.cmd));
  }
  return parts.join(" && ").slice(0, 1000);
}

/**
 * Keeps only the secrets this build offers: a name it does not offer would fail the solve, and that includes
 * our own RAILPACK_INSTALL_CMD. Everything else stays; what the plan can do is the sandbox's business.
 */
export function readPlan(planText: string | null, infoText: string | null, offered: ReadonlySet<string>): PlanInfo {
  const info = parse(infoText);
  const plan = parse(planText);
  if (!isRecord(plan)) throw new PermanentDeployError("Railpack did not write a build plan");
  const keep = (list: unknown): string[] => (Array.isArray(list) ? list.filter((k): k is string => typeof k === "string" && offered.has(k)) : []);
  plan.secrets = keep(plan.secrets);
  if (Array.isArray(plan.steps)) {
    for (const step of plan.steps) {
      if (!isRecord(step) || !Array.isArray(step.secrets)) continue;
      // "*" means every secret of the plan, which is now only what is offered.
      step.secrets = step.secrets.filter((k) => k === "*" || (typeof k === "string" && offered.has(k)));
    }
  }
  const meta = isRecord(info) && isRecord(info.metadata) ? info.metadata : {};
  const provider = shown(meta.providers, 40) || null;
  const runtime = shown(meta.nodeRuntime, 40) || shown(meta.pythonRuntime, 40) || shown(meta.phpFramework, 40) || shown(meta.javaFramework, 40);
  const framework = RUNTIME_NAME[runtime] ?? (provider ? PROVIDER_NAME[provider] ?? null : null);
  const deploy = isRecord(plan.deploy) ? plan.deploy : {};
  const start = shown(deploy.startCommand);
  return {
    planJson: JSON.stringify(plan),
    framework,
    provider,
    installCommand: stepCommand(plan.steps, "install"),
    buildCommand: stepCommand(plan.steps, "build"),
    startCommand: start,
    // Node's single-page path and the static file provider both end in Railpack's Caddy.
    staticSite: /^caddy run\b/.test(start),
    warnings: logMessages(info, "warn"),
  };
}

function logMessages(info: unknown, level: string): string[] {
  if (!isRecord(info) || !Array.isArray(info.logs)) return [];
  const out: string[] = [];
  for (const l of info.logs) {
    if (isRecord(l) && l.Level === level) {
      const msg = shown(l.Msg, 400);
      if (msg) out.push(msg);
    }
  }
  return out.slice(0, 10);
}

/** Railpack's exit code for a failure worth another try (a version lookup that could not connect). */
const EXIT_TEMPORARY = 75;

export function planFailure(code: number, infoText: string | null, stderr: string): Error {
  if (code === EXIT_TEMPORARY) return new Error("Railpack could not reach its version service; this deploy will try again.");
  const errors = logMessages(parse(infoText), "error");
  const why = errors.join(" ") || shown(stderr, 600) || `it exited with code ${code}`;
  return new PermanentDeployError(`Dockify could not work out how to build this repository: ${why} Add a Dockerfile, or set the install, build and start commands in the app's settings.`);
}

export interface PlanInput {
  checkoutRoot: string;
  checkoutDir: string;
  rootDir: string;
  vars: readonly BuildVar[];
  overrides: Overrides;
  timeoutMs: number;
  /** Tests point this at a fake. */
  buildctl?: string;
  toolsDir?: string;
}

/** The commands the plan step gets: the form's, and Next's own server when the app builds standalone. */
export function planCommandArgs(o: Overrides, nextStandaloneStart: string | null): string[] {
  const args: string[] = [];
  if (o.buildCommand) args.push("--build-cmd", o.buildCommand);
  const start = o.startCommand || nextStandaloneStart;
  if (start) args.push("--start-cmd", start);
  // A plan with no way to start would build for minutes and then fail its health check.
  else args.push("--error-missing-start");
  return args;
}

/**
 * `next start` refuses to be the way to run `output: "standalone"` ("Use node .next/standalone/server.js").
 * That server needs the static files beside it, and HOSTNAME set, as Docker sets it to the container's id.
 */
export const NEXT_STANDALONE_START = "cp -r .next/static .next/standalone/.next/ && { [ ! -d public ] || cp -r public .next/standalone/; } && cd .next/standalone && HOSTNAME=0.0.0.0 exec node server.js";

const NEXT_CONFIGS = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"];
const SMALL_FILE = 256 * 1024;

/** A small file of the repository as text, or null. Refuses a symlink, so it reads only the repository's own bytes. */
async function repoFile(dir: string, name: string): Promise<string | null> {
  const path = join(dir, name);
  const st = await lstat(path).catch(() => null);
  if (!st?.isFile() || st.size > SMALL_FILE) return null;
  const f = await open(path, "r");
  try {
    return await f.readFile("utf8");
  } finally {
    await f.close();
  }
}

export interface RepoHints {
  nextConfig: string | null;
  packageJson: string | null;
  railpackJson: string | null;
  hasAppPy: boolean;
  hasMainPy: boolean;
}

/** The config with its comments gone, so a commented-out `output` setting does not count. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Decides from the file text alone. A repository with its own railpack.json or start script has said how it starts. */
function nextOutput(files: RepoHints): { output: "standalone" | "export"; config: string } | null {
  if (files.railpackJson !== null || !files.nextConfig) return null;
  const config = withoutComments(files.nextConfig);
  const m = /\boutput\s*:\s*["'](standalone|export)["']/.exec(config);
  if (!m) return null;
  const pkg = parse(files.packageJson);
  const scripts = isRecord(pkg) && isRecord(pkg.scripts) ? pkg.scripts : {};
  const start = typeof scripts.start === "string" ? scripts.start.trim() : "";
  return !start || /^next\s+start\b/.test(start) ? { output: m[1] as "standalone" | "export", config } : null;
}

export function nextStandaloneStart(files: RepoHints): string | null {
  return nextOutput(files)?.output === "standalone" ? NEXT_STANDALONE_START : null;
}

/**
 * Railpack serves the export folder with Caddy once told; left alone it plans `next start`, which refuses an
 * export. The folder name comes from a hostile repository, so it must be a plain relative path.
 */
export function nextExportDir(files: RepoHints): string | null {
  const next = nextOutput(files);
  if (next?.output !== "export") return null;
  const dist = /\bdistDir\s*:\s*["']([^"']+)["']/.exec(next.config)?.[1]?.replace(/^\.\//, "").replace(/\/+$/, "");
  return dist && /^[\w.-]+(?:\/[\w.-]+)*$/.test(dist) && !dist.split("/").includes("..") ? dist : "out";
}

/**
 * Settings the plan step gets because of what the repository is, when the owner set neither a start command
 * nor the setting itself.
 */
export function planHintArgs(o: Pick<Overrides, "startCommand">, vars: readonly BuildVar[], hints: RepoHints): string[] {
  const dir = nextExportDir(hints);
  if (!dir || o.startCommand || vars.some((v) => v.key === "RAILPACK_SPA_OUTPUT_DIR" || v.key === "RAILPACK_NO_SPA")) return [];
  return ["--env", `RAILPACK_SPA_OUTPUT_DIR=${dir}`];
}

/**
 * Railpack starts every Python web app as main:app, which fails on the most common layout: app.py
 * with no main.py. The command Railpack planned, pointed at app:app, or null when it is fine as it is.
 */
export function pythonEntryStart(planned: string | null, hints: Pick<RepoHints, "hasAppPy" | "hasMainPy">): string | null {
  if (!planned || !hints.hasAppPy || hints.hasMainPy) return null;
  return /(^|\s)main:app(\s|$)/.test(planned) ? planned.replace(/(^|\s)main:app(?=\s|$)/, "$1app:app") : null;
}

export async function readRepoHints(contextDir: string): Promise<RepoHints> {
  let nextConfig: string | null = null;
  for (const name of NEXT_CONFIGS) {
    nextConfig = await repoFile(contextDir, name);
    if (nextConfig !== null) break;
  }
  const isFile = async (name: string) => (await lstat(join(contextDir, name)).catch(() => null))?.isFile() ?? false;
  return {
    nextConfig, packageJson: await repoFile(contextDir, "package.json"), railpackJson: await repoFile(contextDir, "railpack.json"),
    hasAppPy: await isFile("app.py"), hasMainPy: await isFile("main.py"),
  };
}

/** Throws a PermanentDeployError for a repository it cannot plan. */
export async function runPlanStep(buildkitAddr: string, p: PlanInput, onLine: (line: string) => string | null, signal: AbortSignal): Promise<PlanInfo & { contextDir: string; planDir: string }> {
  const contextDir = await insideCheckout(p.checkoutDir, p.rootDir);
  const stepDir = join(p.checkoutRoot, "plan-step");
  const outDir = join(p.checkoutRoot, "plan-out");
  const planDir = join(p.checkoutRoot, "plan");
  await mkdir(stepDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await mkdir(planDir, { recursive: true });
  const hints = await readRepoHints(contextDir);
  const args = [...planEnvArgs(p.vars, p.overrides), ...planHintArgs(p.overrides, p.vars, hints), ...planCommandArgs(p.overrides, nextStandaloneStart(hints))];
  await writeFile(join(stepDir, "Dockerfile"), planDockerfile(args));
  // BuildKit prefers this over the repository's own .dockerignore, which could hide its package.json from detection.
  await writeFile(join(stepDir, "Dockerfile.dockerignore"), "");

  const timeout = AbortSignal.timeout(p.timeoutMs);
  const both = AbortSignal.any([signal, timeout]);
  const child = spawn(p.buildctl ?? "buildctl", planStepArgs({ buildkitAddr, contextDir, stepDir, outDir, ...(p.toolsDir ? { toolsDir: p.toolsDir } : {}) }), {
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? "/tmp/.docker", HOME: process.env.HOME ?? "/tmp" },
    stdio: ["ignore", "ignore", "pipe"],
    signal: both,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  const tail: string[] = [];
  const lines = new LineSplitter((t) => {
    const stored = onLine(t);
    if (stored === null) return;
    tail.push(stored);
    if (tail.length > 6) tail.shift();
  });
  child.stderr.setEncoding("utf8").on("data", (c: string) => lines.push(c));
  let code: number;
  try {
    code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (c) => resolve(c ?? -1));
    });
  } catch (e) {
    if (signal.aborted) throw e;
    if (timeout.aborted) throw new PermanentDeployError(`Reading the repository ran past ${Math.round(p.timeoutMs / 60_000)} minutes and was stopped.`);
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("buildctl is not installed in the worker image");
    throw e;
  }
  lines.end();
  if (code !== 0) throw new Error(`The BuildKit step that reads the repository failed (buildctl exit ${code})${tail.length ? `: ${tail.join("\n")}` : ""}`);

  const exit = Number((await readOutput(join(outDir, "code")))?.trim() ?? NaN);
  const infoText = await readOutput(join(outDir, "info.json"));
  if (exit !== 0) throw planFailure(Number.isNaN(exit) ? 1 : exit, infoText, (await readOutput(join(outDir, "stderr"))) ?? "");
  const offered = new Set(p.vars.filter((v) => v.target !== "runtime" && ENV_KEY.test(v.key)).map((v) => v.key));
  const read = readPlan(await readOutput(join(outDir, "plan.json")), infoText, offered);
  const entry = p.overrides.startCommand ? null : pythonEntryStart(read.startCommand, hints);
  if (entry) return runPlanStep(buildkitAddr, { ...p, overrides: { ...p.overrides, startCommand: entry } }, onLine, signal);
  await writeFile(join(planDir, PLAN_FILE), read.planJson);
  return { ...read, contextDir, planDir };
}
