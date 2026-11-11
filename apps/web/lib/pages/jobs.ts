import "server-only";
import { apiRequest } from "@/lib/api";
import { upstreamStatus, type RouteAnswer } from "@/lib/http";
import { isPreviewMode } from "@/lib/preview-mode";
import type { AppJobs, JobInput, JobRunDetail, JobRunRow, ScheduledJobRow } from "@/components/app-detail/jobs-shared";

// Scheduled jobs on an app. The API holds the rules (who may write, intervals, limits); this only forwards checked ids and bodies.

const NONE = { status: 503, body: { error: "No data source, set DOCKIFY_API_URL for this dashboard" } };

async function forward<T>(path: string, init: { method: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown }, demo: () => T): Promise<RouteAnswer<T | null>> {
  if (process.env.DOCKIFY_API_URL !== undefined) {
    const r = await apiRequest<T>(path, init);
    return r.ok ? { status: 200, body: r.data } : { status: upstreamStatus(r.status), body: { error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.body ?? {}) } };
  }
  return isPreviewMode() ? { status: 200, body: demo() } : NONE;
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const previewRun = (id: string, status: JobRunRow["status"], minutesAgo: number, over: Partial<JobRunRow> = {}): JobRunRow => ({
  id, trigger: "schedule", status, reason: null, exitCode: status === "succeeded" ? 0 : null,
  scheduledFor: at(minutesAgo), startedAt: at(minutesAgo), finishedAt: status === "running" ? null : at(minutesAgo - 1), createdAt: at(minutesAgo), ...over,
});
const previewJobs = (): AppJobs => ({
  jobs: [
    { id: "00000000-0000-4000-8000-00000000a001", name: "nightly-report", schedule: "0 3 * * *", timezone: "UTC", command: "node scripts/report.js", timeoutSeconds: 600, overlap: "skip", enabled: true, nextRunAt: at(-420), lastRun: previewRun("00000000-0000-4000-8000-00000000b001", "succeeded", 1020) },
    { id: "00000000-0000-4000-8000-00000000a002", name: "sync-partners", schedule: "*/15 * * * *", timezone: "Europe/Berlin", command: "npm run sync", timeoutSeconds: 300, overlap: "replace", enabled: true, nextRunAt: at(-9), lastRun: previewRun("00000000-0000-4000-8000-00000000b002", "failed", 6, { exitCode: 1 }) },
    { id: "00000000-0000-4000-8000-00000000a003", name: "prune-sessions", schedule: "30 4 * * 0", timezone: "UTC", command: "node scripts/prune.js --older-than=30d", timeoutSeconds: 900, overlap: "skip", enabled: false, nextRunAt: null, lastRun: null },
  ],
  limits: { maxJobs: 10, minIntervalMinutes: 5, minTimeoutSeconds: 10, maxTimeoutSeconds: 7200, keepRuns: 50, keepDays: 30 },
});
const previewRuns = (): JobRunRow[] => [
  previewRun("00000000-0000-4000-8000-00000000b002", "failed", 6, { exitCode: 1 }),
  previewRun("00000000-0000-4000-8000-00000000b003", "skipped", 21, { startedAt: null, reason: "The previous run was still going" }),
  previewRun("00000000-0000-4000-8000-00000000b004", "succeeded", 36),
  previewRun("00000000-0000-4000-8000-00000000b005", "timed_out", 51, { reason: "It was still running after 300 seconds and was stopped." }),
  previewRun("00000000-0000-4000-8000-00000000b006", "succeeded", 66, { trigger: "manual", scheduledFor: null }),
  previewRun("00000000-0000-4000-8000-00000000b007", "missed", 840, { startedAt: null, reason: "Dockify was not running 5 minutes after this was due, so it did not run late" }),
];

export const listJobs = (app: string) => forward<AppJobs>(`/api/v1/apps/${app}/jobs`, { method: "GET" }, previewJobs);
export const createJob = (app: string, body: JobInput) => forward<ScheduledJobRow>(`/api/v1/apps/${app}/jobs`, { method: "POST", body }, () => ({ ...previewJobs().jobs[0]!, ...body }));
export const updateJob = (app: string, job: string, body: Partial<JobInput>) => forward<ScheduledJobRow>(`/api/v1/apps/${app}/jobs/${job}`, { method: "PATCH", body }, () => ({ ...previewJobs().jobs[0]!, ...body, id: job }));
export const deleteJob = (app: string, job: string) => forward<null>(`/api/v1/apps/${app}/jobs/${job}`, { method: "DELETE" }, () => null);
export const runJob = (app: string, job: string) => forward<{ runId: string }>(`/api/v1/apps/${app}/jobs/${job}/run`, { method: "POST", body: {} }, () => ({ runId: "00000000-0000-4000-8000-00000000b001" }));
export const listRuns = (app: string, job: string) => forward<{ runs: JobRunRow[] }>(`/api/v1/apps/${app}/jobs/${job}/runs`, { method: "GET" }, () => ({ runs: previewRuns() }));
export const getRun = (app: string, job: string, run: string) =>
  forward<JobRunDetail>(`/api/v1/apps/${app}/jobs/${job}/runs/${run}`, { method: "GET" }, () => ({
    ...(previewRuns().find((r) => r.id === run) ?? previewRun(run, "succeeded", 1020)),
    log: "Fetching partners\nUpdated 412 rows\nError: the partner API answered 503\n    at sync (scripts/sync.js:41:11)\n",
  }));
