/**
 * Builds run in the rootless BuildKit daemon through buildctl, never through the Docker socket and
 * never in a process holding the master key. The result is exported as a docker tarball, loaded
 * into the daemon, and pinned by its image id. BuildKit keeps its own persistent cache (the janitor
 * caps it by size), and Dockify never injects a build arg that changes per build, so layer caching
 * holds across deploys.
 *
 * Tenant isolation inside the one shared daemon: RUN steps run in BuildKit's process sandbox (the
 * compose file never disables it), RUN --mount=type=cache directories are namespaced per app so one
 * app cannot seed another's package cache, a Dockerfile's frontend directive may only name the
 * official docker/dockerfile frontend (checked here, and enforced by the daemon itself through
 * allowedRepositories in the compose file's buildkitd.toml), and tenant variables can never set a
 * BUILDKIT_* build arg. A repository with no Dockerfile builds through railpack.ts, under the same
 * limits and the same variable rules.
 */
import { isPublicBuildKey } from "@dockify/contracts";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { buildCacheScope, dockerfileCandidates, findDockerfile, plannedPort } from "./build-shared.ts";
import type { DockerApi } from "./docker.ts";
import { PermanentDeployError } from "./errors.ts";
import { insideCheckout } from "./checkout.ts";
import { LineSplitter } from "./line-splitter.ts";
import { planRailpackBuild, RAILPACK_VERSION, runPlanStep } from "./railpack.ts";

export { buildCacheScope, dockerfileCandidates, findDockerfile } from "./build-shared.ts";

export interface BuildVar {
  key: string;
  value: string;
  isSecret: boolean;
  target: "build" | "runtime" | "both";
}

