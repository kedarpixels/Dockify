/**
 * One run of a scheduled job: a short-lived container from the image the app is serving, with its
 * variables, network and limits, through containerSpec() like every tenant container. Never in the
 * control plane, and a command only goes through a shell when it needs one, as a start command does.
 * No volume: a second writer on an app's data is a choice the owner has not made (fix log).
 */
import type { Db, SecretVault } from "@dockify/db";
import { Redactor } from "@dockify/redact";
import type { ContainerInput } from "@dockify/engine";
import { appContainerInput, imageArguments, jobRunName, type RunnableApp } from "../deploy/containers.ts";
import { Demuxer, isNotFound, type DockerApi } from "@dockify/engine";
import { openSnapshot, resolveEnv, runtimeEnv, type ResolvedVar } from "../deploy/env.ts";
import { couldNotRun, explainFailure, failureFacts } from "../deploy/failure.ts";
import { LineSplitter } from "../deploy/log.ts";
import { hasEntrypoint } from "../deploy/swap.ts";
import { DeferJobError, PermanentJobError } from "../errors.ts";
import { queueEventNotice } from "../integrations/events.ts";
import type { ClaimedJob } from "../queue.ts";
import { TailLog } from "./schedule.ts";

export interface JobRunDeps {
  db: Db;
  vault: SecretVault;
  docker: DockerApi;
  /** Test hooks. */
  pollMs?: number;
  flushMs?: number;
}

const POLL_MS = 2_000;
const FLUSH_MS = 3_000;
const REPLACE_WAIT_MS = 3_000;

export function parseRunPayload(p: unknown): string {
  const id = (p as { runId?: unknown } | null)?.runId;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new PermanentJobError("scheduled_run payload has no runId");
  return id;
}

const loadRun = (db: Db, id: string) =>
  db.scheduledJobRun.findUnique({
    where: { id },
    include: {
      job: {
        include: {
          app: {
            include: {
              currentDeployment: { select: { id: true, imageId: true, envSecretId: true } },
              environment: { select: { projectId: true, name: true, project: { select: { slug: true } } } },
            },
          },
        },
      },
    },
  });
type LoadedRun = NonNullable<Awaited<ReturnType<typeof loadRun>>>;

const runnableApp = (a: LoadedRun["job"]["app"]): RunnableApp => {
  const sysctls: Record<string, string> = {};
  for (const [k, v] of Object.entries((a.sysctls ?? {}) as Record<string, unknown>)) if (typeof v === "string") sysctls[k] = v;
  return {
    id: a.id, kind: a.kind, environmentId: a.environmentId, projectId: a.environment.projectId, port: null, startCommand: null,
    memoryLimitMb: a.memoryLimitMb, cpuLimit: a.cpuLimit, pidsLimit: a.pidsLimit, capAdd: [...a.capAdd], sysctls, volumes: [],
  };
};

/** A run's container input: the release one-off's shape, under its own role and name. */
export function jobContainerInput(app: RunnableApp, o: { runId: string; imageId: string; env: Record<string, string>; deploymentId: string; command: string }): ContainerInput {
  return appContainerInput(app, { name: jobRunName(app.id, o.runId), imageId: o.imageId, env: o.env, deploymentId: o.deploymentId, role: "job", cmd: o.command });
}

/** The variables the app is running with, or today's for a deployment that kept none. */
async function runVars(deps: JobRunDeps, r: LoadedRun): Promise<ResolvedVar[]> {
  const a = r.job.app;
  const sealed = a.currentDeployment?.envSecretId;
  return sealed ? openSnapshot(deps.db, deps.vault, sealed) : resolveEnv(deps.db, deps.vault, { projectId: a.environment.projectId, environmentId: a.environmentId, appId: a.id });
}

type Outcome = { status: "succeeded" | "failed" | "timed_out" | "cancelled"; exitCode: number | null; reason: string | null };

