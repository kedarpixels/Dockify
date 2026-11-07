-- CreateEnum
CREATE TYPE "PreviewAccess" AS ENUM ('public', 'password');

-- AlterTable
ALTER TABLE "instance" ADD COLUMN     "terminalEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "previewAccess" "PreviewAccess" NOT NULL DEFAULT 'password';

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "previewPasswordHash" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "previewPasswordSetAt" TIMESTAMPTZ(3);

-- A project already serving previews keeps serving them the way it did: protecting it now would lock
-- its reviewers out behind a password nobody has seen. Its admin can turn protection on in one save.
UPDATE "projects" SET "previewAccess" = 'public' WHERE "previewEnabled" = true;
