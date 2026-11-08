-- Two backup tiers per database: `local` on this server's disk and `offsite` to an S3 destination,
-- each with its own cron and its own count to keep, each on or off on its own. The one schedule an
-- app carried moves to the tier its destination names, with no change in what runs or what stays.

-- CreateEnum
CREATE TYPE "BackupTier" AS ENUM ('local', 'offsite');

-- CreateTable
CREATE TABLE "backup_schedules" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "tier" "BackupTier" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "cron" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "keep" INTEGER NOT NULL DEFAULT 7,
    "keepDays" INTEGER,
    "destinationId" UUID,
    "lastRunAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "backup_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "backup_schedules_appId_tier_key" ON "backup_schedules"("appId", "tier");

-- AddForeignKey
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "backup_destinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every service gets both tiers. Its schedule goes to the tier of the destination it used: its own,
-- else the default one (an app with none followed the default, and an offsite tier with none still
-- does). Old retention was "the newest 3 always stay, and anything newer than N days": keep 3 plus
-- keepDays N is that rule. The other tier is off, with the same retention for whatever it holds.
INSERT INTO "backup_schedules" ("id", "appId", "tier", "enabled", "cron", "timezone", "keep", "keepDays", "destinationId", "lastRunAt", "updatedAt")
SELECT
    gen_random_uuid(),
    s."id",
    t."tier"::"BackupTier",
    t."tier" = s."tier" AND s."backupEnabled",
    CASE WHEN t."tier" = s."tier" THEN s."backupCron" END,
    s."backupTimezone",
    3,
    LEAST(GREATEST(s."backupRetentionDays", 1), 3650),
    CASE WHEN t."tier" = s."tier" AND t."tier" = 'offsite' THEN s."backupDestinationId" END,
    CASE WHEN t."tier" = s."tier" THEN s."backupLastRunAt" END,
    CURRENT_TIMESTAMP
FROM (
    SELECT a."id", a."backupEnabled", a."backupCron", a."backupTimezone", a."backupRetentionDays", a."backupDestinationId", a."backupLastRunAt",
        CASE WHEN COALESCE(d."type", (SELECT def."type" FROM "backup_destinations" def WHERE def."isDefault" ORDER BY def."createdAt" LIMIT 1)) = 's3' THEN 'offsite' ELSE 'local' END AS "tier"
    FROM "apps" a
    LEFT JOIN "backup_destinations" d ON d."id" = a."backupDestinationId"
    WHERE a."kind" IN ('postgres', 'redis', 's3')
) s
CROSS JOIN (VALUES ('local'), ('offsite')) AS t("tier");

-- DropForeignKey
ALTER TABLE "apps" DROP CONSTRAINT "apps_backupDestinationId_fkey";

-- The schedule columns go, and the CHECK on one of them with them.
ALTER TABLE "apps" DROP CONSTRAINT "apps_retention_min";

-- AlterTable
ALTER TABLE "apps" DROP COLUMN "backupEnabled";
ALTER TABLE "apps" DROP COLUMN "backupCron";
ALTER TABLE "apps" DROP COLUMN "backupTimezone";
ALTER TABLE "apps" DROP COLUMN "backupRetentionDays";
ALTER TABLE "apps" DROP COLUMN "backupDestinationId";
ALTER TABLE "apps" DROP COLUMN "backupLastRunAt";

-- Keep 1 to 1000 backups, as the contract allows (BackupTierPatch.keep).
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_keep_range" CHECK ("keep" BETWEEN 1 AND 1000);

-- Optionally also every backup from the last 1 to 3650 days (BackupTierPatch.keepDays).
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_keep_days_range" CHECK ("keepDays" IS NULL OR "keepDays" BETWEEN 1 AND 3650);

-- Only an offsite tier names a destination: local is always this server's disk.
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_local_no_destination" CHECK ("tier" = 'offsite' OR "destinationId" IS NULL);