async function settle(deps: JobRunDeps, r: LoadedRun, out: Outcome, log: string, imageId: string | null): Promise<void> {
  const done = await deps.db.scheduledJobRun.updateMany({
    where: { id: r.id, status: { in: ["queued", "running"] } },
    data: { status: out.status, exitCode: out.exitCode, reason: out.reason, log, imageId, finishedAt: new Date() },
  });
  if (done.count === 1 && (out.status === "failed" || out.status === "timed_out")) await announceFailure(deps.db, r, out.reason ?? `It exited with code ${out.exitCode}.`);
}

/**
 * One notice when a job starts failing, not one per run: a job that runs every five minutes and has
 * been broken since Tuesday should not send 600 mails. A success ends the streak.
 */
export async function announceFailure(
  db: Db,
  r: { id: string; createdAt: Date; jobId: string; job: { name: string; app: { id: string; name: string; environment: { name: string; project: { slug: string } } } } },
  reason: string | null,
): Promise<boolean> {
  const before = await db.scheduledJobRun.findFirst({
    where: { jobId: r.jobId, id: { not: r.id }, createdAt: { lt: r.createdAt }, status: { in: ["succeeded", "failed", "timed_out"] } },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });
  if (before && before.status !== "succeeded") return false;
  const a = r.job.app;
  return queueEventNotice(db, {
    event: "jobFailed",
    id: r.id,
    title: `Scheduled job failed: ${r.job.name}`.slice(0, 120),
    detail: (reason ?? "The job did not finish").replace(/\s+/g, " ").slice(0, 2000),
    where: `${a.environment.project.slug} / ${a.environment.name} / ${a.name}`,
    href: `/apps/${a.id}?tab=jobs`,
    at: new Date().toISOString(),
  }).catch(() => false);
}

export async function handleScheduledRun(deps: JobRunDeps, job: ClaimedJob, shutdown: AbortSignal): Promise<void> {
  const runId = parseRunPayload(job.payload);
  const r = await loadRun(deps.db, runId);
  if (!r || r.status !== "queued") return;

  // A replace: the older run is told to stop, and this one waits its turn without spending its attempt.
  const older = await deps.db.scheduledJobRun.findFirst({ where: { jobId: r.jobId, status: "running", id: { not: r.id } }, select: { id: true } });
  if (older) {
    await deps.db.scheduledJobRun.update({ where: { id: older.id }, data: { cancelRequested: true } });
    throw new DeferJobError("waiting for the run it replaces to stop", REPLACE_WAIT_MS);
  }

  const a = r.job.app;
  const imageId = a.currentDeployment?.imageId ?? null;
  if (!imageId || !a.currentDeployment) return settle(deps, r, { status: "failed", exitCode: null, reason: "The app has no successful deployment to run this from." }, "", null);
  const present = await deps.docker.inspectImage(imageId).then(() => true, (e) => (isNotFound(e) ? false : Promise.reject(e)));
  if (!present) return settle(deps, r, { status: "failed", exitCode: null, reason: `The image ${imageId.slice(0, 19)} is no longer on this server. Deploy the app again.` }, "", imageId);

  let vars: ResolvedVar[];
  try {
    vars = await runVars(deps, r);
  } catch (e) {
    return settle(deps, r, { status: "failed", exitCode: null, reason: `The app's variables could not be opened: ${e instanceof Error ? e.message : String(e)}` }, "", imageId);
  }
  const claimed = await deps.db.scheduledJobRun.updateMany({ where: { id: r.id, status: "queued" }, data: { status: "running", startedAt: new Date(), imageId } });
  if (claimed.count === 0) return;

  const redactor = new Redactor();
  redactor.conceal(vars.filter((v) => v.isSecret).map((v) => v.value));
  const tail = new TailLog();
  const flush = async () => {
    await deps.db.scheduledJobRun.update({ where: { id: r.id }, data: { log: tail.text } }).catch(() => {});
  };
  const input = jobContainerInput(runnableApp(a), { runId: r.id, imageId, env: runtimeEnv(vars, a.port), deploymentId: a.currentDeployment.id, command: r.job.command });
  const name = input.name;

  await deps.docker.removeContainer(name, { volumes: true }).catch(() => {});
  try {
    let out = await runContainer(deps, r, input, tail, redactor, flush, shutdown);
    // The start command's rule: a word that is no program in the image goes to its entrypoint instead.
    if (out.notRun) {
      const asArguments = imageArguments(r.job.command);
      if (asArguments && (await hasEntrypoint(deps.docker, imageId))) {
        const { entrypoint: _replaced, ...rest } = input;
        out = await runContainer(deps, r, { ...rest, ...asArguments }, tail, redactor, flush, shutdown);
      }
    }
    await settle(deps, r, out, tail.text, imageId);
  } catch (e) {
    await settle(deps, r, { status: "failed", exitCode: null, reason: redactor.line(e instanceof Error ? e.message : String(e)) }, tail.text, imageId);
  }
}

