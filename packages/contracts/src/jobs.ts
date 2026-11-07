/**
 * Scheduled jobs: a cron schedule and a command on an app. Each run is a short-lived container from
 * the app's current image, with its variables, network and limits. The limits here are the only
 * copy: the api enforces them, the worker runs by them, and the web reads them from the job list.
 */
import { z } from "zod";
import { Command, Iso, Uuid } from "./common.ts";

/** A schedule that fires more often than this is refused when saved. */
export const JOB_MIN_INTERVAL_MINUTES = 5;
export const JOB_MAX_PER_APP = 10;
/** Runs one server has going at once: the worker's claim loops on the cron lane. */
export const JOB_MAX_CONCURRENT_RUNS = 3;
/** Queued runs one server keeps waiting; a due run past this is recorded as skipped. */
export const JOB_MAX_WAITING_RUNS = 20;
export const JOB_KEEP_RUNS = 50;
export const JOB_KEEP_DAYS = 30;
/** A run that was due longer ago than this is recorded as missed, never run late. */
export const JOB_LATE_MINUTES = 5;
export const JOB_MIN_TIMEOUT_SECONDS = 10;
export const JOB_MAX_TIMEOUT_SECONDS = 2 * 3600;
export const JOB_LOG_BYTES = 256 * 1024;

export const JobParams = z.strictObject({ id: Uuid, jobId: Uuid });
export const JobRunParams = z.strictObject({ id: Uuid, jobId: Uuid, runId: Uuid });

export const JobName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Lowercase letters, digits and hyphens, up to 40");
/** Five fields of digits and the usual operators. The worker's parser and the interval check run on top. */
export const JobSchedule = z.string().max(100).regex(/^\s*(\S+\s+){4}\S+\s*$/, "Five fields: minute, hour, day, month, weekday").regex(/^[\d*/,\- ]+$/, "Digits and * / , - only");
export const JobTimezone = z.string().regex(/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/, "An IANA time zone, such as Europe/Berlin");
export const JobCommand = Command.refine((v) => v.trim().length > 0, "A command is required");
export const JobTimeout = z.number().int().min(JOB_MIN_TIMEOUT_SECONDS).max(JOB_MAX_TIMEOUT_SECONDS);
export const JobOverlap = z.enum(["skip", "replace"]);

export const CreateJobBody = z.strictObject({
  name: JobName,
  schedule: JobSchedule,
  timezone: JobTimezone,
  command: JobCommand,
  timeoutSeconds: JobTimeout,
  overlap: JobOverlap,
  enabled: z.boolean(),
});
export const PatchJobBody = CreateJobBody.partial();

export const JobRunStatus = z.enum(["queued", "running", "succeeded", "failed", "timed_out", "cancelled", "skipped", "missed"]);
export const JobRun = z.object({
  id: z.string(),
  trigger: z.enum(["schedule", "manual"]),
  status: JobRunStatus,
  reason: z.string().nullable(),
  exitCode: z.number().nullable(),
  scheduledFor: Iso.nullable(),
  startedAt: Iso.nullable(),
  finishedAt: Iso.nullable(),
  createdAt: Iso,
});
export const JobRunDetail = JobRun.extend({ log: z.string() });

export const ScheduledJob = z.object({
  id: z.string(),
  name: z.string(),
  schedule: z.string(),
  timezone: z.string(),
  command: z.string(),
  timeoutSeconds: z.number(),
  overlap: JobOverlap,
  enabled: z.boolean(),
  nextRunAt: Iso.nullable(),
  lastRun: JobRun.nullable(),
});
export const AppJobs = z.object({
  jobs: z.array(ScheduledJob),
  limits: z.object({
    maxJobs: z.number(),
    minIntervalMinutes: z.number(),
    minTimeoutSeconds: z.number(),
    maxTimeoutSeconds: z.number(),
    keepRuns: z.number(),
    keepDays: z.number(),
  }),
});
export const JobRuns = z.object({ runs: z.array(JobRun) });
export const RunJobResponse = z.object({ runId: z.string() });
