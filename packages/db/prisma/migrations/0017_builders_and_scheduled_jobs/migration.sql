-- Builds without a Dockerfile, and per-app scheduled jobs.
--   apps.installCommand   the install step of a Railpack build, when overridden.
--   build_detections      New app's read of a repository, private to who asked.
--   scheduled_jobs        one app's cron jobs.
--   scheduled_job_runs    each run, with its redacted output and exit code.

-- AlterEnum
ALTER TYPE "JobKind" ADD VALUE 'build_detect';
ALTER TYPE "JobKind" ADD VALUE 'scheduled_run';

-- AlterEnum
ALTER TYPE "JobLane" ADD VALUE 'detect';
ALTER TYPE "JobLane" ADD VALUE 'cron';

-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "installCommand" TEXT;

-- CreateTable
CREATE TABLE "scheduled_jobs" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "command" TEXT NOT NULL,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 600,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "overlap" TEXT NOT NULL DEFAULT 'skip',
    "nextRunAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_job_runs" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "exitCode" INTEGER,
    "imageId" TEXT,
    "log" TEXT NOT NULL DEFAULT '',
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "scheduledFor" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "build_detections" (
    "id" UUID NOT NULL,
    "requestKey" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "rootDir" TEXT NOT NULL DEFAULT '',
    "installationId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "build_detections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_jobs_enabled_nextRunAt_idx" ON "scheduled_jobs"("enabled", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_jobs_appId_name_key" ON "scheduled_jobs"("appId", "name");

-- CreateIndex
CREATE INDEX "scheduled_job_runs_jobId_createdAt_idx" ON "scheduled_job_runs"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "scheduled_job_runs_status_createdAt_idx" ON "scheduled_job_runs"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "build_detections_requestKey_key" ON "build_detections"("requestKey");

-- CreateIndex
CREATE INDEX "build_detections_createdAt_idx" ON "build_detections"("createdAt");

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_job_runs" ADD CONSTRAINT "scheduled_job_runs_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "scheduled_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