async function runContainer(
  deps: JobRunDeps,
  r: LoadedRun,
  input: ContainerInput,
  tail: TailLog,
  redactor: Redactor,
  flush: () => Promise<void>,
  shutdown: AbortSignal,
): Promise<Outcome & { notRun: boolean }> {
  const { docker, db } = deps;
  const id = await docker.createContainer(input.name, input);
  const stop = new AbortController();
  const timeout = AbortSignal.timeout(r.job.timeoutSeconds * 1000);
  const poll = setInterval(() => {
    void db.scheduledJobRun.findUnique({ where: { id: r.id }, select: { cancelRequested: true } }).then((row) => {
      // A run whose row went with its app stops too.
      if (!row || row.cancelRequested) stop.abort();
    }, () => {});
  }, deps.pollMs ?? POLL_MS);
  poll.unref?.();
  const flusher = setInterval(() => void flush(), deps.flushMs ?? FLUSH_MS);
  flusher.unref?.();
  try {
    await docker.startContainer(id);
    const drained = drain(docker, id, tail, redactor);
    let code: number;
    try {
      code = await docker.waitContainer(id, AbortSignal.any([stop.signal, timeout, shutdown]));
    } catch (e) {
      await docker.stopContainer(id, 10).catch(() => {});
      await drained;
      if (timeout.aborted) return { status: "timed_out", exitCode: null, reason: `It was still running after ${r.job.timeoutSeconds} seconds and was stopped.`, notRun: false };
      if (stop.signal.aborted) return { status: "cancelled", exitCode: null, reason: "A newer run replaced it.", notRun: false };
      if (shutdown.aborted) return { status: "cancelled", exitCode: null, reason: "Dockify's worker restarted while it ran.", notRun: false };
      throw e;
    }
    await drained;
    if (code === 0) return { status: "succeeded", exitCode: 0, reason: null, notRun: false };
    const info = await docker.inspectContainer(id).catch(() => null);
    const facts = await failureFacts(docker, id, { command: r.job.command, info, exitCode: code, redact: (l) => redactor.line(l) });
    const notRun = couldNotRun(facts);
    const why = notRun ? explainFailure(facts) : "";
    return { status: "failed", exitCode: code, reason: why || null, notRun };
  } finally {
    clearInterval(poll);
    clearInterval(flusher);
    await docker.removeContainer(id, { volumes: true }).catch(() => {});
  }
}

async function drain(docker: DockerApi, id: string, tail: TailLog, redactor: Redactor): Promise<void> {
  try {
    const stream = await docker.logs(id, true);
    const demux = new Demuxer();
    const lines = new LineSplitter((t) => tail.add(redactor.line(t)));
    for await (const chunk of stream) demux.push(chunk as Buffer, (_s, d) => lines.push(d.toString("utf8")));
    lines.end();
  } catch {
    // Output is diagnostic only.
  }
}
