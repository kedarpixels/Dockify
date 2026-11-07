-- Dockify's own preview email: the preview_notify job, and on each preview the state it last emailed
-- about. Previews already ready or failed are marked as told, so nobody gets mail for old news.

-- AlterEnum
ALTER TYPE "JobKind" ADD VALUE 'preview_notify';

-- AlterTable
ALTER TABLE "preview_envs" ADD COLUMN     "notifiedKey" TEXT;

UPDATE "preview_envs" SET "notifiedKey" = 'ready' WHERE "status" IN ('ready', 'asleep');
UPDATE "preview_envs" SET "notifiedKey" = CASE WHEN "fromFork" THEN 'failed' ELSE 'failed:' || COALESCE("commitSha", 'none') END WHERE "status" = 'failed';
