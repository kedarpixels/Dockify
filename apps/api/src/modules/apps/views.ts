// AppSettings and AppConfig read and write the same App columns (healthCheckPath, cpuLimit,
// memoryLimitMb), so the two tabs can never disagree.
import type { z } from "zod";
import type { apps as Ap } from "@dockify/contracts";

type Settings = z.infer<typeof Ap.AppSettings>;
type Advanced = z.infer<typeof Ap.AppAdvanced>;
type Source = z.infer<typeof Ap.AppSource>;
type HealthCheck = z.infer<typeof Ap.HealthCheck>;
type Limits = z.infer<typeof Ap.AppLimits>;
type ConfigPatch = z.infer<typeof Ap.AppConfigPatch>;

export const STATEFUL = new Set(["postgres", "redis", "s3"]);

export interface AppRow {
  id: string;
  name: string;
  kind: string;
  image: string | null;
  gitRepository: string | null;
  gitBranch: string | null;
  /** This app's GitHub repository id, or its project's. What Vercel is told to build. */
  gitRepoId?: string | null;
  deployTarget: "server" | "vercel";
  vercelProjectId: string | null;
  vercelFollowOnly?: boolean;
  builder: string;
  rootDir: string | null;
  dockerfilePath: string | null;
  installCommand?: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  releaseCommand: string | null;
  port: number | null;
  healthCheckPath: string | null;
  healthExpectedStatus: number;
  healthTimeoutSeconds: number;
  healthGraceSeconds: number;
  healthIntervalSeconds: number;
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  pidsLimit: number | null;
  capAdd: string[];
  sysctls: unknown;
}

export interface Refusal {
  field: string;
  reason: string;
}

export interface Change {
  key: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
}

/**
 * The primary domain, else the oldest one: nothing sets a primary when the first domain is added.
 * `domains` must be oldest first.
 */
export function publicUrlOf(primary: { hostname: string } | null, domains: ReadonlyArray<{ hostname: string }>): string | null {
  const host = primary?.hostname ?? domains[0]?.hostname;
  return host ? `https://${host}` : null;
}

export const settingsOf = (a: AppRow): Settings => ({
  builder: a.builder as NonNullable<Settings["builder"]>,
  installCommand: a.installCommand ?? "",
  buildCommand: a.buildCommand ?? "",
  startCommand: a.startCommand ?? "",
  dockerfilePath: a.dockerfilePath ?? "",
  port: a.port,
  healthCheckPath: a.healthCheckPath ?? "",
  cpuLimit: a.cpuLimit,
  memoryLimitMb: a.memoryLimitMb,
});

export const withoutCommands = (s: Settings): Settings => ({ ...s, installCommand: "", buildCommand: "", startCommand: "" });

export const healthOf = (a: AppRow): HealthCheck => ({
  path: a.healthCheckPath ?? "",
  expectedStatus: a.healthExpectedStatus,
  timeoutSeconds: a.healthTimeoutSeconds,
  gracePeriodSeconds: a.healthGraceSeconds,
  intervalSeconds: a.healthIntervalSeconds,
});

export const limitsOf = (a: AppRow): Limits => ({ cpuCores: a.cpuLimit, memoryMb: a.memoryLimitMb, pids: a.pidsLimit });

/**
 * Must agree with the worker's swapStrategy(), which makes the same call at deploy time. Dockify
 * never publishes a host port, so "fixed-port" cannot come up today.
 */
export function zeroDowntimeOf(kind: string, volumes: number): { possible: boolean; blockers: Array<"volume" | "fixed-port"> } {
  const blockers: Array<"volume" | "fixed-port"> = volumes > 0 || STATEFUL.has(kind) ? ["volume"] : [];
  return { possible: blockers.length === 0, blockers };
}

const empty = (v: string | undefined): string | null => (v === undefined || v === "" ? null : v);

