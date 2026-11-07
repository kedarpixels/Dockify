/* The shapes of the Jobs tab and the checks its form makes before asking. Safe for both sides of the
   route; the api checks every value again and holds the limits. */

export type JobRunStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "skipped" | "missed";
export type JobOverlap = "skip" | "replace";

export interface JobRunRow {
  id: string;
  trigger: "schedule" | "manual";
  status: JobRunStatus;
  reason: string | null;
  exitCode: number | null;
  scheduledFor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}
export interface JobRunDetail extends JobRunRow {
  log: string;
}

export interface JobInput {
  name: string;
  schedule: string;
  timezone: string;
  command: string;
  timeoutSeconds: number;
  overlap: JobOverlap;
  enabled: boolean;
}

export interface ScheduledJobRow extends JobInput {
  id: string;
  nextRunAt: string | null;
  lastRun: JobRunRow | null;
}

export interface JobLimits {
  maxJobs: number;
  minIntervalMinutes: number;
  minTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  keepRuns: number;
  keepDays: number;
}
export interface AppJobs {
  jobs: ScheduledJobRow[];
  limits: JobLimits;
}

export const JOB_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SCHEDULE = /^\s*(\S+\s+){4}\S+\s*$/;
const SCHEDULE_CHARS = /^[\d*/,\- ]+$/;
const TIMEZONE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export type JobErrors = Partial<Record<"name" | "schedule" | "timezone" | "command" | "timeoutSeconds", string>>;
export interface JobDraft {
  name: string;
  schedule: string;
  timezone: string;
  command: string;
  timeout: string;
  overlap: JobOverlap;
  enabled: boolean;
}

export function jobErrors(d: JobDraft, limits: Pick<JobLimits, "minTimeoutSeconds" | "maxTimeoutSeconds">): JobErrors {
  const e: JobErrors = {};
  if (!JOB_NAME.test(d.name)) e.name = "Lowercase letters, digits and hyphens, up to 40";
  if (!SCHEDULE.test(d.schedule) || !SCHEDULE_CHARS.test(d.schedule)) e.schedule = "Five fields: minute, hour, day, month, weekday";
  if (!TIMEZONE.test(d.timezone)) e.timezone = "An IANA time zone, such as Europe/Berlin";
  const command = d.command.trim();
  if (!command) e.command = "Enter the command to run";
  else if (command.length > 1000 || CONTROL.test(command)) e.command = "One line, up to 1,000 characters";
  const t = Number(d.timeout);
  if (!Number.isInteger(t) || t < limits.minTimeoutSeconds || t > limits.maxTimeoutSeconds) e.timeoutSeconds = `A whole number from ${limits.minTimeoutSeconds} to ${limits.maxTimeoutSeconds.toLocaleString("en-US")}`;
  return e;
}

export const RUN_LABEL: Record<JobRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  timed_out: "Timed out",
  cancelled: "Cancelled",
  skipped: "Skipped",
  missed: "Missed",
};

export const isActiveRun = (s: JobRunStatus) => s === "queued" || s === "running";
/** A run that started a container has output to read. */
export const hasOutput = (r: Pick<JobRunRow, "startedAt">) => r.startedAt !== null;
