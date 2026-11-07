-- Changing a managed database's version.
--   service_upgrade    the job that takes the backup, restores into the new service, verifies, and switches.
--   serviceRedirectId  a service's linked variables resolve to this other service instead: the switch, one
--                      update to make and one to undo, with no variable rewritten and no secret resealed.
--   serviceUpgrade     where a version change stands, for the dashboard. Never holds a credential.
--   pinImage           a template's image app records the digest of its first pull and redeploys that,
--                      as a managed service does. Off for an image app someone typed: a redeploy of
--                      theirs still pulls the tag, which is what they expect.

-- AlterEnum
ALTER TYPE "JobKind" ADD VALUE 'service_upgrade';

-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "serviceRedirectId" UUID;
ALTER TABLE "apps" ADD COLUMN     "serviceUpgrade" JSONB;
ALTER TABLE "apps" ADD COLUMN     "pinImage" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_serviceRedirectId_fkey" FOREIGN KEY ("serviceRedirectId") REFERENCES "apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
