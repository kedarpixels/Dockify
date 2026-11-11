-- A preview belongs to one repository's pull request: PR numbers are per repository, and a project
-- can build from several. Existing rows take their key from the base repository they recorded.
ALTER TABLE "preview_envs" ADD COLUMN "repoKey" TEXT;
UPDATE "preview_envs" SET "repoKey" = 'github.com/' || lower("repo");
ALTER TABLE "preview_envs" ALTER COLUMN "repoKey" SET NOT NULL;

DROP INDEX "preview_envs_projectId_prNumber_key";
CREATE UNIQUE INDEX "preview_envs_projectId_repoKey_prNumber_key" ON "preview_envs"("projectId", "repoKey", "prNumber");

-- Whether a preview deployment builds a fork's commit, fixed when it is queued. A deployment still
-- open takes it from its preview.
ALTER TABLE "deployments" ADD COLUMN "fromFork" BOOLEAN NOT NULL DEFAULT false;
UPDATE "deployments" d SET "fromFork" = true
FROM "preview_deployments" pd JOIN "preview_envs" e ON e."id" = pd."envId"
WHERE d."previewId" = pd."id" AND e."fromFork" AND d."status" IN ('queued', 'building', 'deploying', 'cancelling');
