// Scheduled jobs on an app, and New app's read of a repository. A job's command runs with the app's secrets, so audit rows name a changed command but never its text.
import { createHash } from "node:crypto";
import { iso, jobs as J } from "@dockify/contracts";
import type { Prisma } from "@dockify/db";
import { actorFields, assertProjectScope, meta, readsCommands, requireActor, type Actor } from "../../actor.ts";
import type { Ctx, Handlers } from "../../app.ts";
import { audit } from "../../audit.ts";
import { HttpError, isUniqueViolation } from "../../errors.ts";
import { ACTIVE_RUN, firstRunAt, jobsAllowed, lockJob, queueRun, replaceActive, scheduleProblem } from "../../../../worker/src/jobs/schedule.ts";
import { isBlockedHost, repoHostOf } from "../projects/host-rule.ts";


const APP_SELECT = {
  id: true, name: true, kind: true, deployTarget: true, desiredState: true, currentDeploymentId: true, serverId: true,
  environment: { select: { name: true, projectId: true, project: { select: { slug: true } } } },
} as const satisfies Prisma.AppSelect;

async function loadApp(ctx: Ctx, actor: Actor, id: string) {
  const app = await ctx.db.app.findUnique({ where: { id }, select: APP_SELECT });
  if (!app) throw new HttpError(404, "App not found", "NOT_FOUND");
  assertProjectScope(actor, app.environment.projectId);
  return app;
}
type App = Awaited<ReturnType<typeof loadApp>>;

const label = (a: App, job: string) => `${a.environment.project.slug}/${a.environment.name}/${a.name}: ${job}`;

function assertJobsAllowed(a: App): void {
  if (!jobsAllowed(a)) throw new HttpError(400, a.deployTarget === "vercel" ? "Nothing of a Vercel app runs on this server, so it has no scheduled jobs" : "A managed database has no scheduled jobs", "REFUSED");
}

async function loadJob(ctx: Ctx, appId: string, jobId: string) {
  const job = await ctx.db.scheduledJob.findFirst({ where: { id: jobId, appId } });
  if (!job) throw new HttpError(404, "Job not found", "NOT_FOUND");
  return job;
}

function checkSchedule(schedule: string, timezone: string): void {
  const problem = scheduleProblem(schedule, timezone);
  if (problem) throw new HttpError(400, problem, "INVALID_SCHEDULE", { field: /time zone/.test(problem) ? "timezone" : "schedule" });
}

type RunRow = { id: string; trigger: string; status: string; reason: string | null; exitCode: number | null; scheduledFor: Date | null; startedAt: Date | null; finishedAt: Date | null; createdAt: Date };
const runView = (r: RunRow) => ({
  id: r.id,
  trigger: r.trigger as "schedule" | "manual",
  status: r.status as (typeof J.JobRunStatus.options)[number],
  reason: r.reason,
  exitCode: r.exitCode,
  scheduledFor: iso(r.scheduledFor),
  startedAt: iso(r.startedAt),
  finishedAt: iso(r.finishedAt),
  createdAt: r.createdAt.toISOString(),
});

const RUN_COLUMNS = { id: true, trigger: true, status: true, reason: true, exitCode: true, scheduledFor: true, startedAt: true, finishedAt: true, createdAt: true } as const;

type JobRow = { id: string; name: string; schedule: string; timezone: string; command: string; timeoutSeconds: number; overlap: string; enabled: boolean; nextRunAt: Date | null };
const jobView = (j: JobRow, last: RunRow | null) => ({
  id: j.id,
  name: j.name,
  schedule: j.schedule,
  timezone: j.timezone,
  command: j.command,
  timeoutSeconds: j.timeoutSeconds,
  overlap: j.overlap as "skip" | "replace",
  enabled: j.enabled,
  nextRunAt: iso(j.nextRunAt),
  lastRun: last ? runView(last) : null,
});

async function listJobs(ctx: Ctx, appId: string) {
  const jobs = await ctx.db.scheduledJob.findMany({
    where: { appId },
    orderBy: { name: "asc" },
    include: { runs: { orderBy: { createdAt: "desc" }, take: 1, select: RUN_COLUMNS } },
  });
  return {
    jobs: jobs.map((j) => jobView(j, j.runs[0] ?? null)),
    limits: {
      maxJobs: J.JOB_MAX_PER_APP,
      minIntervalMinutes: J.JOB_MIN_INTERVAL_MINUTES,
      minTimeoutSeconds: J.JOB_MIN_TIMEOUT_SECONDS,
      maxTimeoutSeconds: J.JOB_MAX_TIMEOUT_SECONDS,
      keepRuns: J.JOB_KEEP_RUNS,
      keepDays: J.JOB_KEEP_DAYS,
    },
  };
}

const nameTaken = () => new HttpError(409, "This app already has a job with that name", "NAME_TAKEN", { field: "name" });

