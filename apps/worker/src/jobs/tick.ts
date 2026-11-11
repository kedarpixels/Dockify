/** A due job moves to its next time in the statement that claims it, so no due time is decided twice. */
import { jobs as J } from "@dockify/contracts";
import type { Db } from "@dockify/db";
import { CronError, nextRun } from "../data/cron.ts";
import { jobRunName } from "../deploy/containers.ts";
import { isNotFound, type DockerApi } from "@dockify/engine";
import { announceFailure } from "./run.ts";
import { ACTIVE_RUN, decideDue, jitterMs, lockJob, queueRun, replaceActive } from "./schedule.ts";

const DUE_BATCH = 100;
const ORPHAN_MIN_AGE_MS = 2 * 60_000;
export const ORPHAN_REASON = "Dockify's worker stopped while this ran.";

export async function jobsTick(db: Db, now = new Date()): Promise<number> {
  const due = await db.scheduledJob.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: DUE_BATCH,
    select: {
      id: true, schedule: true, timezone: true, overlap: true, nextRunAt: true,
      app: { select: { kind: true, deployTarget: true, desiredState: true, currentDeploymentId: true, serverId: true } },
    },
  });
  let decided = 0;
  for (const j of due) {
    let next: Date;
    try {
      next = nextRun(j.schedule, j.timezone, now);
    } catch (e) {
      if (!(e instanceof CronError)) throw e;
      // Saved schedules are checked, so only a hand-edited row lands here: it must not stay due forever.
      await db.scheduledJob.update({ where: { id: j.id }, data: { enabled: false, nextRunAt: null } });
      continue;
    }
    await db.$transaction(async (tx) => {
      await lockJob(tx, j.id);
      const moved = await tx.scheduledJob.updateMany({ where: { id: j.id, enabled: true, nextRunAt: j.nextRunAt }, data: { nextRunAt: next } });
      if (moved.count === 0) return;
      const scheduledFor = j.nextRunAt!;
      const active = await tx.scheduledJobRun.findFirst({ where: { jobId: j.id, status: { in: [...ACTIVE_RUN] } }, select: { id: true } });
      const waiting = await tx.scheduledJobRun.count({ where: { status: "queued" } });
      const decision = decideDue({
        scheduledFor, now, overlap: j.overlap, active: !!active, waiting,
        appRuns: { kind: j.app.kind, deployTarget: j.app.deployTarget, desiredState: j.app.desiredState, hasDeployment: !!j.app.currentDeploymentId },
      });
      if (decision.action === "record") {
        await tx.scheduledJobRun.create({ data: { jobId: j.id, trigger: "schedule", status: decision.status, reason: decision.reason, scheduledFor, finishedAt: now } });
      } else {
        if (decision.action === "replace") await replaceActive(tx, j.id);
        await queueRun(tx, j.id, j.app.serverId, { trigger: "schedule", scheduledFor, delayMs: jitterMs(j.id) });
      }
      decided += 1;
    });
  }
  return decided;
}

/** Orphan runs never settle and block the job's next run under the skip policy; their container goes too. */
export async function settleOrphanRuns(db: Db, docker: Pick<DockerApi, "removeContainer">, serverId: string, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - ORPHAN_MIN_AGE_MS);
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT r.id FROM scheduled_job_runs r
    JOIN scheduled_jobs s ON s.id = r."jobId"
    JOIN apps a ON a.id = s."appId"
    WHERE a."serverId" = ${serverId}::uuid
      AND r.status IN ('queued', 'running')
      AND r."createdAt" < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM jobs q
        WHERE q.kind = 'scheduled_run' AND q."completedAt" IS NULL AND q."failedAt" IS NULL
          AND q.payload->>'runId' = r.id::text)`;
  let settled = 0;
  for (const { id } of rows) {
    const r = await db.scheduledJobRun.findUnique({
      where: { id },
      include: { job: { include: { app: { include: { environment: { select: { name: true, project: { select: { slug: true } } } } } } } } },
    });
    if (!r) continue;
    const done = await db.scheduledJobRun.updateMany({ where: { id, status: { in: [...ACTIVE_RUN] } }, data: { status: "failed", reason: ORPHAN_REASON, finishedAt: new Date(now) } });
    if (done.count !== 1) continue;
    settled += 1;
    await docker.removeContainer(jobRunName(r.job.appId, id), { volumes: true }).catch((e: unknown) => {
      if (!isNotFound(e)) throw e;
    }).catch(() => {});
    await announceFailure(db, r, ORPHAN_REASON);
  }
  return settled;
}

export async function pruneJobHistory(db: Db, now = Date.now()): Promise<void> {
  const oldest = new Date(now - J.JOB_KEEP_DAYS * 86_400_000);
  await db.scheduledJobRun.deleteMany({ where: { createdAt: { lt: oldest }, status: { notIn: [...ACTIVE_RUN] } } });
  await db.$executeRaw`
    DELETE FROM scheduled_job_runs r USING (
      SELECT id, row_number() OVER (PARTITION BY "jobId" ORDER BY "createdAt" DESC) AS n
      FROM scheduled_job_runs WHERE status NOT IN ('queued', 'running')
    ) x
    WHERE r.id = x.id AND x.n > ${J.JOB_KEEP_RUNS}`;
  await db.buildDetection.deleteMany({ where: { createdAt: { lt: new Date(now - 10 * 60_000) } } });
}
