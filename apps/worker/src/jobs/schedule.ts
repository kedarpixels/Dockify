/** Missed runs never queue up: a due job runs once if within JOB_LATE_MINUTES, else is recorded as missed. */
import { createHash } from "node:crypto";
import { jobs as J } from "@dockify/contracts";
import type { Prisma } from "@dockify/db";
import { isTimeZone } from "@dockify/contracts";
import { CronError, nextRun, parseCron } from "../data/cron.ts";

export const ACTIVE_RUN = ["queued", "running"] as const;
const JITTER_MS = 30_000;
const GAP_SAMPLES = 96;

export function scheduleProblem(schedule: string, timezone: string, from = new Date()): string | null {
  if (!isTimeZone(timezone)) return `The time zone ${timezone} is not known`;
  try {
    const parsed = parseCron(schedule);
    let at = nextRun(parsed, timezone, from);
    for (let i = 0; i < GAP_SAMPLES; i++) {
      const after = nextRun(parsed, timezone, at);
      if (after.getTime() - at.getTime() < J.JOB_MIN_INTERVAL_MINUTES * 60_000) {
        return `This schedule fires more often than the ${J.JOB_MIN_INTERVAL_MINUTES} minute minimum`;
      }
      at = after;
    }
    return null;
  } catch (e) {
    if (e instanceof CronError) return `That schedule is not valid: ${e.message}`;
    throw e;
  }
}

export const firstRunAt = (schedule: string, timezone: string, from = new Date()): Date => nextRun(schedule, timezone, from);

/** A fixed offset per job, so jobs due at the same minute do not all start at its first second. */
export function jitterMs(jobId: string): number {
  return createHash("sha256").update(jobId).digest().readUInt32BE(0) % JITTER_MS;
}

export type DueDecision =
  | { action: "run" }
  | { action: "replace" }
  | { action: "record"; status: "skipped" | "missed"; reason: string };

export function decideDue(o: {
  scheduledFor: Date;
  now: Date;
  overlap: string;
  active: boolean;
  waiting: number;
  appRuns: { kind: string; deployTarget: string; desiredState: string; hasDeployment: boolean };
}): DueDecision {
  const skip = (reason: string): DueDecision => ({ action: "record", status: "skipped", reason });
  if (o.now.getTime() - o.scheduledFor.getTime() > J.JOB_LATE_MINUTES * 60_000) {
    return { action: "record", status: "missed", reason: `Dockify was not running ${J.JOB_LATE_MINUTES} minutes after this was due, so it did not run late` };
  }
  if (!jobsAllowed(o.appRuns)) return skip("This kind of app has no scheduled jobs");
  if (o.appRuns.desiredState !== "running") return skip("The app is stopped");
  if (!o.appRuns.hasDeployment) return skip("The app has no successful deployment to run this from");
  if (o.active && o.overlap !== "replace") return skip("The previous run was still going");
  if (o.waiting >= J.JOB_MAX_WAITING_RUNS) return skip("Too many runs are waiting on this server");
  return o.active ? { action: "replace" } : { action: "run" };
}

const NO_JOBS = new Set(["postgres", "redis", "s3"]);
/** A managed database runs its own image, and nothing of a Vercel app runs on this server. */
export const jobsAllowed = (a: { kind: string; deployTarget: string }): boolean => !NO_JOBS.has(a.kind) && a.deployTarget === "server";

export async function queueRun(tx: Prisma.TransactionClient, jobId: string, serverId: string, o: { trigger: "schedule" | "manual"; scheduledFor: Date | null; delayMs: number }): Promise<string> {
  const run = await tx.scheduledJobRun.create({
    data: { jobId, trigger: o.trigger, status: "queued", scheduledFor: o.scheduledFor },
    select: { id: true },
  });
  await tx.job.create({
    // One attempt: a command that may have run is never run again by the queue.
    data: { kind: "scheduled_run", lane: "cron", serverId, payload: { runId: run.id }, maxAttempts: 1, runAfter: new Date(Date.now() + o.delayMs) },
  });
  return run.id;
}

export async function replaceActive(tx: Prisma.TransactionClient, jobId: string): Promise<void> {
  const now = new Date();
  await tx.scheduledJobRun.updateMany({ where: { jobId, status: "queued" }, data: { status: "cancelled", reason: "A newer run replaced it", finishedAt: now } });
  await tx.scheduledJobRun.updateMany({ where: { jobId, status: "running" }, data: { cancelRequested: true } });
}

/** Holds off a second decision about this job until the transaction ends. */
export const lockJob = (tx: Prisma.TransactionClient, jobId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`scheduled-job:${jobId}`}))`;

export class TailLog {
  private lines: string[] = [];
  private size = 0;
  private cut = false;
  private readonly max: number;
  constructor(max = J.JOB_LOG_BYTES) {
    this.max = max;
  }
  add(line: string): void {
    // Postgres text cannot hold a NUL, and a job can print anything.
    const clean = line.replace(/\0/g, "");
    this.lines.push(clean);
    this.size += Buffer.byteLength(clean) + 1;
    while (this.size > this.max && this.lines.length > 1) {
      this.size -= Buffer.byteLength(this.lines.shift()!) + 1;
      this.cut = true;
    }
    if (this.size > this.max) {
      this.lines = [clean.slice(-this.max)];
      this.size = Buffer.byteLength(this.lines[0]!) + 1;
      this.cut = true;
    }
  }
  get text(): string {
    return (this.cut ? "[earlier output was cut]\n" : "") + this.lines.join("\n");
  }
}
