-- The frontend whose favicon a project shows while its icon is automatic, as the owner picked it.
-- Null keeps the automatic pick, the most public frontend. Deleting the app clears the pick.
ALTER TABLE "projects" ADD COLUMN "iconAppId" UUID;

ALTER TABLE "projects" ADD CONSTRAINT "projects_iconAppId_fkey" FOREIGN KEY ("iconAppId") REFERENCES "apps"("id") ON DELETE SET NULL ON UPDATE CASCADE;
