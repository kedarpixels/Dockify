/** New app's read of a repository. Nothing is built or run from it, and every field came from a hostile repository. */
import { readFile } from "node:fs/promises";
import { Redactor } from "@dockify/redact";
import type { Db, Prisma, SecretVault } from "@dockify/db";
import type { ClaimedJob } from "../queue.ts";
import { findDockerfile, plannedPort } from "@dockify/engine";
import { assertRoomToBuild, hostDiskUsage } from "./disk-guard.ts";
import type { Builder, ServerRuntime } from "../server/runtime.ts";
import type { DeployConfig } from "./config.ts";
import { checkout, discard, repoHost } from "./git.ts";
import { installationCredential } from "./github.ts";
import { isPermanent } from "@dockify/engine";
import { insideCheckout } from "@dockify/engine";
import type { PlanInfo } from "@dockify/engine";

export interface DetectDeps {
  db: Db;
  vault: SecretVault;
  config: DeployConfig;
  builder: Pick<Builder, "plan">;
  host: ServerRuntime["host"];
}

const PLAN_TIMEOUT_MS = 3 * 60_000;

export function detectPort(o: { dockerfile: string | null; framework: string | null; provider: string | null }): number | null {
  if (o.dockerfile === null) return plannedPort(o);
  const m = /^\s*EXPOSE\s+(\d{1,5})/im.exec(o.dockerfile);
  const port = m ? Number(m[1]) : NaN;
  return port >= 1 && port <= 65535 ? port : null;
}

export interface DetectAnswer {
  detected: boolean;
  builder: "dockerfile" | "railpack";
  hasDockerfile: boolean;
  framework: string | null;
  staticSite: boolean;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  dockerfilePath: string;
  port: number | null;
  reason: string | null;
}

export function detectAnswer(o: { dockerfilePath: string | null; dockerfile: string | null; plan: PlanInfo | null; reason: string | null }): DetectAnswer {
  const hasDockerfile = o.dockerfilePath !== null;
  const p = o.plan;
  return {
    detected: hasDockerfile || !!p,
    builder: hasDockerfile ? "dockerfile" : "railpack",
    hasDockerfile,
    framework: hasDockerfile ? "Dockerfile" : (p?.framework ?? null),
    staticSite: p?.staticSite ?? false,
    installCommand: p?.installCommand ?? "",
    buildCommand: p?.buildCommand ?? "",
    startCommand: p?.startCommand ?? "",
    dockerfilePath: o.dockerfilePath ?? "",
    port: detectPort({ dockerfile: hasDockerfile ? (o.dockerfile ?? "") : null, framework: p?.framework ?? null, provider: p?.provider ?? null }),
    reason: p || hasDockerfile ? null : o.reason,
  };
}

const redacted = (text: string) => new Redactor().line(text).slice(0, 1000);

export async function handleBuildDetect(deps: DetectDeps, job: ClaimedJob, signal: AbortSignal): Promise<void> {
  const id = (job.payload as { detectionId?: unknown } | null)?.detectionId;
  if (typeof id !== "string") return;
  const row = await deps.db.buildDetection.findUnique({ where: { id } });
  if (!row || row.status !== "pending") return;

  const finish = (data: Prisma.BuildDetectionUpdateInput) => deps.db.buildDetection.updateMany({ where: { id, status: "pending" }, data: { ...data, finishedAt: new Date() } as Prisma.BuildDetectionUpdateManyMutationInput });
  let root: string | null = null;
  try {
    // A clone takes room like a build does, and a page can ask for one with no deploy behind it.
    await assertRoomToBuild(hostDiskUsage(deps.host));
    const credential = await installationCredential({ db: deps.db, vault: deps.vault, apiBase: deps.config.githubApiBase }, row.installationId ? BigInt(row.installationId) : null, repoHost(row.repoUrl));
    const co = await checkout({
      url: row.repoUrl, branch: row.branch, commit: null, root: deps.config.buildRoot, credential,
      timeoutMs: deps.config.cloneTimeoutMs, maxBytes: deps.config.maxRepoBytes, signal,
    });
    root = co.root;
    const dockerfilePath = await findDockerfile(co.dir, row.rootDir, "");
    const dockerfile = dockerfilePath ? await readFile(await insideCheckout(co.dir, dockerfilePath), "utf8").catch(() => null) : null;
    let plan: PlanInfo | null = null;
    let reason: string | null = null;
    // A Dockerfile wins at deploy, so what Railpack would have made of the repository says nothing true.
    if (!dockerfilePath) {
      try {
        plan = await deps.builder.plan({
          checkoutRoot: co.root, checkoutDir: co.dir, rootDir: row.rootDir, vars: [],
          overrides: { installCommand: "", buildCommand: "", startCommand: "" },
          timeoutMs: PLAN_TIMEOUT_MS,
        }, (line) => line, signal);
      } catch (e) {
        // The reason is the answer. Anything else is worth a retry.
        if (!isPermanent(e)) throw e;
        reason = redacted(e instanceof Error ? e.message : String(e));
      }
    }
    await finish({ status: "done", result: detectAnswer({ dockerfilePath, dockerfile, plan, reason }) as unknown as Prisma.InputJsonValue });
  } catch (e) {
    if (signal.aborted || (!isPermanent(e) && job.attempts < job.maxAttempts)) throw e;
    await finish({ status: "failed", error: redacted(e instanceof Error ? e.message : String(e)) });
  } finally {
    if (root) void discard(root).catch(() => {});
  }
}