/** New reads one person may have at a time, and on the server: each is a clone and a BuildKit step. */
const MAX_READS_PER_ACTOR = 10;
const MAX_PENDING_READS = 8;
/** A finished read answers repeats for this long; pushing a fix and asking again gets a fresh one soon after. */
const READ_FRESH_MS = 60_000;
/** The worker has plainly given up on a read still pending after this. */
const READ_STALE_MS = 6 * 60_000;

const blankDetect = (rootDir: string) => ({
  pending: false, detected: false, builder: "railpack" as const, hasDockerfile: false, framework: null, staticSite: false,
  rootDir, installCommand: "", buildCommand: "", startCommand: "", dockerfilePath: "", port: null, reason: null as string | null,
});

export const jobsHandlers: Handlers = {
  "apps.jobs.list": async ({ params, actor, ctx }) => {
    const a = requireActor(actor);
    const app = await loadApp(ctx, a, params.id);
    const list = await listJobs(ctx, app.id);
    return readsCommands(a) ? list : { ...list, jobs: list.jobs.map((j) => ({ ...j, command: "" })) };
  },

  "apps.jobs.create": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const app = await loadApp(ctx, a, params.id);
    assertJobsAllowed(app);
    checkSchedule(body.schedule, body.timezone);
    try {
      const job = await ctx.db.$transaction(async (tx) => {
        // One app at a time, so two creates cannot both pass the count.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`scheduled-jobs:${app.id}`}))`;
        if ((await tx.scheduledJob.count({ where: { appId: app.id } })) >= J.JOB_MAX_PER_APP) {
          throw new HttpError(400, `An app can have ${J.JOB_MAX_PER_APP} scheduled jobs`, "TOO_MANY_JOBS");
        }
        const created = await tx.scheduledJob.create({
          data: { ...body, command: body.command.trim(), appId: app.id, nextRunAt: body.enabled ? firstRunAt(body.schedule, body.timezone) : null },
        });
        await audit(tx, {
          category: "config", action: "job.create", verb: "created scheduled job", ...actorFields(a), targetType: "app", targetId: app.id,
          targetLabel: label(app, created.name), suffix: `(${created.schedule}, ${created.timezone})`, ...meta(req),
        });
        return created;
      });
      return jobView(job, null);
    } catch (e) {
      if (isUniqueViolation(e)) throw nameTaken();
      throw e;
    }
  },

  "apps.jobs.update": async ({ params, body, actor, ctx, req }) => {
    const a = requireActor(actor);
    const app = await loadApp(ctx, a, params.id);
    assertJobsAllowed(app);
    const job = await loadJob(ctx, app.id, params.jobId);
    const schedule = body.schedule ?? job.schedule;
    const timezone = body.timezone ?? job.timezone;
    const enabled = body.enabled ?? job.enabled;
    if (schedule !== job.schedule || timezone !== job.timezone) checkSchedule(schedule, timezone);
    // Turned on or rescheduled, the next time comes from now; a job left alone keeps its place.
    const rework = schedule !== job.schedule || timezone !== job.timezone || (enabled && !job.enabled);
    const nextRunAt = !enabled ? null : rework || !job.nextRunAt ? firstRunAt(schedule, timezone) : job.nextRunAt;
    const data = { ...body, ...(body.command !== undefined ? { command: body.command.trim() } : {}), nextRunAt };
    const changed = Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined && body[k as keyof typeof body] !== job[k as keyof typeof job]);
    try {
      const updated = await ctx.db.$transaction(async (tx) => {
        const row = await tx.scheduledJob.update({ where: { id: job.id }, data });
        if (changed.length) {
          await audit(tx, {
            category: "config", action: "job.update", verb: "changed scheduled job", ...actorFields(a), targetType: "app", targetId: app.id,
            targetLabel: label(app, row.name), suffix: `(${changed.join(", ")})`, ...meta(req),
          });
        }
        return row;
      });
      const last = await ctx.db.scheduledJobRun.findFirst({ where: { jobId: job.id }, orderBy: { createdAt: "desc" }, select: RUN_COLUMNS });
      return jobView(updated, last);
    } catch (e) {
      if (isUniqueViolation(e)) throw nameTaken();
      throw e;
    }
  },

  "apps.jobs.delete": async ({ params, actor, ctx, req }) => {
    const a = requireActor(actor);
    const app = await loadApp(ctx, a, params.id);
    const job = await loadJob(ctx, app.id, params.jobId);
    await ctx.db.$transaction(async (tx) => {
      await tx.scheduledJob.delete({ where: { id: job.id } });
      await audit(tx, { category: "config", action: "job.delete", verb: "deleted scheduled job", ...actorFields(a), targetType: "app", targetId: app.id, targetLabel: label(app, job.name), ...meta(req) });
    });
  },

  "apps.jobs.run": async ({ params, actor, ctx, req }) => {
    const a = requireActor(actor);
    const app = await loadApp(ctx, a, params.id);
    assertJobsAllowed(app);
    const job = await loadJob(ctx, app.id, params.jobId);
    if (app.desiredState !== "running") throw new HttpError(409, "The app is stopped. Start it to run its jobs.", "APP_STOPPED");
    if (!app.currentDeploymentId) throw new HttpError(409, "The app has no successful deployment to run this from yet.", "NOT_DEPLOYED");
    const runId = await ctx.db.$transaction(async (tx) => {
      await lockJob(tx, job.id);
      const active = await tx.scheduledJobRun.findFirst({ where: { jobId: job.id, status: { in: [...ACTIVE_RUN] } }, select: { id: true } });
      if (active && job.overlap !== "replace") throw new HttpError(409, "This job is already running.", "JOB_ACTIVE", { runId: active.id });
      if ((await tx.scheduledJobRun.count({ where: { status: "queued" } })) >= J.JOB_MAX_WAITING_RUNS) throw new HttpError(429, "Too many runs are waiting on this server. Try again in a minute.", "JOBS_BUSY");
      if (active) await replaceActive(tx, job.id);
      const id = await queueRun(tx, job.id, app.serverId, { trigger: "manual", scheduledFor: null, delayMs: 0 });
      await audit(tx, { category: "deploys", action: "job.run", verb: "ran scheduled job", ...actorFields(a), targetType: "app", targetId: app.id, targetLabel: label(app, job.name), ...meta(req) });
      return id;
    });
    return { runId };
  },

  "apps.jobs.runs": async ({ params, actor, ctx }) => {
    const app = await loadApp(ctx, requireActor(actor), params.id);
    await loadJob(ctx, app.id, params.jobId);
    const runs = await ctx.db.scheduledJobRun.findMany({ where: { jobId: params.jobId }, orderBy: { createdAt: "desc" }, take: J.JOB_KEEP_RUNS, select: RUN_COLUMNS });
    return { runs: runs.map(runView) };
  },

  "apps.jobs.run.get": async ({ params, actor, ctx }) => {
    const app = await loadApp(ctx, requireActor(actor), params.id);
    await loadJob(ctx, app.id, params.jobId);
    const run = await ctx.db.scheduledJobRun.findFirst({ where: { id: params.runId, jobId: params.jobId }, select: { ...RUN_COLUMNS, log: true } });
    if (!run) throw new HttpError(404, "Run not found", "NOT_FOUND");
    return { ...runView(run), log: run.log };
  },

  /** A repeat of the same request answers from the row, so a polling page never queues a second clone. The answer is private to who asked: it may describe a repository only their installation can read. */
  "apps.detect": async ({ body, actor, ctx }) => {
    const a = requireActor(actor);
    if (isBlockedHost(repoHostOf(body.repoUrl))) throw new HttpError(400, "That repository host is not reachable from Dockify", "REFUSED", { field: "repoUrl" });
    const installationId = body.git?.installationId ?? null;
    if (installationId && !(/^\d{1,19}$/.test(installationId) && (await ctx.db.gitHubInstallation.findUnique({ where: { installationId: BigInt(installationId) }, select: { id: true } })))) {
      throw new HttpError(400, "That GitHub installation is not connected", "GIT_NOT_FOUND", { field: "git" });
    }
    const who = a.kind === "token" ? a.tokenId : a.userId;
    const requestKey = `${who}:${createHash("sha256").update(JSON.stringify([body.repoUrl, body.branch, body.rootDir, installationId])).digest("hex")}`;
    const now = Date.now();
    const row = await ctx.db.buildDetection.findUnique({ where: { requestKey } });
    const blank = blankDetect(body.rootDir);
    if (row) {
      const age = now - row.createdAt.getTime();
      if (row.status === "pending" && age < READ_STALE_MS) return { ...blank, pending: true };
      if (row.status === "failed" && age < READ_FRESH_MS) return { ...blank, reason: row.error ?? "The repository could not be read." };
      if (row.status === "done" && age < READ_FRESH_MS) return { ...blank, ...(row.result as object), rootDir: body.rootDir, pending: false };
      await ctx.db.buildDetection.deleteMany({ where: { id: row.id } });
    }
    const mine = await ctx.db.buildDetection.count({ where: { requestKey: { startsWith: `${who}:` }, createdAt: { gt: new Date(now - READ_FRESH_MS) } } });
    const pending = await ctx.db.buildDetection.count({ where: { status: "pending", createdAt: { gt: new Date(now - READ_STALE_MS) } } });
    if (mine >= MAX_READS_PER_ACTOR || pending >= MAX_PENDING_READS) throw new HttpError(429, "Too many repositories are being read. Try again in a minute.", "READS_BUSY");
    try {
      await ctx.db.$transaction(async (tx) => {
        const created = await tx.buildDetection.create({ data: { requestKey, repoUrl: body.repoUrl, branch: body.branch, rootDir: body.rootDir, installationId }, select: { id: true } });
        await tx.job.create({ data: { kind: "build_detect", lane: "detect", payload: { detectionId: created.id }, maxAttempts: 2 } });
      });
    } catch (e) {
      // Two tabs asked at once: the other one's read answers both.
      if (!isUniqueViolation(e)) throw e;
    }
    return { ...blank, pending: true };
  },
};
