/**
 * The deploy module's job handlers, for main.ts to merge into its table:
 *   deploy   the pipeline (clone, build, pin, release command, swap, readiness, route flip)
 *   janitor  image, cache and deployment retention, and the unused anonymous volume report
 * Both settle their own failures; only infrastructure errors escape to the queue for a retry.
 */
import type { Db, JobKind, SecretVault } from "@dockify/db";
import type { ClaimedJob } from "../queue.ts";
import type { DeployConfig } from "./config.ts";
import { handleBuildDetect } from "./detect.ts";
import type { DockerClient } from "@dockify/engine";
import { runJanitor } from "./janitor.ts";
import { handleDeploy, type DeployDeps } from "./pipeline.ts";
import type { Builder, ServerRuntime } from "../server/runtime.ts";

export type DeployJobHandler = (job: ClaimedJob, signal: AbortSignal) => Promise<void>;

export interface DeployModuleDeps extends Pick<DeployDeps, "serverId" | "routes" | "mode" | "dial" | "certificateReady"> {
  db: Db;
  vault: SecretVault;
  config: DeployConfig;
  docker: DockerClient;
  builder: Builder;
  host: ServerRuntime["host"];
}

export function deployHandlers(deps: DeployModuleDeps): Partial<Record<JobKind, DeployJobHandler>> {
  const { db, vault, config, docker, builder, host, serverId } = deps;
  // The one read the socket proxy allows for volumes (GET /system/df?type=volume), for the janitor's report.
  const volumes = async () => (await docker.diskUsage(["volume"], AbortSignal.timeout(10 * 60_000))).Volumes ?? [];
  return {
    deploy: (job, signal) => handleDeploy({
      db, vault, docker, config, serverId, routes: deps.routes, mode: deps.mode, dial: deps.dial, builder, host,
      ...(deps.certificateReady ? { certificateReady: deps.certificateReady } : {}),
    }, job, signal),
    build_detect: (job, signal) => handleBuildDetect({ db, vault, config, builder, host }, job, signal),
    janitor: async () => {
      await runJanitor({ db, docker, config, serverId, builder, volumes });
    },
  };
}

export { settleOrphanedDeployments } from "./pipeline.ts";
export { loadDeployConfig, type DeployConfig } from "./config.ts";
