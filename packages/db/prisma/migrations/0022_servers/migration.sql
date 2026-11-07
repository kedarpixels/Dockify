-- The model behind several servers, with one of them. Nothing reads it to decide anything yet.
--   servers                one machine that runs apps. This inserts the one every install has.
--   apps, deployments      the server they run on, never null.
--   jobs                   which server's claim loops take it; null for the global loops.
--   metric_samples         which machine a host row describes.

-- CreateEnum
CREATE TYPE "ServerState" AS ENUM ('awaiting_join', 'pending_approval', 'active', 'revoked');

-- CreateTable
CREATE TABLE "servers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "state" "ServerState" NOT NULL,
    "joinTokenHash" TEXT,
    "joinExpiresAt" TIMESTAMPTZ(3),
    "certPin" TEXT,
    "joinedIp" TEXT,
    "ingress" "IngressMode" NOT NULL DEFAULT 'direct_tls',
    "publicIpv4" TEXT,
    "publicIpv6" TEXT,
    "hostname" TEXT,
    "os" TEXT,
    "kernel" TEXT,
    "dockerVersion" TEXT,
    "agentVersion" TEXT,
    "agentProto" INTEGER,
    "cpuCores" INTEGER,
    "memoryBytes" BIGINT,
    "clockSkewMs" INTEGER,
    "lastSeenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "servers_joinTokenHash_key" ON "servers"("joinTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "servers_certPin_key" ON "servers"("certPin");

-- One primary, and a name is taken only while its server is not revoked. Prisma cannot express these.
CREATE UNIQUE INDEX "servers_one_primary" ON "servers"("isPrimary") WHERE "isPrimary";
CREATE UNIQUE INDEX "servers_live_name" ON "servers"("name") WHERE "state" <> 'revoked';

-- The one server every install has. A fresh database has no instance row yet: the api names this
-- server when it creates that row (apps/api/src/boot.ts).
INSERT INTO "servers" ("id", "name", "isPrimary", "state", "ingress", "updatedAt")
SELECT gen_random_uuid(),
       COALESCE((SELECT "name" FROM "instance" WHERE "id" = 1), 'server-1'),
       true,
       'active'::"ServerState",
       COALESCE((SELECT "ingressMode" FROM "instance" WHERE "id" = 1), 'direct_tls'::"IngressMode"),
       now();

-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "serverId" UUID;
UPDATE "apps" SET "serverId" = (SELECT "id" FROM "servers" WHERE "isPrimary");
ALTER TABLE "apps" ALTER COLUMN "serverId" SET NOT NULL;

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "serverId" UUID;
UPDATE "deployments" SET "serverId" = (SELECT "id" FROM "servers" WHERE "isPrimary");
ALTER TABLE "deployments" ALTER COLUMN "serverId" SET NOT NULL;

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "serverId" UUID;
-- Every row the CHECK below covers, finished ones too, or the CHECK refuses the old rows.
UPDATE "jobs" SET "serverId" = (SELECT "id" FROM "servers" WHERE "isPrimary") WHERE "kind" IN ('deploy', 'remove_app', 'backup', 'restore', 'restore_test', 'prune', 'janitor', 'reconcile', 'preview_cleanup', 'preview_wake', 'edge_route_sync', 'app_power', 'scheduled_run', 'service_upgrade', 'vercel_sync') OR "lane" IN ('deploy', 'data', 'cron');

-- AlterTable
ALTER TABLE "metric_samples" ADD COLUMN     "serverId" UUID;
UPDATE "metric_samples" SET "serverId" = (SELECT "id" FROM "servers" WHERE "isPrimary") WHERE "appId" IS NULL;

-- DropIndex
DROP INDEX "jobs_lane_completedAt_failedAt_runAfter_idx";

-- CreateIndex
CREATE INDEX "jobs_lane_serverId_completedAt_failedAt_runAfter_idx" ON "jobs"("lane", "serverId", "completedAt", "failedAt", "runAfter");

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_samples" ADD CONSTRAINT "metric_samples_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A job only a server can run, or one on a lane only a server's loops claim, must name its server.
-- vercel_sync runs on the deploy lane, and a per-server deploy loop never claims a null. The list in
-- packages/db/src/queue.ts stays in step with this (queue.test.ts there). server_update joins in a later migration.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_server_bound" CHECK (("kind" NOT IN ('deploy', 'remove_app', 'backup', 'restore', 'restore_test', 'prune', 'janitor', 'reconcile', 'preview_cleanup', 'preview_wake', 'edge_route_sync', 'app_power', 'scheduled_run', 'service_upgrade', 'vercel_sync') AND "lane" NOT IN ('deploy', 'data', 'cron')) OR "serverId" IS NOT NULL);