/** Commands can carry a token someone pasted inline, so the audit names a changed command without its text. */
export function settingsUpdate(a: AppRow, s: Settings, adv: Advanced | undefined, src?: Source): { data: Record<string, unknown>; refusals: Refusal[]; changes: Change[] } {
  const refusals: Refusal[] = [];
  const stateful = STATEFUL.has(a.kind);
  const fromGit = !!a.gitRepository;
  if (src?.image !== undefined && fromGit) refusals.push({ field: "source.image", reason: "An app built from git builds its own image" });
  if (src?.image !== undefined && stateful) refusals.push({ field: "source.image", reason: "A managed service runs the image Dockify picks for it" });
  if (src?.branch !== undefined && !fromGit) refusals.push({ field: "source.branch", reason: "Only an app built from git has a branch" });
  if (!fromGit && s.buildCommand) refusals.push({ field: "settings.buildCommand", reason: "Only an app built from git has a build command" });
  if (!fromGit && s.installCommand) refusals.push({ field: "settings.installCommand", reason: "Only an app built from git has an install command" });
  if (!fromGit && s.builder && s.builder !== a.builder) refusals.push({ field: "settings.builder", reason: "Only an app built from git has a builder" });
  if (!fromGit && s.dockerfilePath) refusals.push({ field: "settings.dockerfilePath", reason: "Only an app built from git has a Dockerfile" });
  if (stateful && s.startCommand) refusals.push({ field: "settings.startCommand", reason: "A managed service runs its own command" });
  if (stateful && s.port !== a.port) refusals.push({ field: "settings.port", reason: "A managed service listens on its own port" });
  if (adv?.rootDir && !fromGit) refusals.push({ field: "advanced.rootDir", reason: "Only an app built from git has a root directory" });
  if (adv?.releaseCommand && stateful) refusals.push({ field: "advanced.releaseCommand", reason: "A managed service has no release command" });

  const data: Record<string, unknown> = {
    buildCommand: empty(s.buildCommand),
    startCommand: empty(s.startCommand),
    port: s.port,
    healthCheckPath: empty(s.healthCheckPath),
    cpuLimit: s.cpuLimit,
    memoryLimitMb: s.memoryLimitMb,
  };
  if (fromGit) {
    data.dockerfilePath = empty(s.dockerfilePath);
    // Naming a Dockerfile means the Dockerfile; only an explicit Railpack ignores the path.
    const builder = s.builder ?? "auto";
    data.builder = builder === "auto" && s.dockerfilePath ? "dockerfile" : builder;
    if (s.installCommand !== undefined) data.installCommand = empty(s.installCommand);
  }
  if (adv?.rootDir !== undefined) data.rootDir = empty(adv.rootDir);
  if (adv?.releaseCommand !== undefined) data.releaseCommand = empty(adv.releaseCommand);
  if (adv?.capAdd !== undefined) data.capAdd = [...new Set(adv.capAdd)];
  if (adv?.sysctls !== undefined) data.sysctls = adv.sysctls;
  if (src?.image !== undefined && !fromGit && !stateful) data.image = src.image;
  if (src?.branch !== undefined && fromGit) data.gitBranch = src.branch;

  const changes: Change[] = [];
  const plain = (key: string, before: string | number | null, after: unknown) => {
    if (after !== undefined && before !== after) changes.push({ key, before, after: after as string | number | null });
  };
  const hidden = (key: string, before: string | null, after: unknown) => {
    if (after !== undefined && before !== after) changes.push({ key, before: null, after: "changed" });
  };
  hidden("installCommand", a.installCommand ?? null, data.installCommand);
  hidden("buildCommand", a.buildCommand, data.buildCommand);
  hidden("startCommand", a.startCommand, data.startCommand);
  hidden("releaseCommand", a.releaseCommand, data.releaseCommand);
  plain("image", a.image, data.image);
  plain("branch", a.gitBranch, data.gitBranch);
  plain("builder", a.builder, data.builder);
  plain("dockerfilePath", a.dockerfilePath, data.dockerfilePath);
  plain("rootDir", a.rootDir, data.rootDir);
  plain("port", a.port, data.port);
  plain("healthCheckPath", a.healthCheckPath, data.healthCheckPath);
  plain("cpuLimit", a.cpuLimit, data.cpuLimit);
  plain("memoryLimitMb", a.memoryLimitMb, data.memoryLimitMb);
  if (data.capAdd !== undefined) {
    const before = [...a.capAdd].sort().join(",");
    const after = [...(data.capAdd as string[])].sort().join(",");
    if (before !== after) changes.push({ key: "capAdd", before: before || null, after: after || null });
  }
  if (data.sysctls !== undefined) {
    const before = JSON.stringify(a.sysctls ?? {});
    const after = JSON.stringify(data.sysctls);
    if (before !== after) changes.push({ key: "sysctls", before, after });
  }
  return { data, refusals, changes };
}