export interface BuildPlan {
  args: string[];
  /** Secret values reach buildctl through its environment only, never argv. */
  env: Record<string, string>;
  imageName: string;
  buildArgKeys: string[];
  secretKeys: string[];
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Build args BuildKit itself interprets (frontend selection, cache mount namespace, and so on). */
const RESERVED_ARG = /^BUILDKIT_/i;
/** The only frontend a `# syntax=` directive may name: the official Dockerfile frontend. */
const OFFICIAL_FRONTEND = /^(?:docker\.io\/)?docker\/dockerfile(?::[A-Za-z0-9._-]{1,64})?(?:@sha256:[a-f0-9]{64})?$/;

const refuseFrontend = (ref: string): never => {
  throw new PermanentDeployError(`the Dockerfile asks for the frontend "${ref.slice(0, 120)}"; only docker/dockerfile is allowed as a frontend`);
};

/**
 * BuildKit's third form of the directive: a file that is one JSON object with a "syntax" key
 * (frontend/dockerfile/parser/directives.go, after dropping a byte order mark and a #! first line).
 * Any casing of the key is refused here, whatever BuildKit does with it, and a non-string value too.
 */
function checkJsonDirective(dockerfile: string): void {
  const text = dockerfile.replace(/^\ufeff/, "").replace(/^#![^\n]*\n/, "");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return;
  for (const [key, value] of Object.entries(doc)) {
    if (key.toLowerCase() !== "syntax") continue;
    const ref = typeof value === "string" ? (value.trim().split(/\s+/)[0] ?? "") : String(value);
    if (!OFFICIAL_FRONTEND.test(ref)) refuseFrontend(ref);
  }
}

/**
 * Finds a frontend directive where BuildKit looks for one, in the leading comment block or as a JSON
 * document, and refuses any image but docker/dockerfile. A custom frontend is an arbitrary image
 * that the daemon runs with full control over the build graph. This check gives the clear message;
 * the daemon's own allowedRepositories is the gate no parser difference can get past.
 */
export function checkSyntaxDirective(dockerfile: string): void {
  checkJsonDirective(dockerfile);
  // trim() also drops a leading byte order mark.
  for (const raw of dockerfile.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith("#") && !line.startsWith("//")) return;
    const m = /^(?:#|\/\/)\s*syntax\s*=\s*(.*)$/i.exec(line);
    if (!m) continue;
    const ref = (m[1] ?? "").trim().split(/\s+/)[0] ?? "";
    if (!OFFICIAL_FRONTEND.test(ref)) refuseFrontend(ref);
  }
}

/**
 * Which build-time variables become ARGs and which become secret mounts. A non-secret variable
 * marked build or both is an ARG. A secret is never an ARG, whatever its target: ARG values persist
 * in the image config history and in BuildKit's cache keys, and images are kept for rollbacks, so a
 * secret passed that way would outlive its rotation. A Dockerfile reads a secret with
 * RUN --mount=type=secret,id=KEY (or env=KEY); every build-visible variable is offered that way.
 * An owner who really wants a plain ARG marks the variable not secret.
 */
export function planBuild(input: {
  buildkitAddr: string;
  contextDir: string;
  dockerfileDir: string;
  dockerfileName: string;
  imageName: string;
  appId: string;
  deploymentId: string;
  vars: BuildVar[];
  /** Whose cache this build uses: by default the app's own. */
  cacheScope?: string;
}): BuildPlan {
  const appScope = buildCacheScope(input.appId, null);
  const scope = input.cacheScope ?? appScope;
  const args = [
    "--addr", input.buildkitAddr,
    "build",
    "--progress", "plain",
    "--frontend", "dockerfile.v0",
    "--local", `context=${input.contextDir}`,
    "--local", `dockerfile=${input.dockerfileDir}`,
    "--opt", `filename=${input.dockerfileName}`,
    "--opt", `label:dockify.managed=true`,
    "--opt", `label:dockify.app=${input.appId}`,
    // RUN --mount=type=cache directories live in the shared daemon; key them by app.
    "--opt", `build-arg:BUILDKIT_CACHE_MOUNT_NS=${scope}`,
    // The namespace covers cache mounts, not layers, and the daemon is shared. A RUN step's hostname is
    // part of its cache key, so a preview's RUN layers can never be a production build's cache hit.
    // Steps before the first RUN stay shared: their keys are the content they produce.
    ...(scope === appScope ? [] : ["--opt", `build-arg:BUILDKIT_SANDBOX_HOSTNAME=${scope}`]),
    // OCI archive, not the legacy docker-archive (type=docker): Docker's containerd image store,
    // the default on Docker 28+, rejects a docker-archive with "unrecognized image format". OCI
    // loads into both the classic and the containerd store, and Docker 25+ (the installer minimum)
    // accepts it.
    "--output", `type=oci,name=${input.imageName}`,
  ];
  const env: Record<string, string> = {};
  const buildArgKeys: string[] = [];
  const secretKeys: string[] = [];
  for (const v of input.vars) {
    if (v.target === "runtime" || !ENV_KEY.test(v.key)) continue;
    if (!v.isSecret && !RESERVED_ARG.test(v.key)) {
      args.push("--opt", `build-arg:${v.key}=${v.value}`);
      buildArgKeys.push(v.key);
    }
    const envName = `DOCKIFY_BUILD_SECRET_${v.key}`;
    env[envName] = v.value;
    args.push("--secret", `id=${v.key},env=${envName}`);
    secretKeys.push(v.key);
  }
  return { args, env, imageName: input.imageName, buildArgKeys, secretKeys };
}

export const imageNameFor = (appId: string, deploymentId: string) => `dockify/app-${appId}:${deploymentId.slice(0, 8)}`;

/**
 * What the deploy log says about a plan's build-time variables. Key names stay readable through the
 * redactor: the lists are comma separated and no name is followed by "=" or ":", so the key=value
 * rule (which hides the value after any key naming a secret) has nothing to take. The earlier
 * "...--mount=type=secret: KEY" read as the pair secret=KEY and was logged as secret=[REDACTED].
 */
export function planLogLines(plan: Pick<BuildPlan, "buildArgKeys" | "secretKeys">): string[] {
  const out: string[] = [];
  if (plan.buildArgKeys.length) out.push(`build args: ${plan.buildArgKeys.join(", ")}`);
  if (plan.secretKeys.length) out.push(`build secrets (read each with RUN --mount=type=secret,id=NAME): ${plan.secretKeys.join(", ")}`);
  const hidden = plan.secretKeys.filter(isPublicBuildKey);
  if (hidden.length) out.push(`marked secret, so not passed as a build ARG, and a bundler will not see them: ${hidden.join(", ")}. Turn Secret off for a value the browser reads.`);
  return out;
}

/** Lines of buildctl's output a failed build quotes in its reason. */
export const FAILURE_TAIL_LINES = 6;
const TAIL_LINE_CHARS = 400;
/** A rule line from BuildKit's error frame ("------", "--------------------"): no information. */
const RULE_LINE = /^[\s-]*$/;

/** The last few lines buildctl printed, exactly as the deploy log stored them (redacted). */
export class OutputTail {
  private readonly lines: string[] = [];
  private readonly max: number;
  constructor(max = FAILURE_TAIL_LINES) {
    this.max = max;
  }
  push(line: string | null): void {
    if (line === null || RULE_LINE.test(line)) return;
    this.lines.push(line.length > TAIL_LINE_CHARS ? `${line.slice(0, TAIL_LINE_CHARS)}...` : line);
    if (this.lines.length > this.max) this.lines.shift();
  }
  get text(): string {
    return this.lines.join("\n");
  }
}

/** buildctl could not reach the BuildKit daemon, or lost it mid-build: no solve ran to a verdict. */
const DAEMON_UNREACHABLE = /code = Unavailable|connection error|error while dialing|failed to dial|dial unix|connect: connection refused|error reading from server/i;

/**
 * The error for a buildctl that exited non-zero. A failed solve (a RUN step, a COPY of a missing
 * file, a Dockerfile syntax error) fails the same way every time, so it is permanent and quotes the
 * last lines of output; only a daemon that could not be reached is worth another attempt.
 */
export function buildFailure(code: number, tail: string): Error {
  if (DAEMON_UNREACHABLE.test(tail)) {
    return new Error(`the build could not reach BuildKit (buildctl exit ${code})${tail ? `: ${tail}` : ""}`);
  }
  return new PermanentDeployError(
    tail ? `The build failed (buildctl exit ${code}). Its last lines:\n${tail}` : `The build failed (buildctl exit ${code}) and printed nothing; the build log has the steps that ran.`,
  );
}

/** How long a failed image load waits for buildctl to exit before it is judged on its own. */
export const LOAD_FAILURE_GRACE_MS = 10_000;

export interface BuildEnd {
  /** buildctl's exit code; -1 when it died by a signal. */
  code: number;
  /** True when buildctl was killed here because the load had already failed. */
  killed: boolean;
  /** Why the image load failed, or null when it succeeded. */
  loadError: unknown;
}

/**
 * Waits for both halves of a build: buildctl, and the docker load reading its stdout. buildctl's exit
 * decides first. A failed solve writes nothing to stdout, so the load fails too ("unrecognized image
 * format"), usually before the exit is seen; judging the load first reported that instead of the
 * build error, and retried a build that can only fail again. When the load fails first, buildctl's
 * output is drained (a full pipe would block it) and its exit awaited for `graceMs`; a build still
 * running after that is killed, and the load error stands on its own. A rejected `exited` (spawn
 * failure, cancel, timeout) rejects this.
 */
export async function settleBuild(p: {
  exited: Promise<number>;
  loaded: Promise<void>;
  drain: () => void;
  kill: () => void;
  graceMs?: number;
}): Promise<BuildEnd> {
  // Both wrapped so they never reject: a promise derived from one for a race that has already
  // been decided can then never become an unhandled rejection.
  const exit = p.exited.then((code) => ({ code, error: null }), (error: unknown) => ({ code: -1, error: error ?? new Error("buildctl failed") }));
  const load = p.loaded.then(() => null, (error: unknown) => ({ error }));
  const exitCode = async (): Promise<number> => {
    const r = await exit;
    if (r.error) throw r.error;
    return r.code;
  };
  const first = await Promise.race([exit.then(() => "exit" as const), load.then(() => "load" as const)]);
  if (first === "exit") {
    const code = await exitCode();
    // The load ends once buildctl's stdout has closed, which it has: the exit is seen after it.
    const failed = await load;
    return { code, killed: false, loadError: failed?.error ?? null };
  }
  const failed = await load;
  if (!failed) return { code: await exitCode(), killed: false, loadError: null };
  p.drain();
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<"grace">((resolve) => {
    timer = setTimeout(() => resolve("grace"), p.graceMs ?? LOAD_FAILURE_GRACE_MS);
  });
  try {
    if ((await Promise.race([exit.then(() => "exit" as const), grace])) === "exit") {
      return { code: await exitCode(), killed: false, loadError: failed.error };
    }
  } finally {
    clearTimeout(timer);
  }
  p.kill();
  return { code: await exitCode(), killed: true, loadError: failed.error };
}

export interface BuildInput {
  checkoutDir: string;
  /** Holds checkoutDir; the plan step's own files go here, outside what the repository controls. */
  checkoutRoot?: string;
  rootDir: string;
  dockerfilePath: string;
  /** auto: the Dockerfile when there is one, else Railpack. dockerfile and railpack do only that. */
  builder?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  cacheScope?: string;
  appId: string;
  deploymentId: string;
  vars: BuildVar[];
  timeoutMs: number;
  /** How long the repository read may take, inside timeoutMs. */
  planTimeoutMs?: number;
}

/** The part of the deploy log a build writes to. The rest of it stays with the worker. */
export interface BuildLog {
  redactor: { conceal(values: string[]): void };
  system(text: string): void;
  /** Stores one line and answers it as stored (redacted), or null past the log's cap. */
  add(stream: "stdout" | "stderr", raw: string): string | null;
}

export interface BuildResult {
  imageId: string;
  imageRef: string;
  /** What the build detected the app serves on, when it read the repository itself. */
  port?: number | null;
}

/** The server's side of a build: its Docker to load the image into, its BuildKit daemon to build with. */
export interface BuildServer {
  docker: Pick<DockerApi, "loadImage" | "inspectImage">;
  buildkitAddr: string;
}

export const duArgs = (addr: string): string[] => ["--addr", addr, "du", "--format", "{{json .}}"];
/** No --all and no keep limit: every record nothing uses goes, except internal and frontend ones. */
export const cachePruneArgs = (addr: string): string[] => ["--addr", addr, "prune", "--format", "{{json .}}"];
/**
 * One scope's cache mounts: BuildKit's description of a mount names its id, which starts with the scope.
 * Layers name no scope, so they age out through the janitor's trim, as every other record does.
 */
export const scopePruneArgs = (addr: string, scope: string): string[] => ["--addr", addr, "prune", "--filter", `description~=${scope}`, "--format", "{{json .}}"];
export function pruneArgs(addr: string, keepBytes: number): string[] {
  return ["--addr", addr, "prune", "--keep-storage", String(Math.floor(keepBytes / 1024 ** 2))];
}

/** Builds and loads the image; returns the pinned image id and the tag it was loaded under. */
export async function buildImage(server: BuildServer, b: BuildInput, log: BuildLog, signal: AbortSignal): Promise<BuildResult> {
  const builder = b.builder ?? "auto";
  log.redactor.conceal(b.vars.filter((v) => v.isSecret).map((v) => v.value));
  const found = builder === "railpack" ? null : await findDockerfile(b.checkoutDir, b.rootDir, b.dockerfilePath);
  if (found) return buildFromDockerfile(server, b, found, log, signal);
  if (builder === "dockerfile") {
    throw new PermanentDeployError(`No Dockerfile at ${dockerfileCandidates(b.rootDir, b.dockerfilePath).join(" or ")}. Add one, set its path in the app's settings, or switch the builder to Railpack.`);
  }
  return buildWithRailpack(server, b, log, signal);
}

async function buildFromDockerfile(server: BuildServer, b: BuildInput, dfRel: string, log: BuildLog, signal: AbortSignal): Promise<BuildResult> {
  const contextDir = await insideCheckout(b.checkoutDir, b.rootDir);
  const dockerfile = await insideCheckout(b.checkoutDir, dfRel);
  checkSyntaxDirective(await readFile(dockerfile, "utf8"));
  const plan = planBuild({
    buildkitAddr: server.buildkitAddr,
    contextDir,
    dockerfileDir: dirname(dockerfile),
    dockerfileName: relative(dirname(dockerfile), dockerfile),
    imageName: imageNameFor(b.appId, b.deploymentId),
    appId: b.appId,
    deploymentId: b.deploymentId,
    vars: b.vars,
    ...(b.cacheScope ? { cacheScope: b.cacheScope } : {}),
  });
  for (const line of planLogLines(plan)) log.system(line);
  log.system(`building ${dfRel} with BuildKit`);
  return runBuild(server.docker, plan, b, log, signal);
}

const DEFAULT_PLAN_TIMEOUT_MS = 5 * 60_000;

async function buildWithRailpack(server: BuildServer, b: BuildInput, log: BuildLog, signal: AbortSignal): Promise<BuildResult> {
  if (!b.checkoutRoot) throw new Error("a Railpack build needs the checkout's root folder");
  log.system(`no Dockerfile to use: reading the repository with Railpack ${RAILPACK_VERSION}`);
  const planned = await runPlanStep(server.buildkitAddr, {
    checkoutRoot: b.checkoutRoot,
    checkoutDir: b.checkoutDir,
    rootDir: b.rootDir,
    vars: b.vars,
    overrides: { installCommand: b.installCommand ?? "", buildCommand: b.buildCommand ?? "", startCommand: b.startCommand ?? "" },
    timeoutMs: Math.min(b.planTimeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS, b.timeoutMs),
  }, (line) => log.add("stderr", line), signal);
  const plan = planRailpackBuild({
    buildkitAddr: server.buildkitAddr,
    contextDir: planned.contextDir,
    planDir: planned.planDir,
    imageName: imageNameFor(b.appId, b.deploymentId),
    appId: b.appId,
    cacheScope: b.cacheScope ?? buildCacheScope(b.appId, null),
    vars: b.vars,
  });
  log.system(`detected ${planned.framework ?? planned.provider ?? "no framework"}`);
  if (planned.installCommand) log.system(`install: ${planned.installCommand}`);
  if (planned.buildCommand) log.system(`build: ${planned.buildCommand}`);
  if (planned.startCommand) log.system(`start: ${planned.startCommand}`);
  for (const w of planned.warnings) log.system(w);
  if (plan.secretKeys.length) log.system(`build commands see these as variables, and they stay out of the image: ${plan.secretKeys.join(", ")}`);
  const bundled = b.vars.filter((v) => v.isSecret && v.target !== "runtime" && isPublicBuildKey(v.key)).map((v) => v.key);
  if (bundled.length) log.system(`marked secret, but a bundler puts the value of these in the browser's code: ${bundled.join(", ")}`);
  return { ...(await runBuild(server.docker, plan, b, log, signal)), port: plannedPort(planned) };
}

/** Runs buildctl with a plan, loads what it streams into the daemon, and reads back the image's id. */
async function runBuild(docker: BuildServer["docker"], plan: BuildPlan, b: BuildInput, log: BuildLog, signal: AbortSignal): Promise<BuildResult> {
  const timeout = AbortSignal.timeout(b.timeoutMs);
  const both = AbortSignal.any([signal, timeout]);
  const child = spawn("buildctl", plan.args, {
    // A minimal env, so no inherited variable leaks into the build. DOCKER_CONFIG and HOME point at
    // the writable tmpfs: buildctl creates a Docker config dir for registry metadata, and the
    // read-only rootfs refuses its default /home/node/.docker, which fails every build.
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? "/tmp/.docker",
      HOME: process.env.HOME ?? "/tmp",
      ...plan.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    signal: both,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  // buildctl's progress goes to stderr: every line into the deploy log, the last few kept for the
  // reason a failed build gives.
  const tail = new OutputTail();
  const err = new LineSplitter((t) => tail.push(log.add("stderr", t)));
  child.stderr.setEncoding("utf8").on("data", (c: string) => err.push(c));
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", (e) => reject(e));
    child.once("close", (code) => resolve(code ?? -1));
  });
  let end: BuildEnd;
  try {
    end = await settleBuild({
      exited,
      loaded: docker.loadImage(child.stdout, both),
      drain: () => child.stdout.resume(),
      kill: () => child.kill("SIGKILL"),
    });
  } catch (e) {
    err.end();
    if (signal.aborted) throw e;
    if (timeout.aborted) throw new PermanentDeployError(`the build ran past ${Math.round(b.timeoutMs / 60_000)} minutes and was stopped`);
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("buildctl is not installed in the worker image");
    throw e;
  }
  err.end();
  if (signal.aborted) throw new Error("the build was stopped");
  if (timeout.aborted) throw new PermanentDeployError(`the build ran past ${Math.round(b.timeoutMs / 60_000)} minutes and was stopped`);
  // A build that failed on its own speaks first; one killed here because the load failed did not.
  if (end.code !== 0 && !end.killed) throw buildFailure(end.code, tail.text);
  if (end.loadError) throw end.loadError;
  const info = await docker.inspectImage(plan.imageName);
  log.system(`built image ${info.Id.slice(0, 19)} (${Math.round(info.Size / 1024 ** 2)} MiB)`);
  return { imageId: info.Id, imageRef: plan.imageName };
}
