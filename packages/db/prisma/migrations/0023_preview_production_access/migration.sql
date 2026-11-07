-- A same-repo preview of a production base no longer gets production's secrets or network unless the
-- owner says so. Off on every existing project: this takes access away until someone grants it. A
-- boolean has no range for a CHECK to hold.
ALTER TABLE "projects" ADD COLUMN "previewProductionAccess" BOOLEAN NOT NULL DEFAULT false;