/**
 * A Vercel link follows unless the body asks to deploy. `startsPushing` means this change makes
 * Dockify send the app's variables and secrets to a Vercel project that was not getting them, so
 * the caller must require confirmation and step-up.
 */
export function targetPlan(a: Pick<AppRow, "deployTarget" | "vercelProjectId" | "vercelFollowOnly">, t: { kind: "server" | "vercel"; vercelProjectId: string | null; mode?: "follow" | "deploy" | undefined }): { followOnly: boolean; startsPushing: boolean } {
  if (t.kind === "server") return { followOnly: false, startsPushing: false };
  const followOnly = (t.mode ?? "follow") === "follow";
  const already = a.deployTarget === "vercel" && !a.vercelFollowOnly && a.vercelProjectId === t.vercelProjectId;
  return { followOnly, startsPushing: !followOnly && !already };
}

export function configUpdate(a: AppRow, p: ConfigPatch): { data: Record<string, unknown>; refusals: Refusal[]; changes: Change[] } {
  const refusals: Refusal[] = [];
  const data: Record<string, unknown> = {};
  if (p.health) {
    Object.assign(data, {
      healthCheckPath: empty(p.health.path),
      healthExpectedStatus: p.health.expectedStatus,
      healthTimeoutSeconds: p.health.timeoutSeconds,
      healthGraceSeconds: p.health.gracePeriodSeconds,
      healthIntervalSeconds: p.health.intervalSeconds,
    });
  }
  if (p.limits) Object.assign(data, { cpuLimit: p.limits.cpuCores, memoryLimitMb: p.limits.memoryMb, pidsLimit: p.limits.pids });
  if (p.release) {
    if (STATEFUL.has(a.kind) && p.release.command) refusals.push({ field: "release.command", reason: "A managed service has no release command" });
    data.releaseCommand = empty(p.release.command);
  }
  if (p.target) {
    const plan = targetPlan(a, p.target);
    if (p.target.kind === "vercel" && a.kind !== "frontend") refusals.push({ field: "target", reason: "Only a frontend can link to a Vercel project" });
    else if (plan.followOnly === false && p.target.kind === "vercel" && !a.gitRepository) refusals.push({ field: "target", reason: "Only a frontend built from git can deploy to Vercel" });
    else if (plan.startsPushing && !a.gitRepoId) refusals.push({ field: "target", reason: "Vercel builds a repository picked through the GitHub App, and this app has none. Create it from a repository the GitHub App can see." });
    data.deployTarget = p.target.kind;
    data.vercelProjectId = p.target.vercelProjectId;
    data.vercelFollowOnly = plan.followOnly;
  }

  const changes: Change[] = [];
  const cols: Array<[string, keyof AppRow]> = [
    ["health.path", "healthCheckPath"], ["health.expectedStatus", "healthExpectedStatus"], ["health.timeoutSeconds", "healthTimeoutSeconds"],
    ["health.gracePeriodSeconds", "healthGraceSeconds"], ["health.intervalSeconds", "healthIntervalSeconds"],
    ["limits.cpuCores", "cpuLimit"], ["limits.memoryMb", "memoryLimitMb"], ["limits.pids", "pidsLimit"],
    ["target.kind", "deployTarget"], ["target.vercelProjectId", "vercelProjectId"], ["target.followOnly", "vercelFollowOnly"],
  ];
  for (const [key, col] of cols) {
    if (!(col in data)) continue;
    const before = a[col] as string | number | boolean | null;
    if (before !== data[col]) changes.push({ key, before, after: data[col] as string | number | boolean | null });
  }
  if ("releaseCommand" in data && data.releaseCommand !== a.releaseCommand) changes.push({ key: "release.command", before: null, after: "changed" });
  return { data, refusals, changes };
}
