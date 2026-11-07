-- The worker deletes orphaned backups: it alone can write the local backups volume.
ALTER TYPE "JobKind" ADD VALUE 'backup_delete';

-- An app with domains from before primary domains were set gets its oldest one, the same rule a
-- first add and a primary's delete follow. Later adds never move it.
UPDATE "apps" a
SET "primaryDomainId" = (SELECT d."id" FROM "domains" d WHERE d."appId" = a."id" ORDER BY d."createdAt" ASC, d."id" ASC LIMIT 1)
WHERE a."primaryDomainId" IS NULL;
