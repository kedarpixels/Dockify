import { readSecret } from "@dockify/crypto";

export interface DeployConfig {
  buildRoot: string;
  diskPath: string;
  /** The dashboard hostname, never routable to a tenant. */
  dashboardHost: string;
  cloneTimeoutMs: number;
  buildTimeoutMs: number;
  releaseTimeoutMs: number;
  maxRepoBytes: number;
  keepReady: number;
  buildCacheBytes: number;
  deploymentRetentionDays: number;
  githubApiBase: string;
}

const num = (env: NodeJS.ProcessEnv, key: string, def: number, lo: number, hi: number): number => {
  const raw = env[key]?.trim();
  if (!raw) return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${key} must be a number from ${lo} to ${hi}`);
  return v;
};

export function loadDeployConfig(env: NodeJS.ProcessEnv = process.env): DeployConfig {
  let dashboardHost = "";
  const pub = env.DOCKIFY_PUBLIC_URL?.trim();
  if (pub) {
    try {
      dashboardHost = new URL(pub).hostname.toLowerCase();
    } catch {
      throw new Error("DOCKIFY_PUBLIC_URL is not a valid URL");
    }
  }
  return {
    buildRoot: env.DOCKIFY_BUILD_ROOT?.trim() || "/tmp/dockify-builds",
    // Any path on the filesystem Docker keeps containers and volumes on; the same one the disk alert reads.
    diskPath: env.DOCKIFY_METRICS_DISK_PATH?.trim() || "/",
    dashboardHost,
    cloneTimeoutMs: num(env, "DOCKIFY_CLONE_TIMEOUT_MS", 5 * 60_000, 10_000, 3_600_000),
    buildTimeoutMs: num(env, "DOCKIFY_BUILD_TIMEOUT_MS", 30 * 60_000, 60_000, 4 * 3_600_000),
    releaseTimeoutMs: num(env, "DOCKIFY_RELEASE_TIMEOUT_MS", 10 * 60_000, 10_000, 3_600_000),
    maxRepoBytes: num(env, "DOCKIFY_MAX_REPO_BYTES", 2 * 1024 ** 3, 1024 ** 2, 50 * 1024 ** 3),
    keepReady: num(env, "DOCKIFY_KEEP_READY", 5, 1, 50),
    buildCacheBytes: num(env, "DOCKIFY_BUILD_CACHE_BYTES", 20 * 1024 ** 3, 1024 ** 3, 2 * 1024 ** 4),
    deploymentRetentionDays: num(env, "DOCKIFY_DEPLOYMENT_RETENTION_DAYS", 90, 1, 3650),
    githubApiBase: (readSecret("DOCKIFY_GITHUB_API_BASE", env) ?? "https://api.github.com").replace(/\/+$/, ""),
  };
}
